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

interface CapturedProcess {
  proc: ChildProcess;
  stderr: () => string;
}

function spawnEntrypoint(entry: 'api' | 'worker' | 'preview', env: Record<string, string>): CapturedProcess {
  const proc = spawn('node', [`dist/src/entrypoints/${entry}.js`], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, RANGER_LOG_LEVEL: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  started.push({ proc, label: entry });
  return { proc, stderr: () => stderr };
}

/** Failure text keeps the captured stderr, exit code and terminating signal. */
function processFailure(label: string, captured: CapturedProcess, detail: string): Error {
  const { exitCode, signalCode } = captured.proc;
  const stderr = captured.stderr().trim();
  return new Error(
    `${label}: ${detail} (exitCode=${String(exitCode)}, signal=${String(signalCode)})` +
      (stderr === '' ? '' : `\nstderr:\n${stderr}`),
  );
}

async function waitForHealth(url: string, captured: CapturedProcess, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (captured.proc.exitCode !== null || captured.proc.signalCode !== null) {
      throw processFailure(url, captured, 'process exited before becoming healthy');
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
  throw processFailure(url, captured, `health check timed out: ${lastError}`);
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

function waitForStdoutLine(captured: CapturedProcess, needle: string, timeoutMs = 15000): Promise<string> {
  const { proc } = captured;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(processFailure('stdout', captured, `line "${needle}" not seen in time`)),
      timeoutMs,
    );
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString();
      if (text.includes(needle)) {
        clearTimeout(timer);
        proc.stdout?.off('data', onData);
        resolve(text);
      }
    };
    proc.stdout?.on('data', onData);
    proc.once('exit', () => {
      clearTimeout(timer);
      reject(processFailure('stdout', captured, `process exited before "${needle}" appeared`));
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
    const captured = spawnEntrypoint('api', {
      RANGER_DATA_DIR: dataDir,
      RANGER_HOST: '127.0.0.1',
      RANGER_PORT: '3901',
    });
    await waitForHealth('http://127.0.0.1:3901/health', captured);
    const res = await fetch('http://127.0.0.1:3901/v1/capabilities');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contractVersion: string; requestId: string };
    expect(body.contractVersion).toBe('v1');
    expect(body.requestId).toBeTruthy();
    expect(await terminate(captured.proc)).toBe(0);
  });

  it('worker: starts, idles with no handlers, clean SIGTERM', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-entry-worker-'));
    const captured = spawnEntrypoint('worker', { RANGER_DATA_DIR: dataDir });
    const line = await waitForStdoutLine(captured, 'ranger worker started');
    const migrationsApplied = Number((line.match(/"migrationsApplied":(\d+)/) ?? [])[1] ?? '0');
    expect(migrationsApplied).toBeGreaterThanOrEqual(1);
    // Immediate post-readiness SIGTERM must hit the installed handler, not
    // Node's default disposition. No retry: a signal death stays a failure
    // and keeps stderr, exit code and signal in the assertion message.
    const code = await terminate(captured.proc);
    expect(code, processFailure('worker', captured, 'SIGTERM did not exit 0').message).toBe(0);
    expect(captured.proc.signalCode).toBeNull();
  });

  it('preview: gateway health on the preview port, refuses everything else explicitly', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-entry-preview-'));
    const captured = spawnEntrypoint('preview', {
      RANGER_DATA_DIR: dataDir,
      RANGER_HOST: '127.0.0.1',
      RANGER_PREVIEW_PORT: '3902',
    });
    await waitForHealth('http://127.0.0.1:3902/health', captured);
    const res = await fetch('http://127.0.0.1:3902/anything/else');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string }; requestId: string };
    expect(body.error.code).toBe('not_found');
    expect(body.requestId).toBeTruthy();
    expect(await terminate(captured.proc)).toBe(0);
  });
});
