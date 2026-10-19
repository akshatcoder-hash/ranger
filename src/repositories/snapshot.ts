import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
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
 * path service. Refusals happen BEFORE any source inspection:
 * - candidates outside the approved roots are refused before any
 *   filesystem probing, all checks run on canonical (realpath) paths;
 * - the `.git` entry must be a real directory: gitfile (`gitdir:`) and
 *   symlinked `.git` metadata are unsupported repository forms and are
 *   refused outright. A real `.git` directory that contains a `commondir`
 *   file is the same unsupported linked-worktree form: Git would read
 *   refs, objects, config and `info/attributes` from the named common
 *   directory, so any such entry is refused before a git command runs.
 *   The effective git dir/worktree are still verified canonically inside
 *   the approved root, so repo-local `core.worktree` or include-driven
 *   redirection is refused before the ref is read;
 * - `.git/info/attributes` (which `--attr-source` cannot suppress) must be
 *   absent, empty and a regular file, or inspection is refused.
 *
 * The git invocations are hardened against repository-controlled config:
 * no fsmonitor helpers, no hooks, no index writes, no global/system config,
 * no ambient GIT_* environment redirection, and attributes are neutralized
 * from every source (`--attr-source=<empty tree>` for the worktree/index,
 * `core.attributesFile=/dev/null` plus `GIT_ATTR_NOSYSTEM=1` for
 * config-selected files), so repository-defined filter/textconv helpers can
 * never execute during inspection. Remote URLs are never inspected on this
 * host; they persist without a snapshot and resolve in the workspace
 * checkout.
 */

const execFile = promisify(execFileCb);

/** Git operations are bounded; fixture and customer repos are small. */
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
/** Deterministic cap on the number of files folded into the content hash. */
export const HASH_FILE_CAP = 20_000;
/** Files above this size contribute their path+size, not their bytes. */
const HASH_FILE_BYTE_CAP = 8 * 1024 * 1024;
/** The well-known empty tree; attribute lookups see no rules from it. */
const GIT_ATTR_SOURCE_EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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
    // The `.git` entry must be a REAL directory (lstat: not a gitfile, not a
    // symlink); gitfile/symlink metadata is refused by the approval guard.
    return statSync(root).isDirectory() && lstatSync(path.join(root, '.git')).isDirectory();
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
 * exist, its canonical realpath must still sit inside an approved root. The
 * `.git` metadata entry must be a real directory: a gitfile (`gitdir:`
 * pointer), a symlinked `.git` (even to a target inside the approved root)
 * or any other indirection is an unsupported repository form, refused before
 * any git command runs. A real directory that contains a `commondir` entry
 * (the linked-worktree common-dir pointer, any form) is refused the same
 * way, before Git can follow it. A vanished `.git` is reported by the
 * worktree probe.
 */
export function requireApprovedSnapshotRoot(candidate: string, approvedRoots: string[]): string {
  const roots = canonicalApprovedRoots(approvedRoots);
  const lexical = path.normalize(candidate);
  // An existing approved root may be spelled through an alias (macOS tmpdir()
  // is /var/..., whose realpath is /private/var/...). The lexical gate accepts
  // either spelling of an approved root so it still runs before any probing of
  // the candidate; the canonical containment check below remains the authority.
  const lexicalRoots = approvedRoots
    .filter((root) => realpathOrNull(root) !== null)
    .map((root) => path.normalize(root))
    .concat(roots);
  if (!lexicalRoots.some((root) => isInsideOrEqual(lexical, root))) notApproved();
  const real = realpathOrNull(lexical);
  if (real === null || !roots.some((root) => isInsideOrEqual(real, root))) notApproved();
  const gitEntry = path.join(real, '.git');
  let gitStat: Stats | undefined;
  try {
    gitStat = lstatSync(gitEntry);
  } catch {
    gitStat = undefined;
  }
  if (gitStat !== undefined && !gitStat.isDirectory()) notApproved();
  // Linked worktrees keep a real .git directory (or gitfile) whose commondir
  // names another repository. Reject the entry itself — file, symlink or
  // anything else — before any git command can read the outside HEAD,
  // config or info/attributes.
  if (gitStat !== undefined && commondirEntryPresent(gitEntry)) notApproved();
  return real;
}

/** True when `.git/commondir` exists in any form. Unreadable entries fail closed. */
function commondirEntryPresent(gitEntry: string): boolean {
  try {
    lstatSync(path.join(gitEntry, 'commondir'));
    return true;
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code === 'ENOENT') return false;
    return true;
  }
}

