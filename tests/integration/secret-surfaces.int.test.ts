import { spawn, type ChildProcess } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterAll, describe, expect, it } from 'vitest';
import { RangerClient } from '../../src/clients/ranger-client.js';

/**
 * Real public surfaces for VAL-API-003 secret handling:
 * - compiled bootstrap CLI (the documented npm path) refuses in-repo
 *   destinations, including an external symlink into the repo, before
 *   creating a file, and still writes a mode-0600 credential outside;
 * - an info-level API process redacts ticket query values on both a
 *   successful events upgrade and a rejected one, and unknown-route bodies
 *   do not echo the ticket.
 *
 * Secrets are compared in-process and never written into assertions.
 */

const REPO = process.cwd();
const started: ChildProcess[] = [];

function spawnBootstrap(args: string[], env: Record<string, string>): ChildProcess {
  const proc = spawn('node', ['dist/scripts/bootstrap.js', ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push(proc);
  return proc;
}

function capture(proc: ChildProcess): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('bootstrap timed out'));
    }, 20000);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function waitForHealth(base: string, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`api exited ${proc.exitCode} before health`);
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('api health timed out');
}

afterAll(() => {
  for (const proc of started) {
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
});

describe('compiled bootstrap credential containment', () => {
  it('refuses docs, root and dist destinations and an external symlink before creating a file', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-boot-data-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'ranger-boot-outside-'));
    const docsDir = path.join(REPO, 'docs');
    const cases = [
      path.join(docsDir, `ut-cred-${process.pid}.txt`),
      path.join(REPO, `ut-cred-${process.pid}.txt`),
      path.join(REPO, 'dist', `ut-cred-${process.pid}.txt`),
    ];
    const aliasParent = path.join(outside, 'alias-parent');
    mkdirSync(aliasParent);
    const alias = path.join(aliasParent, 'docs-alias');
    symlinkSync(docsDir, alias);
    cases.push(path.join(alias, `ut-cred-${process.pid}.txt`));

    for (const destination of cases) {
      const result = await capture(
        spawnBootstrap(
          ['--additional-principal', 'Probe', '--credential-file', destination],
          { RANGER_DATA_DIR: dataDir },
        ),
      );
      expect(result.code, result.stderr).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/outside the repository/);
      expect(lstatSync(destination, { throwIfNoEntry: false })).toBeUndefined();
    }

    const legitimate = path.join(outside, 'operator.txt');
    const created = await capture(
      spawnBootstrap(
        ['--additional-principal', 'External Operator', '--credential-file', legitimate],
        { RANGER_DATA_DIR: dataDir },
      ),
    );
    expect(created.code, created.stderr).toBe(0);
    expect(created.stdout).toContain('mode 0600');
    expect(created.stdout).not.toContain('RANGER_BOOTSTRAP_TOKEN=');
    expect(statSync(legitimate).mode & 0o777).toBe(0o600);
    const secret = readFileSync(legitimate, 'utf8').trim().split('=')[1] ?? '';
    expect(secret.startsWith('rng_')).toBe(true);
    expect(`${created.stdout}\n${created.stderr}`).not.toContain(secret);
    expect(realpathSync(legitimate).startsWith(realpathSync(REPO) + path.sep)).toBe(false);
  });
});

