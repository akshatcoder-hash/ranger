import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { Errors } from '../errors.js';

/**
 * Local repository snapshot resolution.
 *
 * When a connected repository URL points at a readable local git worktree
 * under an OPERATOR-APPROVED snapshot root, Ranger resolves the approved ref
 * to a real commit, records the working-tree dirty flag (including
 * untracked files, which bare `git status`-based flags elsewhere may miss)
 * and computes a deterministic content hash over the tracked + non-ignored
 * file set.
 *
 * Local inspection is a synthetic-fixture capability, never a general host
 * path service: candidates outside the approved roots are refused before any
 * filesystem probing, all checks run on canonical (realpath) paths so
 * symlink components cannot escape the approval, and the git invocations are
 * hardened against repository-controlled config (no fsmonitor helpers, no
 * hooks, no index writes, no global/system config). Remote URLs are never
 * inspected on this host; they persist without a snapshot and resolve in
 * the workspace checkout.
 */

const execFile = promisify(execFileCb);

/** Git operations are bounded; fixture and customer repos are small. */
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
/** Deterministic cap on the number of files folded into the content hash. */
const HASH_FILE_CAP = 20_000;
/** Files above this size contribute their path+size, not their bytes. */
const HASH_FILE_BYTE_CAP = 8 * 1024 * 1024;

export interface LocalSnapshot {
  commit: string;
  branch: string;
  dirty: boolean;
  contentHash: string;
}

/** Map a repository URL to a local filesystem path, or null when remote. */
export function localRepositoryPath(url: string): string | null {
  if (url.startsWith('file://')) {
    try {
      return fileURLToPath(url);
    } catch {
      throw Errors.validation('Repository URL is not a valid file URL', { reason: 'invalid_url' });
    }
  }
  if (url.startsWith('/')) {
    return path.normalize(url);
  }
  return null;
}

function isDirectoryWithGit(root: string): boolean {
  try {
    return statSync(root).isDirectory() && existsSync(path.join(root, '.git'));
  } catch {
    return false;
  }
}

function realpathOrNull(candidate: string): string | null {
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

/** True when `child` is `root` itself or lives underneath it. */
function isInsideOrEqual(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function notApproved(): never {
  throw Errors.validation(
    'Local repository inspection is restricted to operator-approved snapshot roots',
    { reason: 'local_path_not_approved' },
  );
}

/** Canonicalize the approved roots; entries that do not exist approve nothing. */
function canonicalApprovedRoots(approvedRoots: string[]): string[] {
  return approvedRoots
    .map((root) => realpathOrNull(root))
    .filter((root): root is string => root !== null);
}

/**
 * Guard local inspection: the candidate must live under an operator-approved
 * root. The lexical check runs BEFORE any probing of the candidate (no
 * existence oracle for arbitrary host paths); once the candidate is known to
 * exist, its canonical realpath must still sit inside an approved root and a
 * symlinked `.git` may not escape either. Returns the canonical root to
 * inspect.
 */
export function requireApprovedSnapshotRoot(candidate: string, approvedRoots: string[]): string {
  const roots = canonicalApprovedRoots(approvedRoots);
  const lexical = path.normalize(candidate);
  if (!roots.some((root) => isInsideOrEqual(lexical, root))) notApproved();
  const real = realpathOrNull(lexical);
  if (real === null || !roots.some((root) => isInsideOrEqual(real, root))) notApproved();
  // A symlinked `.git` may not point outside the approved root either. Only
  // the lstat is guarded (a vanished .git is reported by the worktree probe
  // below) — the denial itself must never be swallowed here.
  const gitEntry = path.join(real, '.git');
  let gitStat: Stats | undefined;
  try {
    gitStat = lstatSync(gitEntry);
  } catch {
    gitStat = undefined;
  }
  if (gitStat?.isSymbolicLink()) {
    const gitReal = realpathOrNull(gitEntry);
    if (gitReal === null || !roots.some((root) => isInsideOrEqual(gitReal, root))) notApproved();
  }
  return real;
}

/**
 * Read-only git invocation, hardened against repository-controlled config:
 * `--no-optional-locks` keeps every command a pure read (the index is never
 * written, so index-write hooks cannot fire), `core.fsmonitor=false` never
 * starts a repository-configured fsmonitor helper, `core.hooksPath=/dev/null`
 * disables hook lookup, and global/system git config is ignored entirely so
 * only these overrides plus repo-local config apply.
 */
async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile(
      'git',
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
        },
      },
    );
    return stdout;
  } catch {
    throw Errors.validation(`Git operation failed for the local repository: ${describeGitFailure(args)}`, {
      reason: 'git_failed',
      // Bounded, value-free failure detail (never includes command output).
      step: args[0] ?? 'unknown',
    });
  }
}

function describeGitFailure(args: string[]): string {
  switch (args[0]) {
    case 'rev-parse':
      return 'the ref does not resolve in this repository';
    case 'status':
    case 'ls-files':
      return 'the repository state could not be read';
    default:
      return 'unexpected git failure';
  }
}

/** Deterministic content hash over the tracked + non-ignored file set. */
export async function hashRepositoryFiles(root: string): Promise<string> {
  const listing = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const files = listing
    .split('\0')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .sort();
  if (files.length > HASH_FILE_CAP) {
    files.length = HASH_FILE_CAP; // deterministic truncation; documented behavior
  }
  const hasher = createHash('sha256');
  for (const relative of files) {
    hasher.update(relative);
    hasher.update('\0');
    const absolute = path.join(root, relative);
    try {
      const stats = statSync(absolute);
      if (stats.isFile()) {
        if (stats.size <= HASH_FILE_BYTE_CAP) {
          hasher.update(readFileSync(absolute));
          hasher.update(`\0file:${stats.size}`);
        } else {
          hasher.update(`\0oversize:${stats.size}`);
        }
      } else {
        hasher.update('\0nonfile');
      }
    } catch {
      hasher.update('\0unreadable');
    }
    hasher.update('\n');
  }
  return hasher.digest('hex');
}

/**
 * Resolve the local snapshot for a repository URL + ref. Returns null when
 * the URL is remote (commit resolution is deferred to the workspace
 * checkout); throws local_path_not_approved when the path is outside the
 * operator-approved snapshot roots, and validation_failed when the local
 * path is not a readable git worktree or the ref does not resolve.
 */
export async function resolveLocalSnapshot(
  url: string,
  ref: string,
  approvedRoots: string[],
): Promise<LocalSnapshot | null> {
  const candidate = localRepositoryPath(url);
  if (candidate === null) return null;
  const root = requireApprovedSnapshotRoot(candidate, approvedRoots);
  if (!isDirectoryWithGit(root)) {
    throw Errors.validation('Repository URL does not point at a readable local git worktree', {
      reason: 'not_a_git_worktree',
    });
  }
  const commit = (await git(root, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const status = await git(root, ['status', '--porcelain']);
  const contentHash = await hashRepositoryFiles(root);
  return { commit, branch, dirty: status.trim() !== '', contentHash };
}
