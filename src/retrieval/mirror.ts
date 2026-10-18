import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { Errors } from '../errors.js';
import { listAllSourceFiles } from '../workspace/store.js';

const execFileAsync = promisify(execFile);

/**
 * Per-project source mirrors for Trace.
 *
 * The mirror is a real git repository under the Ranger data directory
 * (outside any git worktree), materialized from the persisted workspace
 * source rows. Each project gets its own directory, so Trace's per-root
 * index namespace (basename + hash of the absolute path) is project-isolated
 * by construction. Committing every sync means untracked workspace content
 * is snapshotted too: the mirror commit captures exactly the current saved
 * source, whatever its upstream tracking status.
 */

/** Fixed machine identity for mirror commits; never the repository author. */
const GIT_IDENTITY = ['-c', 'user.name=ranger-mirror', '-c', 'user.email=ranger-mirror@localhost'];

export interface MirrorSyncResult {
  headCommit: string;
  changed: boolean;
  fileCount: number;
}

function mirrorParent(dataDir: string): string {
  return path.join(dataDir, 'retrieval-mirrors');
}

export function mirrorRootFor(dataDir: string, projectId: string): string {
  // Prefixed UUID ids only (e.g. prj_<uuid>): no separators, no traversal.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId) || projectId.includes('..')) {
    throw Errors.validation('Project id is not a safe directory name', { reason: 'path_escape' });
  }
  return path.join(mirrorParent(dataDir), projectId);
}

async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  try {
    const result = await execFileAsync('git', GIT_IDENTITY.concat(args), { cwd, timeout: timeoutMs });
    return result.stdout;
  } catch (cause) {
    throw Errors.conflict('Mirror git operation failed', {
      reason: 'mirror_git_failed',
      detail: cause instanceof Error ? String(cause.message).slice(0, 300) : String(cause).slice(0, 300),
    });
  }
}

/** One project's retrieval mirror. Owns sync, head lookup and teardown. */
export class ProjectMirror {
  constructor(readonly root: string) {}

  /** Init the mirror repo if needed and materialize the saved source. */
  async sync(db: DatabaseSync, projectId: string): Promise<MirrorSyncResult> {
    const files = listAllSourceFiles(db, projectId);
    if (files.length === 0) {
      throw Errors.validation('No source files are saved for this project', { reason: 'mirror_empty' });
    }
    mkdirSync(this.root, { recursive: true });
    if (!existsSync(path.join(this.root, '.git'))) {
      await git(this.root, ['init', '-b', 'main']);
    }
    // Materialize the exact saved set: write current files, drop removed ones.
    const wanted = new Set(files.map((file) => file.path));
    for (const file of files) {
      const target = path.join(this.root, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    this.pruneExtras(wanted);
    const status = await git(this.root, ['status', '--porcelain']);
    const changed = status.trim().length > 0;
    if (changed) {
      await git(this.root, ['add', '-A']);
      await git(this.root, ['commit', '--no-verify', '-m', 'ranger mirror sync'], 60_000);
    }
    const head = (await git(this.root, ['rev-parse', 'HEAD'])).trim();
    return { headCommit: head, changed, fileCount: files.length };
  }

  headCommit(): string | null {
    if (!existsSync(path.join(this.root, '.git'))) return null;
    try {
      return execFileSync('git', GIT_IDENTITY.concat(['rev-parse', 'HEAD']), { cwd: this.root, timeout: 15_000 })
        .toString()
        .trim();
    } catch {
      return null;
    }
  }

  /** Remove mirror files (and now-empty dirs) that are no longer saved source. */
  private pruneExtras(wanted: Set<string>): void {
    const keepRoot = this.root;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          if (readdirSync(full).length === 0) rmSync(full, { recursive: true });
        } else {
          const rel = path.relative(keepRoot, full);
          if (!wanted.has(rel)) rmSync(full);
        }
      }
    };
    walk(this.root);
  }

  /** Read back one cited 1-based inclusive line range as text (for verbatim checks). */
  readLines(relativePath: string, startLine: number, endLine: number): string | null {
    const target = path.join(this.root, relativePath);
    if (!target.startsWith(this.root + path.sep) || !existsSync(target)) return null;
    const text = readFileSync(target, 'utf8');
    const lines = text.split('\n');
    if (startLine < 1 || endLine < startLine || endLine > lines.length) return null;
    return lines.slice(startLine - 1, endLine).join('\n');
  }

  sha256(relativePath: string): string | null {
    const target = path.join(this.root, relativePath);
    if (!target.startsWith(this.root + path.sep) || !existsSync(target)) return null;
    return createHash('sha256').update(readFileSync(target)).digest('hex');
  }

  remove(): void {
    if (existsSync(this.root)) rmSync(this.root, { recursive: true });
  }
}