describe('info-level request logs redact connection tickets', () => {
  const port = 3908;
  const base = `http://127.0.0.1:${port}`;
  let api: ChildProcess;
  let logs = '';
  let client: RangerClient;
  let projectId = '';

  async function start(): Promise<void> {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-log-api-'));
    writeFileSync(path.join(dataDir, '.keep'), '');
    api = spawn('node', ['dist/src/entrypoints/api.js'], {
      cwd: REPO,
      env: {
        ...process.env,
        RANGER_DATA_DIR: dataDir,
        RANGER_HOST: '127.0.0.1',
        RANGER_PORT: String(port),
        RANGER_LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    started.push(api);
    api.stdout?.on('data', (chunk: Buffer) => {
      logs += chunk.toString();
    });
    api.stderr?.on('data', (chunk: Buffer) => {
      logs += chunk.toString();
    });
    await waitForHealth(base, api);

    const boot = await capture(
      spawnBootstrap(['--create-principal', 'Log Operator'], { RANGER_DATA_DIR: dataDir }),
    );
    expect(boot.code, boot.stderr).toBe(0);
    const secret = readFileSync(path.join(dataDir, 'bootstrap-credential.txt'), 'utf8').trim().split('=')[1]!;
    client = new RangerClient({ baseUrl: base, headers: { authorization: `Bearer ${secret}` } });
    const project = await client.createProject({ body: { name: 'Log Project', engineerDisplayName: 'Ranger' } });
    projectId = project.project.projectId;
  }

  it('redacts successful and rejected upgrades and does not echo tickets in 404 bodies', async () => {
    await start();
    const issued = await client.createConnectionTicket({ body: { projectId, purpose: 'events' } });
    const ticket = issued.ticket;
    expect(ticket.startsWith('tkt_')).toBe(true);

    const accepted = new WebSocket(
      `ws://127.0.0.1:${port}/v1/projects/${projectId}/events/subscribe?ticket=${encodeURIComponent(ticket)}`,
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('accepted upgrade timed out')), 8000);
      accepted.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      accepted.once('error', (cause) => {
        clearTimeout(timer);
        reject(cause);
      });
    });
    accepted.close();

    const rejectedTicket = `${ticket}-rejected`;
    const rejected = new WebSocket(
      `ws://127.0.0.1:${port}/v1/projects/${projectId}/events/subscribe?ticket=${encodeURIComponent(rejectedTicket)}`,
    );
    await new Promise<void>((resolve) => {
      rejected.once('close', () => resolve());
      rejected.once('error', () => resolve());
    });

    const missing = await fetch(
      `${base}/v1/does-not-exist?ticket=${encodeURIComponent(ticket)}&cursor=keep-me`,
    );
    expect(missing.status).toBe(404);
    const missingBody = await missing.text();
    expect(missingBody).not.toContain(ticket);
    expect(missingBody).toContain('not_found');
    expect(missingBody).toContain('cursor=keep-me');
    expect(missingBody).toContain('ticket=%5Bredacted%5D');

    const previewData = mkdtempSync(path.join(tmpdir(), 'ranger-log-preview-'));
    const preview = spawn('node', ['dist/src/entrypoints/preview.js'], {
      cwd: REPO,
      env: {
        ...process.env,
        RANGER_DATA_DIR: previewData,
        RANGER_HOST: '127.0.0.1',
        RANGER_PREVIEW_PORT: '3909',
        RANGER_LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    started.push(preview);
    preview.stdout?.on('data', (chunk: Buffer) => {
      logs += chunk.toString();
    });
    preview.stderr?.on('data', (chunk: Buffer) => {
      logs += chunk.toString();
    });
    const previewDeadline = Date.now() + 15000;
    while (Date.now() < previewDeadline) {
      try {
        const health = await fetch('http://127.0.0.1:3909/health');
        if (health.ok) break;
      } catch {
        // still starting
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const previewRes = await fetch(`http://127.0.0.1:3909/desktop?ticket=${encodeURIComponent(ticket)}`);
    expect(previewRes.status).toBe(501);
    const previewBody = await previewRes.text();
    expect(previewBody).not.toContain(ticket);

    // Give the info logger a moment to flush the upgrade lines.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(logs).toContain('incoming request');
    expect(logs).toContain('/v1/projects/');
    expect(logs).toContain('events/subscribe');
    expect(logs).not.toContain(ticket);
    expect(logs).not.toContain(rejectedTicket);
    expect(logs).toContain('ticket=%5Bredacted%5D');
  });
});
