import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Real entrypoint process checks: the API, worker and preview entrypoints
 * start from a fresh data directory, bind their loopback ports (3900-3999
 * range), answer health checks and exit cleanly on SIGTERM.
 */

const started: Array<{ proc: ChildProcess; label: string }> = [];

function spawnEntrypoint(entry: 'api' | 'worker' | 'preview', env: Record<string, string>): ChildProcess {
  const proc = spawn('node', [`dist/src/entrypoints/${entry}.js`], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, RANGER_LOG_LEVEL: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push({ proc, label: entry });
  return proc;
}

async function waitForHealth(url: string, proc: ChildProcess, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`${url} process exited before becoming healthy (code ${proc.exitCode})`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = `status ${res.status}`;
    } catch (cause) {
      lastError = String(cause);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`health check at ${url} timed out: ${lastError}`);
}

async function terminate(proc: ChildProcess): Promise<number> {
  if (proc.exitCode !== null) return proc.exitCode;
  proc.kill('SIGTERM');
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve(null);
    }, 8000);
    proc.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  return code ?? -1;
}

function waitForStdoutLine(proc: ChildProcess, needle: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stdout line "${needle}" not seen in time`)), timeoutMs);
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString();
      if (text.includes(needle)) {
        clearTimeout(timer);
        proc.stdout?.off('data', onData);
        resolve(text);
      }
    };
    proc.stdout?.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`process exited (${code}) before "${needle}" appeared`));
    });
  });
}

afterAll(async () => {
  for (const { proc } of started) {
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
});

describe('entrypoints', () => {
  it('api: fresh data dir, migrations, health, clean SIGTERM', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-entry-api-'));
    const proc = spawnEntrypoint('api', {
      RANGER_DATA_DIR: dataDir,
      RANGER_HOST: '127.0.0.1',
      RANGER_PORT: '3901',
    });
    await waitForHealth('http://127.0.0.1:3901/health', proc);
    const res = await fetch('http://127.0.0.1:3901/v1/capabilities');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contractVersion: string; requestId: string };
    expect(body.contractVersion).toBe('v1');
    expect(body.requestId).toBeTruthy();
    expect(await terminate(proc)).toBe(0);
  });

  it('worker: starts, idles with no handlers, clean SIGTERM', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-entry-worker-'));
    const proc = spawnEntrypoint('worker', { RANGER_DATA_DIR: dataDir });
    const line = await waitForStdoutLine(proc, 'ranger worker started');
    expect(line).toContain('"migrationsApplied":1');
    expect(await terminate(proc)).toBe(0);
  });

  it('preview: gateway health on the preview port, refuses everything else explicitly', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-entry-preview-'));
    const proc = spawnEntrypoint('preview', {
      RANGER_DATA_DIR: dataDir,
      RANGER_HOST: '127.0.0.1',
      RANGER_PREVIEW_PORT: '3902',
    });
    await waitForHealth('http://127.0.0.1:3902/health', proc);
    const res = await fetch('http://127.0.0.1:3902/anything/else');
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string }; requestId: string };
    expect(body.error.code).toBe('not_configured');
    expect(body.requestId).toBeTruthy();
    expect(await terminate(proc)).toBe(0);
  });
});
