import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readCommitSourceFiles } from '../../src/repositories/snapshot.js';

/**
 * The initial-source bridge reads the RECORDED commit out of an approved-root
 * local checkout with the EXISTING hardened read-only git helpers. These
 * tests pin the structural constraints: recorded-commit fidelity (never the
 * moving working tree), explicit refusal of symlink/submodule entries, and
 * the caller-supplied count/size bounds — every refusal happens before any
 * guest or provider work.
 */

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface MiniRepo {
  root: string;
  fileUrl: string;
  commit: string;
  trackedFile: string;
}

/** Minimal fixture repo (same conventions as helpers/fixture-repo.ts). */
function createRepo(baseDir: string, name = 'fixture-app'): MiniRepo {
  const root = path.join(baseDir, name);
  const git = (args: string[]): Buffer =>
    execFileSync('git', ['-C', root, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  execFileSync('git', ['init', '--initial-branch=main', root], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  const trackedFile = path.join(root, 'index.ts');
  writeFileSync(trackedFile, 'export const version = 1;\n');
  git(['add', 'index.ts']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture initial']);
  const commit = git(['rev-parse', 'HEAD']).toString().trim();
  return { root, fileUrl: `file://${root}`, commit, trackedFile };
}

const BOUNDS = { maxFiles: 20_000, maxFileBytes: 786_432 };

describe('readCommitSourceFiles (hardened recorded-commit source read)', () => {
  it('reads the tracked tree at the recorded commit with exact bytes', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ranger-commit-src-'));
    tempDirs.push(baseDir);
    const repo = createRepo(baseDir);
    const files = await readCommitSourceFiles(repo.root, repo.commit, [baseDir], BOUNDS);
    expect(files).toEqual([{ path: 'index.ts', content: Buffer.from('export const version = 1;\n') }]);
  });

  it('materializes the recorded commit, never a later dirty working tree', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ranger-commit-src-'));
    tempDirs.push(baseDir);
    const repo = createRepo(baseDir);
    // The checkout changed after connect: the recorded commit stays the
    // authority for the initial base.
    writeFileSync(repo.trackedFile, 'DIRTY UNCOMMITTED EDIT\n');
    const files = await readCommitSourceFiles(repo.root, repo.commit, [baseDir], BOUNDS);
    expect(files).toEqual([{ path: 'index.ts', content: Buffer.from('export const version = 1;\n') }]);
  });

  it('refuses submodule (gitlink) entries before anything is materialized', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ranger-commit-src-'));
    tempDirs.push(baseDir);
    const repo = createRepo(baseDir);
    const git = (args: string[]): Buffer =>
      execFileSync('git', ['-C', repo.root, ...args], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
    git(['update-index', '--add', '--cacheinfo', '160000,0123456789abcdef0123456789abcdef01234567,vendor/lib']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'add gitlink']);
    const gitlinkCommit = git(['rev-parse', 'HEAD']).toString().trim();
    await expect(readCommitSourceFiles(repo.root, gitlinkCommit, [baseDir], BOUNDS)).rejects.toMatchObject({
      code: 'validation_failed',
      details: { reason: 'submodule_entry_unsupported' },
    });
  });

  it('refuses symlink entries before anything is materialized', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ranger-commit-src-'));
    tempDirs.push(baseDir);
    const repo = createRepo(baseDir);
    const git = (args: string[]): Buffer =>
      execFileSync('git', ['-C', repo.root, ...args], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
    symlinkSync('index.ts', path.join(repo.root, 'link.ts'));
    git(['add', 'link.ts']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'add link']);
    const linkCommit = git(['rev-parse', 'HEAD']).toString().trim();
    await expect(readCommitSourceFiles(repo.root, linkCommit, [baseDir], BOUNDS)).rejects.toMatchObject({
      code: 'validation_failed',
      details: { reason: 'symlink_entry_unsupported' },
    });
  });

  it('refuses when the file count exceeds the bound', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ranger-commit-src-'));
    tempDirs.push(baseDir);
    const repo = createRepo(baseDir);
    await expect(readCommitSourceFiles(repo.root, repo.commit, [baseDir], { maxFiles: 0, maxFileBytes: BOUNDS.maxFileBytes })).rejects.toMatchObject({
      code: 'validation_failed',
      details: { reason: 'file_count_exceeded' },
    });
  });

  it('refuses when a file exceeds the transport byte bound (before reading it)', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ranger-commit-src-'));
    tempDirs.push(baseDir);
    const repo = createRepo(baseDir);
    await expect(readCommitSourceFiles(repo.root, repo.commit, [baseDir], { maxFiles: BOUNDS.maxFiles, maxFileBytes: 8 })).rejects.toMatchObject({
      code: 'validation_failed',
      details: { reason: 'file_too_large' },
    });
  });

  it('fails explicitly when the recorded commit no longer resolves', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ranger-commit-src-'));
    tempDirs.push(baseDir);
    const repo = createRepo(baseDir);
    const gone = '1234567890abcdef1234567890abcdef12345678';
    await expect(readCommitSourceFiles(repo.root, gone, [baseDir], BOUNDS)).rejects.toMatchObject({
      code: 'validation_failed',
      details: { reason: 'git_failed' },
    });
  });

  it('fails the approved-root guard when the checkout is gone or outside the roots', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ranger-commit-src-'));
    tempDirs.push(baseDir);
    const repo = createRepo(baseDir);
    const vanished = mkdtempSync(path.join(tmpdir(), 'ranger-commit-src-gone-'));
    tempDirs.push(vanished);
    const goneRoot = path.join(vanished, 'repo');
    rmSync(repo.root, { recursive: true, force: true });
    await expect(readCommitSourceFiles(goneRoot, repo.commit, [baseDir], BOUNDS)).rejects.toMatchObject({
      code: 'validation_failed',
      details: { reason: 'local_path_not_approved' },
    });
    await expect(readCommitSourceFiles(repo.root, repo.commit, [], BOUNDS)).rejects.toMatchObject({
      code: 'validation_failed',
      details: { reason: 'local_path_not_approved' },
    });
  });
});
