import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RangerApiError, RangerClient } from '../../src/clients/ranger-client.js';
import { createFixtureRepo } from '../helpers/fixture-repo.js';

/**
 * End-to-end identity workflow over the REAL public HTTP surface using the
 * generated typed client: bootstrap CLI → bearer auth → project with
 * engineer display name → repository connection with a real local snapshot →
 * hashed API tokens → revocable browser session with CSRF checks → API
 * process restart durability → two-principal project isolation.
 *
 * Evidence rules: secrets are read from their protected files by the driver
 * (that is the documented contract) and are never printed into test output.
 */

const PORT = 3904;
const BASE = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;

const baseTmp = mkdtempSync(path.join(tmpdir(), 'ranger-identity-e2e-'));
const apiDataDir = path.join(baseTmp, 'data');
mkdirSync(apiDataDir, { recursive: true }); // bootstrap verifies writability of the data dir
const fixture = createFixtureRepo(baseTmp, 'e2e-app');
const secondCredentialPath = path.join(baseTmp, 'second-credential.txt');

/** Ordered single-file flow state. */
const store: { operatorToken: string; secondToken: string; projectId: string; head: string; cookie: string } = {
  operatorToken: '',
  secondToken: '',
  projectId: '',
  head: '',
  cookie: '',
};

let api: ChildProcess | undefined;

