import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Errors } from '../errors.js';
import { TRACE_CLI_RELATIVE } from './trace-pin.js';

const execFileAsync = promisify(execFile);

/**
 * Real Trace indexing over the real CLI, and the one-indexing-job-at-a-time
 * discipline.
 *
 * Indexing runs `trace index <mirrorRoot> --no-model-download`: the explicit
 * cached Jina model is the only embedding source and nothing is ever fetched
 * at index time. Index and MCP-restart work is serialized through one module
 * promise chain, so at most one indexing job runs in this process.
 */

const INDEX_TIMEOUT_MS = 5 * 60_000;
/** Conservative default budget estimate floor so reservations never guess down. */
const MAX_INDEX_STDIO_BYTES = 2 * 1024 * 1024;

export interface TraceIndexStats {
  snapshotId: string;
  commit: string | null;
  branch: string | null;
  dirty: boolean;
  indexedAt: string;
  embeddingModel: string;
  embeddedChunks: number;
  filesIndexed: number;
}

let queue: Promise<unknown> = Promise.resolve();

/** Serialize index/restart work: at most one indexing job at a time. */
export function runIndexedExclusively<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

function maxBuffer(): { maxBuffer: number } {
  return { maxBuffer: MAX_INDEX_STDIO_BYTES };
}

export interface IndexMirrorOptions {
  traceRoot: string;
  mirrorRoot: string;
  traceHome: string;
}

/**
 * Index one mirror with the real cached embedding model. Returns the new
 * snapshot revision extracted from the CLI's JSON stats output.
 */
export async function indexMirror(options: IndexMirrorOptions): Promise<TraceIndexStats> {
  const cliPath = `${options.traceRoot}/${TRACE_CLI_RELATIVE}`;
  try {
    const result = await execFileAsync(
      process.execPath,
      [cliPath, 'index', options.mirrorRoot, '--no-model-download'],
      {
        timeout: INDEX_TIMEOUT_MS,
        env: { ...process.env, TRACE_HOME: options.traceHome },
        ...maxBuffer(),
      },
    );
    return parseIndexStats(result.stdout);
  } catch (cause) {
    const err = cause as { stdout?: string; stderr?: string; message?: string };
    throw Errors.conflict('Trace indexing failed', {
      reason: 'trace_index_failed',
      detail: String(err.stderr ?? err.message ?? '').slice(0, 300),
    });
  }
}

function parseIndexStats(stdout: string): TraceIndexStats {
  // The CLI prints exactly one JSON object to stdout (progress goes to stderr).
  const start = stdout.lastIndexOf('\n{');
  const line = start === -1 ? stdout : stdout.slice(start + 1);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw Errors.internal('Trace index output was not parseable JSON', { detail: stdout.slice(-200) });
  }
  const revision = parsed['revision'] as Record<string, unknown> | undefined;
  const coverage = parsed['coverage'] as Record<string, unknown> | undefined;
  if (revision === undefined || coverage === undefined || typeof revision['snapshotId'] !== 'string') {
    throw Errors.internal('Trace index stats are missing the revision snapshot', { detail: stdout.slice(-200) });
  }
  return {
    snapshotId: revision['snapshotId'] as string,
    commit: (revision['commit'] as string | null) ?? null,
    branch: (revision['branch'] as string | null) ?? null,
    dirty: revision['dirty'] === true,
    indexedAt: String(revision['indexedAt'] ?? ''),
    embeddingModel: String(coverage['embeddingModel'] ?? ''),
    embeddedChunks: Number(coverage['embeddedChunks'] ?? 0),
    filesIndexed: Number(coverage['filesIndexed'] ?? 0),
  };
}
