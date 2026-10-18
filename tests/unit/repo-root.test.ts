import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { credentialPathInsideRepo, resolveRepoRoot } from '../../src/identity/repo-root.js';

describe('repository root resolution', () => {
  it('walks from a dist/scripts context to the directory that owns package.json', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ranger-root-'));
    writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
    const builtScripts = path.join(root, 'dist', 'scripts');
    mkdirSync(builtScripts, { recursive: true });
    const sourceScripts = path.join(root, 'scripts');
    mkdirSync(sourceScripts, { recursive: true });

    expect(resolveRepoRoot(builtScripts)).toBe(root);
    expect(resolveRepoRoot(sourceScripts)).toBe(root);
    expect(resolveRepoRoot(path.join(root, 'dist', 'src', 'identity'))).toBe(root);
  });

  it('rejects lexical and canonical destinations inside the repo, including an external symlink', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ranger-contain-'));
    writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    const outside = mkdtempSync(path.join(tmpdir(), 'ranger-outside-'));
    const alias = path.join(outside, 'into-repo');
    symlinkSync(path.join(root, 'docs'), alias);

    expect(credentialPathInsideRepo(path.join(root, 'docs', 'cred.txt'), root)).toBe(true);
    expect(credentialPathInsideRepo(path.join(root, 'dist', 'cred.txt'), root)).toBe(true);
    expect(credentialPathInsideRepo(path.join(root, 'cred.txt'), root)).toBe(true);
    expect(credentialPathInsideRepo(path.join(alias, 'cred.txt'), root)).toBe(true);
    expect(credentialPathInsideRepo(path.join(outside, 'cred.txt'), root)).toBe(false);
    // A missing parent still fails the lexical check before any write.
    expect(credentialPathInsideRepo(path.join(root, 'docs', 'missing', 'cred.txt'), root)).toBe(true);
    expect(credentialPathInsideRepo(path.join(outside, 'missing', 'cred.txt'), root)).toBe(false);
  });
});
