import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { guestWriteCommand, guestWriteReceipt, guestWriteVerified } from '../../src/workspace/guest-write.js';
import { GUEST_TRANSPORT_CAP_BYTES, WORKLOAD_PROJECT, splitFencedCommand } from '../../src/workspace/limits.js';

/**
 * Execute the actual post-drop shell/Python protocol on an isolated local
 * directory, with no VM or network. The privileged fence is deliberately
 * not run here; workspace-write-protocol covers its exact command shape.
 */
const directories: string[] = [];
function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ranger-real-write-'));
  directories.push(root);
  return root;
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function localPayload(file: string, content: Buffer): string {
  const fenced = splitFencedCommand(guestWriteCommand(file, content));
  if (fenced === null) throw new Error('expected workload fence');
  const prefix = `cd -- '${WORKLOAD_PROJECT}' && `;
  if (!fenced.payload.startsWith(prefix)) throw new Error('expected post-drop chdir');
  return fenced.payload.slice(prefix.length);
}

function write(root: string, file: string, content: Buffer, stdin = content.toString('base64')) {
  return spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', localPayload(file, content)], {
    cwd: root,
    input: stdin,
    encoding: 'utf8',
    timeout: 5000,
  });
}

describe('actual guest write process (offline, no privileged launcher)', () => {
  it.each([
    ['empty', Buffer.alloc(0)],
    ['binary', Buffer.from([0, 255, 128, 10, 13, 39])],
    ['unicode', Buffer.from('hello 世界 🌍\n')],
    ['cap', Buffer.alloc(GUEST_TRANSPORT_CAP_BYTES, 0x61)],
  ])('round-trips %s bytes and returns the hash of the reopened file', (_label, content) => {
    const root = fixture();
    const result = write(root, "nested/we'ird name.bin", content);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(guestWriteReceipt(content));
    const saved = path.join(root, "nested/we'ird name.bin");
    expect(readFileSync(saved)).toEqual(content);
    expect(statSync(saved).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(saved))).toEqual(["we'ird name.bin"]);
  });

  it('finishes when the entire payload arrived even if the exec transport never sends EOF', async () => {
    const root = fixture();
    const content = Buffer.from('The transport holds stdin open after sending these bytes.\n');
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', localPayload('open-stdin.txt', content)], { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdin.on('error', () => { /* Child may close its pipe before its parent. */ });
    let timer: NodeJS.Timeout | undefined;
    try {
      const completed = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('write incorrectly waited for stdin EOF'));
        }, 3000);
      });
      child.stdin.write(content.toString('base64'));
      // Deliberately do not call stdin.end(): the former unbounded read()
      // blocked here until the guest command deadline and failed the write.
      expect(await completed).toBe(0);
      expect(stderr).toBe('');
      expect(stdout.trim()).toBe(guestWriteReceipt(content));
      expect(readFileSync(path.join(root, 'open-stdin.txt'))).toEqual(content);
    } finally {
      clearTimeout(timer);
      child.stdin.destroy();
      child.kill('SIGKILL');
    }
  });

  it.each([
    ['truncated', 'aGk=', 'input_length'],
    ['malformed', '!!!!!!!!!!!!!!!!', 'input_encoding'],
    ['wrong bytes', Buffer.from('altered text').toString('base64'), 'input_digest'],
  ])('rejects %s stdin before replacing an existing file', (_label, stdin, marker) => {
    const root = fixture();
    const old = Buffer.from('keep this original');
    writeFileSync(path.join(root, 'existing.txt'), old);
    const result = write(root, 'existing.txt', Buffer.from('trusted text'), stdin);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain(`stage=${marker}`);
    expect(result.stdout).toBe('');
    expect(readFileSync(path.join(root, 'existing.txt'))).toEqual(old);
    expect(readdirSync(root)).toEqual(['existing.txt']);
  });

  it('refuses final and intermediate symlinks without modifying their targets', () => {
    const root = fixture();
    const outside = fixture();
    writeFileSync(path.join(outside, 'target.txt'), 'outside');
    symlinkSync(path.join(outside, 'target.txt'), path.join(root, 'link.txt'));
    symlinkSync(outside, path.join(root, 'directory'));
    expect(write(root, 'link.txt', Buffer.from('replacement')).status).not.toBe(0);
    expect(write(root, 'directory/target.txt', Buffer.from('replacement')).status).not.toBe(0);
    expect(readFileSync(path.join(outside, 'target.txt'), 'utf8')).toBe('outside');
  });

  it('replaces a hard-linked destination atomically without truncating the outside link', () => {
    const root = fixture();
    const outside = path.join(root, 'outside.txt');
    writeFileSync(outside, 'outside');
    mkdirSync(path.join(root, 'project'));
    linkSync(outside, path.join(root, 'project', 'file.txt'));
    const result = write(path.join(root, 'project'), 'file.txt', Buffer.from('replacement'));
    expect(result.status).toBe(0);
    expect(readFileSync(outside, 'utf8')).toBe('outside');
    expect(readFileSync(path.join(root, 'project', 'file.txt'), 'utf8')).toBe('replacement');
  });

  it('preserves existing executable bits while dropping setuid, setgid and sticky bits', () => {
    const root = fixture();
    const file = path.join(root, 'run.sh');
    writeFileSync(file, 'old');
    chmodSync(file, 0o7755);
    const result = write(root, 'run.sh', Buffer.from('#!/bin/sh\necho updated\n'));
    expect(result.status).toBe(0);
    expect(statSync(file).mode & 0o7777).toBe(0o755);
  });

  it('rejects a directory destination and removes no existing files', () => {
    const root = fixture();
    mkdirSync(path.join(root, 'directory'));
    expect(write(root, 'directory', Buffer.from('replacement')).status).not.toBe(0);
    expect(readdirSync(root)).toEqual(['directory']);
  });
});

describe('verified guest write receipt', () => {
  const content = Buffer.from('expected');
  const success = { stdout: `${guestWriteReceipt(content)}\n`, stderr: '', exitCode: 0, timedOut: false, truncated: false };
  it('accepts only a complete matching guest readback', () => {
    expect(guestWriteVerified(success, content)).toBe(true);
    for (const changed of [
      { stdout: '' }, { stdout: 'guest-write-ok\n' },
      { stdout: guestWriteReceipt(Buffer.from('other')) },
      { timedOut: true }, { truncated: true }, { exitCode: 1 },
    ]) expect(guestWriteVerified({ ...success, ...changed }, content)).toBe(false);
  });
});
