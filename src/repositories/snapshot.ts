import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { Errors } from '../errors.js';

/**
 * Local repository snapshot resolution.
 *
 * When a connected repository URL points at a readable local git worktree,
 * Ranger resolves the approved ref to a real commit, records the working-tree
 * dirty flag (including untracked files, which bare `git status`-based flags
 * elsewhere may miss) and computes a deterministic content hash over the
 * tracked + non-ignored file set. Read-only git plumbing only: no config is
 * read or written, no commit is created, nothing is pushed.
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
    return fileURLToPath(url);
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

async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile('git', ['-C', root, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
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
 * checkout); throws validation_failed when the local path is not a readable
 * git worktree or the ref does not resolve.
 */
export async function resolveLocalSnapshot(url: string, ref: string): Promise<LocalSnapshot | null> {
  const root = localRepositoryPath(url);
  if (root === null) return null;
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
