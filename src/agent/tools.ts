import type { WorkspaceService } from '../workspace/service.js';
import type { RetrievalService } from '../retrieval/service.js';
import { Errors } from '../errors.js';

/**
 * Real coding tools for the xAI Responses loop, executed over the Instabox
 * workspace primitives: constrained file inspection/edit, real commands and
 * tests with actual exit codes, app launch and screenshot evidence.
 *
 * Every mutation is serialized per project (one tool at a time). Tool
 * results are the REAL outcomes: actual command exit codes decide success,
 * never model prose. Output handed back to the model is JSON and bounded.
 */

/** Injected, mandatory scope authorization. Absent or denying means no execution. */
export type ToolApprovalChecker = (input: { projectId: string; tool: string; args: Record<string, unknown> }) => Promise<void> | void;

export interface CodingToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Mutating tools are serialized and audit-relevant; read-only ones still run under the checker. */
  mutating: boolean;
  execute(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const SNIPPET_CAP_CHARS = 16_384;
const TOOL_LOG_CAP_CHARS = 8_192;
const FILE_LIST_CAP = 200;

/** Per-project serialization for every tool execution. */
export class CodingToolRunner {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw Errors.validation(`Tool argument ${key} is required`, { tool_argument: key });
  }
  return value;
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw Errors.validation(`Tool argument ${key} must be an array of strings`, { tool_argument: key });
  }
  return value as string[];
}

function optionalPositiveInt(args: Record<string, unknown>, key: string, max: number): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > max) {
    throw Errors.validation(`Tool argument ${key} must be a positive integer up to ${max}`, { tool_argument: key });
  }
  return value;
}

/** Models may provide either executable + args or one complete shell command. */
export function codingCommandArgv(args: Record<string, unknown>): string[] {
  const command = requireString(args, 'command');
  const argv = optionalStringArray(args, 'args') ?? [];
  return argv.length === 0 && /[\s;&|<>]/.test(command) ? ['sh', '-lc', command] : [command, ...argv];
}

function capText(text: string, cap = TOOL_LOG_CAP_CHARS): { text: string; truncated: boolean } {
  return text.length > cap ? { text: text.slice(0, cap), truncated: true } : { text, truncated: false };
}

export interface CodingToolsOptions {
  projectId: string;
  workspace: WorkspaceService;
  /** Run attribution: commands and outcomes record which run executed them. */
  runId?: string;
  /** Real pinned-Trace retrieval when the sibling is configured. */
  retrieval?: RetrievalService | null;
}

/** The concrete tool set bound to one project's workspace. */
/** Exported names the current file has and the new content loses. */
function droppedExports(workspace: WorkspaceService, projectId: string, path: string, content: string): string[] {
  let existing = '';
  try {
    existing = Buffer.from(workspace.readFile(projectId, path).contentBase64, 'base64').toString('utf8');
  } catch {
    return [];
  }
  const names = (text: string): string[] => [...text.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)].map((match) => String(match[1]));
  const kept = new Set(names(content));
  return names(existing).filter((name) => !kept.has(name));
}

