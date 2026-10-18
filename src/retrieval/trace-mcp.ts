import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Errors } from '../errors.js';
import { TRACE_CLI_RELATIVE } from './trace-pin.js';

/**
 * Minimal MCP stdio client for the REAL pinned Trace server.
 *
 * Speaks newline-delimited JSON-RPC 2.0 per the MCP stdio transport:
 * initialize handshake, notifications/initialized, then request/response
 * pairs. One client owns one child process; after a reindex the caller must
 * close it and spawn a fresh one, because a long-lived runtime keeps stale
 * revision/vector references from its opening snapshot.
 */

const MCP_PROTOCOL_VERSION = '2024-11-05';
const CALL_TIMEOUT_MS = 120_000;
const GRACEFUL_EXIT_MS = 5_000;

/** The six real Trace MCP tools; a server without all six is not accepted. */
export const TRACE_MCP_TOOLS = [
  'search_code',
  'read_symbol',
  'find_references',
  'related_code',
  'repo_status',
  'verify_citation',
] as const;

export type TraceMcpTool = (typeof TRACE_MCP_TOOLS)[number];

export interface McpToolResult {
  /** Parsed structured payload (Trace returns JSON text plus structuredContent). */
  data: Record<string, unknown>;
  isError: boolean;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (cause: Error) => void;
  timer: NodeJS.Timeout;
}

export interface TraceMcpSpawnOptions {
  traceRoot: string;
  mirrorRoot: string;
  traceHome: string;
}

export class TraceMcpClient {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, PendingRequest>();
  private buffer = '';
  private stderrTail = '';
  private closed = false;
  private exitWaiter: Promise<void>;

  private constructor(child: ChildProcessWithoutNullStreams, exitWaiter: Promise<void>) {
    this.child = child;
    this.exitWaiter = exitWaiter;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    child.on('error', () => this.rejectAll(new Error('Trace MCP process failed to start')));
    this.exitWaiter.then(() => this.rejectAll(new Error('Trace MCP process exited')));
  }

  static spawn(options: TraceMcpSpawnOptions): TraceMcpClient {
    const cliPath = `${options.traceRoot}/${TRACE_CLI_RELATIVE}`;
    const child = spawn(process.execPath, [cliPath, 'serve-mcp', options.mirrorRoot], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TRACE_HOME: options.traceHome },
    }) as ChildProcessWithoutNullStreams;
    const exitWaiter = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });
    return new TraceMcpClient(child, exitWaiter);
  }

  /** Handshake and verify the real six-tool surface. */
  async initialize(): Promise<void> {
    const response = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ranger-retrieval', version: '0.1.0' },
    });
    void response;
    this.notify('notifications/initialized', {});
    const listed = await this.listTools();
    const names = new Set(listed.map((tool) => tool.name as string));
    const missing = TRACE_MCP_TOOLS.filter((tool) => !names.has(tool));
    if (missing.length > 0) {
      throw Errors.notConfigured('Trace MCP server does not serve the required tools', {
        reason: 'trace_mcp_tools_missing',
        missing,
      });
    }
  }

  async listTools(): Promise<Array<Record<string, unknown>>> {
    const response = await this.request('tools/list', {});
    const tools = response['tools'];
    return Array.isArray(tools) ? (tools as Array<Record<string, unknown>>) : [];
  }

  async callTool(tool: TraceMcpTool, args: Record<string, unknown>): Promise<McpToolResult> {
    const response = await this.request('tools/call', { name: tool, arguments: args });
    const isError = response['isError'] === true;
    const structured = response['structuredContent'];
    if (structured !== undefined && structured !== null && typeof structured === 'object') {
      return { data: structured as Record<string, unknown>, isError };
    }
    const content = response['content'];
    const text = Array.isArray(content)
      ? content
          .map((block) => (block && typeof block === 'object' && 'text' in block ? String((block as Record<string, unknown>)['text']) : ''))
          .join('')
      : '';
    try {
      return { data: JSON.parse(text) as Record<string, unknown>, isError };
    } catch {
      throw Errors.internal('Trace MCP tool returned unparseable content', { tool, detail: text.slice(0, 200) });
    }
  }

  /** Bounded redacted stderr tail for explicit failure envelopes. */
  diagnostics(): string {
    return this.stderrTail.length > 0 ? this.stderrTail.slice(-300) : '';
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.exitWaiter;
      return;
    }
    this.closed = true;
    this.rejectAll(new Error('Trace MCP client closed'));
    this.child.stdin.end();
    const exited = new Promise<void>((resolve) => {
      const poll = this.exitWaiter.then(() => resolve());
      void poll;
    });
    const race = await Promise.race([
      exited.then(() => 'exited' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), GRACEFUL_EXIT_MS)),
    ]);
    if (race === 'timeout') {
      this.child.kill('SIGKILL');
      await this.exitWaiter;
    }
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('Trace MCP client is closed'));
    const id = randomUUID();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Errors.conflict('Trace MCP call timed out', { reason: 'trace_mcp_timeout', method }));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = message['id'];
      if (id === undefined || id === null) continue; // notification
      const pending = this.pending.get(String(id));
      if (pending === undefined) continue;
      this.pending.delete(String(id));
      clearTimeout(pending.timer);
      if (message['error'] !== undefined && message['error'] !== null) {
        const err = message['error'] as Record<string, unknown>;
        pending.reject(Errors.conflict('Trace MCP request failed', {
          reason: 'trace_mcp_error',
          code: String(err['code'] ?? 'unknown'),
          detail: String(err['message'] ?? '').slice(0, 200),
        }));
      } else {
        pending.resolve((message['result'] ?? {}) as Record<string, unknown>);
      }
    }
  }

  private rejectAll(cause: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(cause);
    }
    this.pending.clear();
  }
}