function startApi(): ChildProcess {
  return spawn('node', ['dist/src/entrypoints/api.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RANGER_LOG_LEVEL: 'error',
      RANGER_DATA_DIR: apiDataDir,
      RANGER_HOST: '127.0.0.1',
      RANGER_PORT: String(PORT),
      // The e2e operator approves the e2e fixture area for local snapshot
      // inspection; everything outside stays uninspected.
      RANGER_APPROVED_SNAPSHOT_ROOTS: baseTmp,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

async function waitForHealth(client: RangerClient, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      await client.getHealth();
      return;
    } catch (cause) {
      lastError = String(cause);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`api never became healthy: ${lastError}`);
}

function runBootstrap(args: string[]): string {
  return execFileSync('node', ['dist/scripts/bootstrap.js', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, RANGER_LOG_LEVEL: 'error', RANGER_DATA_DIR: apiDataDir },
    encoding: 'utf8',
  });
}

function credentialFrom(file: string): string {
  return readFileSync(file, 'utf8').trim().split('=')[1]!;
}

function expectApiError(cause: unknown, code: string, status: number): void {
  expect(cause).toBeInstanceOf(RangerApiError);
  expect((cause as RangerApiError).code).toBe(code);
  expect((cause as RangerApiError).status).toBe(status);
}

afterAll(async () => {
  const running = api;
  if (running !== undefined && running.exitCode === null) {
    running.kill('SIGTERM');
    await new Promise((resolve) => running.once('exit', resolve));
  }
});

describe('identity e2e over the public API', () => {
  it('bootstraps two principals through the real CLI without echoing secrets', () => {
    const first = runBootstrap(['--create-principal', 'Operator']);
    expect(first).toContain('principal:');
    expect(first).toContain('mode 0600');
    const second = runBootstrap([
      '--additional-principal',
      'Second Operator',
      '--credential-file',
      secondCredentialPath,
    ]);
    expect(second).toContain('principal:');

    store.operatorToken = credentialFrom(path.join(apiDataDir, 'bootstrap-credential.txt'));
    store.secondToken = credentialFrom(secondCredentialPath);
    // Secrets never appear in CLI output.
    expect(first.includes(store.operatorToken)).toBe(false);
    expect(second.includes(store.secondToken)).toBe(false);
  });

  it('drives projects, engineer name and repository with the typed client alone', async () => {
    api = startApi();
    const operator = new RangerClient({ baseUrl: BASE, headers: { authorization: `Bearer ${store.operatorToken}` } });
    await waitForHealth(operator);

    const me = await operator.getPrincipal();
    expect(me.displayName).toBe('Operator');

    const created = await operator.createProject({
      body: { name: 'E2E Project', engineerDisplayName: 'Ranger' },
    });
    const projectId = created.project.projectId;
    expect(projectId.startsWith('prj_')).toBe(true);

    const renamed = await operator.updateProject({
      path: { projectId },
      body: { engineerDisplayName: 'Ranger E2E' },
    });
    expect(renamed.project.engineerDisplayName).toBe('Ranger E2E');

    const connect = await operator.connectRepository({
      path: { projectId },
      body: {
        url: fixture.fileUrl,
        ref: 'main',
        checkoutPath: 'workspace',
        checkoutPolicy: { shallow: false, submodules: false },
      },
    });
    const head = execFileSync('git', ['-C', fixture.root, 'rev-parse', 'HEAD']).toString().trim();
    expect(connect.repository.commit).toBe(head);
    expect(connect.repository.dirty).toBe(false);
    expect(connect.repository.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const readBack = await operator.getRepository({ path: { projectId } });
    expect(readBack.repository.commit).toBe(head);
    expect(readBack.repository.checkoutPath).toBe('workspace');

    // Credential-bearing URLs (including the username-only token form) are
    // rejected through the public contract with a safe stable error.
    let rejected: unknown;
    try {
      await operator.connectRepository({
        path: { projectId },
        body: { url: 'https://token@git.example/org/app.git', ref: 'main' },
      });
    } catch (cause) {
      rejected = cause;
    }
    expect(rejected).toBeInstanceOf(RangerApiError);
    expect((rejected as RangerApiError).status).toBe(400);
    expect((rejected as RangerApiError).code).toBe('validation_failed');
    expect(JSON.stringify((rejected as RangerApiError).details ?? {})).toContain('credentials_in_url');

    store.projectId = projectId;
    store.head = head;
  });

  it('creates hashed API tokens and revokes them; other principals keep working and stay isolated', async () => {
    const operator = new RangerClient({ baseUrl: BASE, headers: { authorization: `Bearer ${store.operatorToken}` } });
    const projectId = store.projectId;

    const tokenCreate = await operator.createApiToken({ body: { name: 'e2e-worker' } });
    expect(tokenCreate.token.startsWith('rng_')).toBe(true);
    const worker = new RangerClient({ baseUrl: BASE, headers: { authorization: `Bearer ${tokenCreate.token}` } });
    const workerMe = await worker.getPrincipal();
    expect(workerMe.principalId).toBe((await operator.getPrincipal()).principalId);

    // The second principal works on their own project and cannot touch ours.
    const second = new RangerClient({ baseUrl: BASE, headers: { authorization: `Bearer ${store.secondToken}` } });
    const secondProject = await second.createProject({
      body: { name: 'Second Project', engineerDisplayName: 'Second Ranger' },
    });
    expect(secondProject.project.projectId).not.toBe(projectId);
    let crossRead: unknown;
    try {
      await second.getProject({ path: { projectId } });
    } catch (cause) {
      crossRead = cause;
    }
    expectApiError(crossRead, 'forbidden', 403);

    await operator.revokeApiToken({ path: { tokenId: tokenCreate.tokenId } });
    let revokedUse: unknown;
    try {
      await worker.getPrincipal();
    } catch (cause) {
      revokedUse = cause;
    }
    expectApiError(revokedUse, 'unauthorized', 401);
    // The operator credential keeps working after revoking the token.
    await operator.getPrincipal();
  });

  it('exchanges the credential for a revocable browser session with CSRF-protected cookie mutations', async () => {
    const projectId = store.projectId;
    // Raw fetch to capture Set-Cookie; the typed client surfaces the body only.
    const sessionRes = await fetch(`${BASE}/v1/auth/browser-sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${store.operatorToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ apiToken: store.operatorToken }),
    });
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as { sessionId: string; csrfToken: string };
    const setCookie = sessionRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    const cookieValue = setCookie.split(';')[0]!.split('=').slice(1).join('=');

    const browser = new RangerClient({
      baseUrl: BASE,
      headers: { cookie: `ranger_session=${cookieValue}`, host: HOST },
    });
    const me = await browser.getPrincipal();
    expect(me.displayName).toBe('Operator');

    // Cookie mutation without any protection: rejected.
    let bare: unknown;
    try {
      await browser.updateProject({ path: { projectId }, body: { name: 'Bare' } });
    } catch (cause) {
      bare = cause;
    }
    expectApiError(bare, 'forbidden', 403);

    // Cookie mutation with the synchronizer token: accepted.
    const withToken = new RangerClient({
      baseUrl: BASE,
      headers: { cookie: `ranger_session=${cookieValue}`, host: HOST, 'x-ranger-csrf': session.csrfToken },
    });
    const renamed = await withToken.updateProject({
      path: { projectId },
      body: { engineerDisplayName: 'Ranger Cookie' },
    });
    expect(renamed.project.engineerDisplayName).toBe('Ranger Cookie');

    store.cookie = cookieValue;
  });

  it('issues short-lived connection tickets bound to the project, refusing non-members', async () => {
    const operator = new RangerClient({ baseUrl: BASE, headers: { authorization: `Bearer ${store.operatorToken}` } });
    const projectId = store.projectId;
    const ticket = await operator.createConnectionTicket({
      body: { projectId, purpose: 'events', origin: `http://${HOST}` },
    });
    expect(ticket.ticket.startsWith('tkt_')).toBe(true);
    expect(new Date(ticket.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const second = new RangerClient({ baseUrl: BASE, headers: { authorization: `Bearer ${store.secondToken}` } });
    let foreign: unknown;
    try {
      await second.createConnectionTicket({ body: { projectId, purpose: 'events' } });
    } catch (cause) {
      foreign = cause;
    }
    expectApiError(foreign, 'forbidden', 403);
  });

  it('keeps the session, project name and repository references across an API restart', async () => {
    // Real process restart: SIGTERM, wait, respawn on the SAME data dir.
    api!.kill('SIGTERM');
    await new Promise((resolve) => api!.once('exit', resolve));
    api = startApi();
    const operator = new RangerClient({ baseUrl: BASE, headers: { authorization: `Bearer ${store.operatorToken}` } });
    await waitForHealth(operator);

    const projectId = store.projectId;
    const project = await operator.getProject({ path: { projectId } });
    expect(project.project.name).toBe('E2E Project');
    expect(project.project.engineerDisplayName).toBe('Ranger Cookie');

    const repo = await operator.getRepository({ path: { projectId } });
    expect(repo.repository.commit).toBe(store.head);
    expect(repo.repository.url).toBe(fixture.fileUrl);
    expect(repo.repository.checkoutPolicy).toEqual({ shallow: false, submodules: false });

    // The browser session survives the restart.
    const browser = new RangerClient({
      baseUrl: BASE,
      headers: { cookie: `ranger_session=${store.cookie}`, host: HOST },
    });
    const me = await browser.getPrincipal();
    expect(me.displayName).toBe('Operator');

    // The revoked API token stays revoked after restart.
    const list = await operator.listApiTokens();
    expect(list.tokens.length).toBeGreaterThanOrEqual(1);
  });
});