export function codingTools(options: CodingToolsOptions): CodingToolDef[] {
  const { projectId, workspace, runId } = options;
  const attribution = runId === undefined ? undefined : { runId };
  const tools: CodingToolDef[] = [
    {
      name: 'search_code',
      description:
        'Search the project code with real pinned Trace retrieval. Results carry file path, 1-based line range, snapshot id, score and citations.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'integer' } },
        required: ['query'],
        additionalProperties: false,
      },
      mutating: false,
      execute: async (args) => {
        const query = requireString(args, 'query');
        const limit = optionalPositiveInt(args, 'limit', 20) ?? 8;
        if (options.retrieval === undefined || options.retrieval === null) {
          // Transient/unconfigured retrieval is a bounded honest state, not a
          // tool failure: a labeled unavailable payload keeps the run alive
          // (inspect/list and real commands decide), never a fake result.
          return { provider: 'unavailable', results: [], reason: 'trace_unconfigured' };
        }
        try {
          const response = await options.retrieval.search(projectId, query, limit);
          return { ...response };
        } catch (cause) {
          const details = (cause as { details?: { reason?: unknown } } | null)?.details;
          const reason = typeof details?.reason === 'string' ? details.reason : null;
          // A missing index or a dead runtime is transient state, not a tool
          // failure; anything else (unexpected) still ends the run honestly.
          if (reason === 'retrieval_not_indexed' || reason === 'retrieval_index_stale' || reason === 'trace_unavailable') {
            return { provider: 'unavailable', results: [], reason };
          }
          throw cause;
        }
      },
    },
    {
      name: 'inspect_file',
      description: 'Read a constrained workspace file (text). Paths are project-relative.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      mutating: false,
      execute: async (args) => {
        const file = workspace.readFile(projectId, requireString(args, 'path'));
        const text = Buffer.from(file.contentBase64, 'base64').toString('utf8');
        const capped = capText(text, SNIPPET_CAP_CHARS);
        return { path: file.path, sizeBytes: file.sizeBytes, content: capped.text, truncated: capped.truncated };
      },
    },
    {
      name: 'list_files',
      description: 'List saved workspace files under an optional prefix.',
      parameters: { type: 'object', properties: { prefix: { type: 'string' } }, additionalProperties: false },
      mutating: false,
      execute: async (args) => {
        const prefix = args['prefix'] === undefined ? '' : requireString(args, 'prefix');
        const files = workspace.listFiles(projectId, prefix).slice(0, FILE_LIST_CAP);
        return { files, truncated: workspace.listFiles(projectId, prefix).length > FILE_LIST_CAP };
      },
    },
    {
      name: 'edit_file',
      description: 'Write a workspace file with full new content (real guest write).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      mutating: true,
      execute: async (args) => {
        const path = requireString(args, 'path');
        const content = requireString(args, 'content');
        // The write is the whole file. Dropping an export breaks every importer
        // and costs several turns to notice, so refuse it outright.
        const dropped = droppedExports(workspace, projectId, path, content);
        if (dropped.length > 0) {
          return { error: `edit_file replaces the whole file, and this version no longer defines ${dropped.join(', ')}. Write the complete file with every existing export kept.`, path, dropped, saved: false };
        }
        const written = await workspace.writeFile(projectId, path, Buffer.from(content, 'utf8'));
        return { path: written.path, sizeBytes: written.sizeBytes, saved: true };
      },
    },
    {
      name: 'run_command',
      description: 'Run a real foreground command. Supply executable + args, or a full shell command with args omitted. Use run_tests for verification checks. The actual exit code is returned.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'integer' } },
        required: ['command'],
        additionalProperties: false,
      },
      mutating: true,
      execute: async (args) => {
        const argv = codingCommandArgv(args);
        const row = await workspace.runCommand(projectId, argv, optionalPositiveInt(args, 'timeoutMs', 300_000) ?? 60_000, false, attribution);
        const logs = capText(row.logs);
        return { commandId: row.id, state: row.state, exitCode: row.exitCode, timedOut: row.timedOut, logs: logs.text, logsTruncated: logs.truncated };
      },
    },
    {
      name: 'run_tests',
      description: 'Run tests or verification checks. Supply executable + args, or a full shell command with args omitted. passed reflects the ACTUAL exit code (0), never a model claim.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'integer' } },
        required: ['command'],
        additionalProperties: false,
      },
      mutating: true,
      execute: async (args) => {
        const argv = codingCommandArgv(args);
        const row = await workspace.runCommand(projectId, argv, optionalPositiveInt(args, 'timeoutMs', 300_000) ?? 120_000, false, {
          ...attribution,
          isTest: true,
        });
        const logs = capText(row.logs);
        return {
          commandId: row.id,
          state: row.state,
          exitCode: row.exitCode,
          timedOut: row.timedOut,
          passed: row.exitCode === 0,
          logs: logs.text,
          logsTruncated: logs.truncated,
        };
      },
    },
    {
      name: 'launch_app',
      description: 'Launch the app as a real background command in the guest workspace.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } },
        required: ['command'],
        additionalProperties: false,
      },
      mutating: true,
      execute: async (args) => {
        const argv = codingCommandArgv(args);
        const row = await workspace.runCommand(projectId, argv, 60_000, true, attribution);
        return { commandId: row.id, state: row.state, pid: row.pid };
      },
    },
    {
      name: 'collect_evidence',
      description: 'Capture a real guest screenshot as a persisted artifact (actual visual evidence).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      mutating: true,
      execute: async () => {
        const shot = await workspace.screenshot(projectId);
        return { artifactId: shot.artifactId, name: 'screenshot.png', sizeBytes: shot.contentBase64.length };
      },
    },
  ];
  return tools;
}

/** Flat function-tool declarations for the Responses API. */
export function functionToolDeclarations(tools: CodingToolDef[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
