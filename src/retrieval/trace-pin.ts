import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Errors } from '../errors.js';

const execFileAsync = promisify(execFile);

/** Built Trace CLI entry (never vendored into Ranger: the sibling stays the pin target). */
export const TRACE_CLI_RELATIVE = path.join('packages', 'cli', 'dist', 'bin.js');
/** Embedding model pinned by Trace's `jina-code` preset (documented, not weights). */
export const TRACE_EMBEDDING_MODEL = 'jinaai/jina-embeddings-v2-base-code';
/** Languages Trace actually indexes (its SourceLanguage union). */
export const TRACE_SUPPORTED_LANGUAGES = ['typescript', 'tsx', 'javascript', 'jsx', 'json'] as const;
/** File extensions Ranger maps onto those languages; everything else is fallback territory. */
export const TRACE_SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json']);

export interface TracePinOptions {
  traceRoot: string;
  pinnedCommit: string;
}

function gitError(cause: unknown, traceRoot: string, detail: string): never {
  throw Errors.notConfigured(`Trace is not usable: ${detail}`, {
    reason: 'trace_unavailable',
    traceRoot,
    cause: cause instanceof Error ? cause.message.slice(0, 200) : String(cause).slice(0, 200),
  });
}

async function gitHead(traceRoot: string): Promise<string> {
  try {
    const result = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: traceRoot, timeout: 15_000 });
    return result.stdout.trim();
  } catch (cause) {
    gitError(cause, traceRoot, 'git rev-parse failed; the sibling checkout is missing or broken');
  }
}

/**
 * Verify the pinned real Trace sibling: exact commit and a built CLI.
 *
 * Ranger never vendors Trace source or git history; the sibling checkout is
 * the single source. A mismatch or missing build is an explicit
 * trace_unavailable failure, never a substitute engine.
 */
export async function verifyTracePin(options: TracePinOptions): Promise<{ commit: string; cliPath: string }> {
  const cliPath = path.join(options.traceRoot, TRACE_CLI_RELATIVE);
  if (!existsSync(path.join(options.traceRoot, '.git'))) {
    throw Errors.notConfigured('Trace sibling repository is not bootstrapped', {
      reason: 'trace_unavailable',
      traceRoot: options.traceRoot,
    });
  }
  const commit = await gitHead(options.traceRoot);
  if (commit !== options.pinnedCommit) {
    throw Errors.notConfigured('Trace sibling is not at the pinned commit', {
      reason: 'trace_pin_mismatch',
      expected: options.pinnedCommit,
      observed: commit,
    });
  }
  if (!existsSync(cliPath)) {
    throw Errors.notConfigured('Trace CLI is not built (packages/cli/dist/bin.js missing)', {
      reason: 'trace_unbuilt',
      traceRoot: options.traceRoot,
    });
  }
  return { commit, cliPath };
}

export interface BootstrapTraceResult {
  commit: string;
  cliPath: string;
  embeddingModel: string;
  modelCacheDir: string;
  modelCachePresent: boolean;
  checkedOut: boolean;
  installed: boolean;
  built: boolean;
}

async function gitIn(traceRoot: string, ...args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', args, { cwd: traceRoot, timeout: 120_000 });
    return result.stdout.trim();
  } catch (cause) {
    gitError(cause, traceRoot, `git ${args[0]} failed`);
  }
}

async function pnpm(traceRoot: string, args: string[]): Promise<void> {
  await execFileAsync('pnpm', args, { cwd: traceRoot, timeout: 600_000 });
}

/**
 * Bootstrap the pinned real Trace sibling: put the checkout exactly on the
 * pinned commit (fetch + checkout only when needed and only on a clean
 * worktree), install with the frozen lockfile when needed, build the CLI
 * when needed, and report the model cache. Ranger never vendors Trace's
 * git history: the sibling stays the only Trace checkout.
 */
export async function ensureTracePinned(options: TracePinOptions & { traceHome: string }): Promise<BootstrapTraceResult> {
  if (!existsSync(path.join(options.traceRoot, '.git'))) {
    throw Errors.notConfigured('Trace sibling repository is not bootstrapped; clone it first', {
      reason: 'trace_sibling_missing',
      traceRoot: options.traceRoot,
    });
  }
  let checkedOut = false;
  const currentHead = await gitIn(options.traceRoot, 'rev-parse', 'HEAD');
  if (currentHead !== options.pinnedCommit) {
    const dirty = (await gitIn(options.traceRoot, 'status', '--porcelain')).length > 0;
    if (dirty) {
      throw Errors.notConfigured('Trace sibling has uncommitted changes; refusing to move the pin', {
        reason: 'trace_worktree_dirty',
      });
    }
    await gitIn(options.traceRoot, 'fetch', '--all', '--prune');
    await gitIn(options.traceRoot, 'checkout', options.pinnedCommit);
    checkedOut = true;
  }
  const cliPath = path.join(options.traceRoot, TRACE_CLI_RELATIVE);
  const nodeModules = path.join(options.traceRoot, 'node_modules');
  let installed = false;
  let built = false;
  if (!existsSync(nodeModules)) {
    await pnpm(options.traceRoot, ['install', '--frozen-lockfile']);
    installed = true;
  }
  if (!existsSync(cliPath)) {
    await pnpm(options.traceRoot, ['build']);
    built = true;
  }
  const pin = await verifyTracePin(options);
  const modelCacheDir = path.join(options.traceHome, 'models');
  const modelCachePresent = existsSync(modelCacheDir) && readdirSync(modelCacheDir).length > 0;
  return {
    commit: pin.commit,
    cliPath: pin.cliPath,
    embeddingModel: TRACE_EMBEDDING_MODEL,
    modelCacheDir,
    modelCachePresent,
    checkedOut,
    installed,
    built,
  };
}