/**
 * Read-only git invocation, hardened against repository-controlled config:
 * `--no-optional-locks` keeps every command a pure read (the index is never
 * written, so index-write hooks cannot fire); `--attr-source=<empty tree>`
 * replaces worktree/index `.gitattributes` lookups with the empty tree;
 * `core.fsmonitor=false` never starts a repository-configured fsmonitor
 * helper, `core.hooksPath=/dev/null` disables hook lookup, and
 * `core.attributesFile=/dev/null` discards repo-local/global/system
 * attribute files (with `GIT_ATTR_NOSYSTEM=1` for the system file), so
 * repository-defined filter/textconv helpers cannot execute during
 * inspection. Global/system git config is ignored entirely and ambient
 * `GIT_*` environment variables are stripped so callers cannot redirect the
 * repository through `GIT_DIR`/`GIT_WORK_TREE`. Git flags belong BEFORE the
 * subcommand. Repo-local `.git/info/attributes` and gitfile/core.worktree
 * forms are refused by the caller before any command runs.
 */
const GIT_HARDENED_FLAGS = [
  '--no-optional-locks',
  `--attr-source=${GIT_ATTR_SOURCE_EMPTY_TREE}`,
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.attributesFile=/dev/null',
] as const;

function hardenedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_')) continue;
    env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile(
      'git',
      [...GIT_HARDENED_FLAGS, '-C', root, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        env: hardenedGitEnv(),
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

/** Byte-faithful variant of `git()` for blob content (never decoded as text). */
async function gitBytes(root: string, args: string[]): Promise<Buffer> {
  try {
    const { stdout } = await execFile(
      'git',
      [...GIT_HARDENED_FLAGS, '-C', root, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        env: hardenedGitEnv(),
        encoding: 'buffer',
      },
    );
    return stdout;
  } catch {
    throw Errors.validation(`Git operation failed for the local repository: ${describeGitFailure(args)}`, {
      reason: 'git_failed',
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

/**
 * `.git/info/attributes` is one of the attribute sources git consults and it
 * is NOT suppressed by `--attr-source`; it can therefore wire
 * repository-controlled filter/textconv helpers into every inspection
 * command. Nonempty, symlinked or unreadable forms are refused (fail
 * closed); an empty regular file defines no attributes and stays allowed.
 */
function rejectRepositoryAttributes(root: string): void {
  const attributesFile = path.join(root, '.git', 'info', 'attributes');
  let stats: Stats;
  try {
    stats = lstatSync(attributesFile);
  } catch {
    return; // Absent: nothing to refuse.
  }
  let rejected = !stats.isFile(); // Symlink, fifo, directory, ... unsupported.
  if (!rejected) {
    try {
      rejected = readFileSync(attributesFile, 'utf8').trim() !== '';
    } catch {
      rejected = true; // Unreadable: fail closed.
    }
  }
  if (rejected) {
    throw Errors.validation(
      'Local repository defines git attributes through .git/info/attributes, which inspection cannot neutralize',
      { reason: 'attributes_rejected' },
    );
  }
}

/**
 * Verify canonical containment of the effective git dir and worktree BEFORE
 * any source inspection: the backstop for repo-local config redirection
 * (`core.worktree`, include directives). The absolute git dir must stay
 * inside an approved root and the worktree top level must be exactly the
 * approved candidate root.
 */
async function requireContainedRepository(root: string, approvedRoots: string[]): Promise<void> {
  const out = await git(root, ['rev-parse', '--absolute-git-dir', '--show-toplevel']);
  const [gitDir, toplevel] = out.trim().split('\n');
  const realGitDir = realpathOrNull(gitDir ?? '');
  const realToplevel = realpathOrNull(toplevel ?? '');
  const contained =
    realGitDir !== null &&
    approvedRoots.some((approved) => isInsideOrEqual(realGitDir, approved)) &&
    realToplevel === root;
  if (!contained) {
    throw Errors.validation('Local repository metadata redirects inspection outside the approved root', {
      reason: 'repository_redirect',
    });
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
      // lstat, never stat: symlinks are hashed as their own link text (what
      // git actually tracks for a link) so target bytes are never read and
      // an out-of-root link can neither leak nor depend on external content.
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        hasher.update(readlinkSync(absolute));
        hasher.update('\0symlink');
      } else if (stats.isFile()) {
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
 * operator-approved snapshot roots or the `.git` metadata is a gitfile or
 * symlink, attributes_rejected when `.git/info/attributes` is nonempty or
 * symlinked, repository_redirect when the effective git dir/worktree is not
 * contained in the approved roots, and validation_failed when the local
 * path is not a readable git worktree or the ref does not resolve. A
 * `.git/commondir` entry (linked worktree) is `local_path_not_approved`
 * before any git command. Every refusal happens before the ref or working
 * tree is inspected.
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
  rejectRepositoryAttributes(root);
  await requireContainedRepository(root, canonicalApprovedRoots(approvedRoots));
  const commit = (await git(root, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const status = await git(root, ['status', '--porcelain']);
  const contentHash = await hashRepositoryFiles(root);
  return { commit, branch, dirty: status.trim() !== '', contentHash };
}

export interface CommitSourceBounds {
  /** Refuse when the tree holds more than this many entries. */
  maxFiles: number;
  /** Refuse when any blob exceeds this size (never read the bytes first). */
  maxFileBytes: number;
}

export interface CommitSourceFile {
  path: string;
  content: Buffer;
}

/**
 * Read one recorded commit's full tree as bounded source files, using the
 * SAME hardened read-only invocation and containment guards as snapshot
 * resolution. This is the initial-source bridge for an approved-run start:
 * the RECORDED commit is the authority (a later dirty or moved working tree
 * never changes what is read). Every refusal is explicit and happens before
 * any content is materialized:
 * - `local_path_not_approved` / `not_a_git_worktree` / `attributes_rejected`
 *   / `repository_redirect` — the existing approval and containment guards,
 *   re-verified at read time against the CURRENT approved roots;
 * - `git_failed` — the recorded commit no longer resolves or the tree
 *   cannot be read (changed/unreadable checkout);
 * - `submodule_entry_unsupported` — a gitlink; there is no submodule
 *   fetch/materialization on this host or in the workspace;
 * - `symlink_entry_unsupported` — a symlink blob; the guest write protocol
 *   is regular-file-only (nofollow), so a link cannot materialize as itself;
 * - `entry_path_invalid` — a tree path the workspace write path would
 *   refuse (absolute, `..`, NUL);
 * - `file_count_exceeded` / `file_too_large` — the caller's bounds (the
 *   existing file-count and per-file guest transport limits).
 */
export async function readCommitSourceFiles(
  root: string,
  recordedCommit: string,
  approvedRoots: string[],
  bounds: CommitSourceBounds,
): Promise<CommitSourceFile[]> {
  if (!/^[0-9a-f]{40}$/.test(recordedCommit)) {
    throw Errors.validation('The recorded repository commit is not a resolved commit id', {
      reason: 'git_failed',
      step: 'commit_shape',
    });
  }
  // Re-verify the full approval/containment chain at read time (the
  // connection may be stale; the roots are the CURRENT configuration).
  const real = requireApprovedSnapshotRoot(root, approvedRoots);
  if (!isDirectoryWithGit(real)) {
    throw Errors.validation('Repository URL does not point at a readable local git worktree', {
      reason: 'not_a_git_worktree',
    });
  }
  rejectRepositoryAttributes(real);
  await requireContainedRepository(real, canonicalApprovedRoots(approvedRoots));
  await git(real, ['rev-parse', '--verify', `${recordedCommit}^{commit}`]);

  const listing = await git(real, ['ls-tree', '-r', '-z', '-l', recordedCommit]);
  interface TreeEntry {
    mode: string;
    type: string;
    oid: string;
    size: number;
    path: string;
  }
  const entries: TreeEntry[] = [];
  for (const record of listing.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab === -1) {
      throw Errors.validation('The repository tree listing is malformed', { reason: 'git_failed', step: 'ls-tree' });
    }
    const tokens = record.slice(0, tab).trim().split(/\s+/);
    const [mode, type, oid, sizeToken] = tokens;
    const treePath = record.slice(tab + 1);
    if (mode === undefined || type === undefined || oid === undefined || !/^[0-9a-f]{40}$/.test(oid)) {
      throw Errors.validation('The repository tree listing is malformed', { reason: 'git_failed', step: 'ls-tree' });
    }
    if (type === 'commit') {
      throw Errors.validation(
        'The recorded commit contains a submodule (gitlink) entry, which cannot materialize in the workspace',
        { reason: 'submodule_entry_unsupported', path: treePath },
      );
    }
    if (type !== 'blob' || mode === '120000') {
      throw Errors.validation(
        'The recorded commit contains a symlink entry, which cannot materialize as a workspace file',
        { reason: 'symlink_entry_unsupported', path: treePath },
      );
    }
    if (treePath.length === 0 || treePath.startsWith('/') || treePath.includes('\0') || treePath.split('/').includes('..')) {
      throw Errors.validation('The recorded commit contains a path the workspace cannot hold', {
        reason: 'entry_path_invalid',
        path: treePath,
      });
    }
    const size = Number.parseInt(sizeToken ?? '', 10);
    if (!Number.isInteger(size) || size < 0) {
      throw Errors.validation('The repository tree entry metadata is unreadable', {
        reason: 'git_failed',
        step: 'ls-tree',
      });
    }
    entries.push({ mode, type, oid, size, path: treePath });
  }
  if (entries.length > bounds.maxFiles) {
    throw Errors.validation(`The recorded commit holds more than ${bounds.maxFiles} files`, {
      reason: 'file_count_exceeded',
      files: entries.length,
    });
  }
  const files: CommitSourceFile[] = [];
  for (const entry of entries) {
    if (entry.size > bounds.maxFileBytes) {
      throw Errors.validation(`Recorded file ${entry.path} exceeds the ${bounds.maxFileBytes}-byte source bound`, {
        reason: 'file_too_large',
        path: entry.path,
      });
    }
    files.push({ path: entry.path, content: await gitBytes(real, ['cat-file', 'blob', entry.oid]) });
  }
  return files;
}
