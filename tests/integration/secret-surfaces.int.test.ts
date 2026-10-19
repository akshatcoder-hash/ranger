import { spawn, type ChildProcess } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
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
 *   do not echo the ticket;
 * - ticketed upgrades to ordinary HTTP routes still emit the websocket
 *   plugin diagnostic, with the ticket absent from the top-level path field.
 *
 * Secrets are compared in-process and never written into assertions.
 * Absence checks are booleans so a failure cannot print the credential.
 */

const REPO = process.cwd();
const started: ChildProcess[] = [];

/**
 * Ask the OS for an unused loopback port. Fixed ports collide with other
 * suites (3908 is also used by capture-inspection and the events e2e) and with
 * stray local listeners; a foreign listener that answers /health makes the
 * readiness probe pass against the wrong process, which then rejects the
 * freshly created bootstrap credential as unauthorized.
 */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const picked = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (picked > 0 ? resolve(picked) : reject(new Error('no free port'))));
    });
  });
}

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

describe('compiled bootstrap secret-source selection', () => {
  it('ignores ambient provider keys by default and accepts explicit environment opt-in without exposing them', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-boot-env-'));
    const env = {
      RANGER_DATA_DIR: dataDir,
      RANGER_CONFIG_FILE: '',
      RANGER_SECRET_FILE: '',
      RANGER_SECRET_SOURCE: '',
      XAI_API_KEY: 'synthetic-bootstrap-env-xai',
      INSTABOX_API_KEY: 'synthetic-bootstrap-env-instabox',
    };
    const defaultSource = await capture(spawnBootstrap([], env));
    expect(defaultSource.code, defaultSource.stderr).toBe(0);
    expect(defaultSource.stdout).toContain('secret source: file');
    expect(defaultSource.stdout).toContain('provider keys present: none');

    const optedIn = await capture(spawnBootstrap([], { ...env, RANGER_SECRET_SOURCE: 'environment' }));
    expect(optedIn.code, optedIn.stderr).toBe(0);
    expect(optedIn.stdout).toContain('secret source: environment');
    expect(optedIn.stdout).toContain('provider keys present: XAI_API_KEY, INSTABOX_API_KEY');
    for (const result of [defaultSource, optedIn]) {
      expect(`${result.stdout}\n${result.stderr}`).not.toContain('synthetic-bootstrap-env-');
    }
  });
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
  let port = 0;
  let base = '';
  let api: ChildProcess | undefined;
  let logs = '';
  let client: RangerClient;
  let bearer = '';
  let projectId = '';

  async function start(): Promise<void> {
    if (api !== undefined && api.exitCode === null) {
      api.kill('SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    logs = '';
    port = await freeLoopbackPort();
    base = `http://127.0.0.1:${port}`;
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
    bearer = `Bearer ${secret}`;
    client = new RangerClient({ baseUrl: base, headers: { authorization: bearer } });
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

    const previewPort = await freeLoopbackPort();
    const previewData = mkdtempSync(path.join(tmpdir(), 'ranger-log-preview-'));
    const preview = spawn('node', ['dist/src/entrypoints/preview.js'], {
      cwd: REPO,
      env: {
        ...process.env,
        RANGER_DATA_DIR: previewData,
        RANGER_HOST: '127.0.0.1',
        RANGER_PREVIEW_PORT: String(previewPort),
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
        const health = await fetch(`http://127.0.0.1:${previewPort}/health`);
        if (health.ok) break;
      } catch {
        // still starting
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const previewRes = await fetch(`http://127.0.0.1:${previewPort}/desktop?ticket=${encodeURIComponent(ticket)}`);
    expect(previewRes.status).toBe(404);
    const previewBody = await previewRes.text();
    expect(previewBody).not.toContain(ticket);

    // Give the info logger a moment to flush the upgrade lines.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(logs).toContain('incoming request');
    expect(logs).toContain('/v1/projects/');
    expect(logs).toContain('events/subscribe');
    expect(logs.includes(ticket)).toBe(false);
    expect(logs.includes(rejectedTicket)).toBe(false);
    expect(logs).toContain('ticket=%5Bredacted%5D');
  });

  it('redacts top-level path on ticketed upgrades to ordinary HTTP routes', async () => {
    await start();
    const issued = await client.createConnectionTicket({ body: { projectId, purpose: 'events' } });
    const ticket = issued.ticket;
    expect(ticket.startsWith('tkt_')).toBe(true);

    const targets = [
      `/health?ticket=${encodeURIComponent(ticket)}`,
      `/v1/openapi.json?ticket=${encodeURIComponent(ticket)}&limit=1`,
      `/v1/projects/${projectId}?ticket=${encodeURIComponent(ticket)}`,
    ];
    for (const target of targets) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${target}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 8000);
        const done = (): void => {
          clearTimeout(timer);
          resolve();
        };
        socket.once('close', done);
        socket.once('error', done);
      });
    }

    const authed = await client.getProject({ path: { projectId } });
    expect(authed.project.projectId).toBe(projectId);
    expect(bearer.startsWith('Bearer ')).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(logs).toContain('closed incoming websocket connection for path with no websocket handler');
    expect(logs).toContain('/health');
    expect(logs).toContain('/v1/openapi.json');
    expect(logs).toContain(`/v1/projects/${projectId}`);
    expect(logs).toContain('ticket=%5Bredacted%5D');
    expect(logs).toContain('limit=1');
    expect(logs.includes(ticket)).toBe(false);
    // Header redaction still censors the bearer on the ordinary authenticated GET.
    // Fastify omits absent headers, so the censor string is not required on the
    // req object; the URL censor is percent-encoded by the shared serializer.
    expect(logs.includes(bearer)).toBe(false);
    expect(logs.includes('%5Bredacted%5D')).toBe(true);
  });
});
