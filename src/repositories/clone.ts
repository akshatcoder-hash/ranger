import { execFile as execFileCb } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Errors, redact } from '../errors.js';
import { hardenedGitEnv } from './snapshot.js';

/**
 * Host-side shallow clone of a remote (https) repository.
 *
 * The clone is only a transport for the already-hardened local commit
 * reader: it is made with `--no-checkout`, so no repository-controlled
 * content (attributes, filters, symlinks, hooks) is ever written into a
 * working tree on this host, and the object database is read through the
 * same `ls-tree`/`cat-file` path as any approved local checkout. Hooks and
 * fsmonitor are disabled, global/system git config and ambient GIT_* are
 * ignored, prompts are off, and only the https protocol may be used (a
 * redirect to any other protocol is refused by git itself).
 */

const execFile = promisify(execFileCb);

export const CLONE_TIMEOUT_MS = 180_000;
const GIT_QUIET_MAX_BUFFER = 1024 * 1024;

export interface CloneInput {
  url: string;
  ref: string;
  /** Directory to create; any previous content is removed first. */
  target: string;
  timeoutMs?: number;
}

export interface CloneResult {
  /** The resolved 40-hex HEAD commit of the shallow clone. */
  commit: string;
  elapsedMs: number;
}

export type RepositoryCloner = (input: CloneInput) => Promise<CloneResult>;

interface CloneOptions {
  /** Protocols git may use; tests add `file` to clone from a local bare repo. */
  allowedProtocols: string;
  /** Test seam: also accept file:// URLs (production never does). */
  allowFileUrls?: boolean;
}

/**
 * Recording-scope policy: only public github.com owner/repository over
 * https. The exact-match pattern rules out other hosts (including literal
 * loopback/private IPs), credentials, ports, query and fragment.
 */
const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;

export function assertClonableUrl(url: string, allowFileUrls = false): void {
  if (allowFileUrls && url.startsWith('file://')) return;
  const match = GITHUB_URL.exec(url);
  const dots = (part: string | undefined): boolean => part === undefined || /^\.+$/.test(part);
  if (match === null || dots(match[1]) || dots(match[2])) {
    cloneFailed('Only public https://github.com/<owner>/<repository> URLs can be cloned');
  }
}

/** git argv for the shallow clone; redirects are never followed. */
export function cloneArgs(input: Pick<CloneInput, 'url' | 'ref' | 'target'>): string[] {
  return [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'http.followRedirects=false',
    'clone',
    '--depth', '1',
    '--single-branch',
    '--no-tags',
    '--no-checkout',
    '--no-recurse-submodules',
    ...(input.ref === 'HEAD' ? [] : ['--branch', input.ref]),
    '--',
    input.url,
    input.target,
  ];
}

function cloneFailed(message: string): never {
  throw Errors.validation(message, { reason: 'clone_failed' });
}

/** Last meaningful stderr line, redacted and bounded; never the full output. */
function describeCloneError(cause: unknown): string {
  const killed = (cause as { killed?: boolean } | null)?.killed === true;
  if (killed) return 'the clone timed out';
  const stderr = String((cause as { stderr?: unknown } | null)?.stderr ?? '');
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('Cloning into'));
  const line = lines.at(-1) ?? 'git exited with an error';
  return redact(line.replace(/^(fatal|error):\s*/i, '')).slice(0, 200);
}

export function createRepositoryCloner(options: CloneOptions): RepositoryCloner {
  return async (input) => {
    assertClonableUrl(input.url, options.allowFileUrls === true);
    const startedAt = Date.now();
    const env = { ...hardenedGitEnv(), GIT_ALLOW_PROTOCOL: options.allowedProtocols };
    const timeout = input.timeoutMs ?? CLONE_TIMEOUT_MS;
    rmSync(input.target, { recursive: true, force: true });
    mkdirSync(path.dirname(input.target), { recursive: true, mode: 0o700 });
    try {
      await execFile(
        'git',
        cloneArgs(input),
        { timeout, maxBuffer: GIT_QUIET_MAX_BUFFER, env },
      );
    } catch (cause) {
      rmSync(input.target, { recursive: true, force: true });
      cloneFailed(`Could not clone the repository: ${describeCloneError(cause)}`);
    }
    let commit: string;
    try {
      const { stdout } = await execFile('git', ['-C', input.target, 'rev-parse', 'HEAD'], {
        timeout: 15_000,
        maxBuffer: GIT_QUIET_MAX_BUFFER,
        env,
      });
      commit = stdout.trim();
    } catch {
      rmSync(input.target, { recursive: true, force: true });
      return cloneFailed('Could not clone the repository: the cloned HEAD did not resolve');
    }
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      rmSync(input.target, { recursive: true, force: true });
      cloneFailed('Could not clone the repository: the cloned HEAD is not a commit id');
    }
    return { commit, elapsedMs: Date.now() - startedAt };
  };
}

/** Production cloner: public github.com over https only. */
export const cloneRepositoryShallow: RepositoryCloner = createRepositoryCloner({ allowedProtocols: 'https' });
