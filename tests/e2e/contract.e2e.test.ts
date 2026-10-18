import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RangerApiError, RangerClient } from '../../src/clients/ranger-client.js';
import { ROUTE_FAMILIES } from '../../src/contracts/registry.js';

/**
 * End-to-end contract check over the REAL public HTTP surface using ONLY the
 * generated typed client (the same driver path the future frontend uses):
 * health, capabilities, the served OpenAPI document, and one sampled
 * not_configured envelope per declared route family.
 */

const PRJ = 'prj_00000000-1111-4c3d-9f4e-2b7c5d1a3f10';
const PORT = 3903;
const BASE = `http://127.0.0.1:${PORT}`;

const NOT_CONFIGURED_FAMILY_SAMPLES: Record<string, (client: RangerClient) => Promise<unknown>> = {
  voice: (client) =>
    client.startVoiceSession({
      path: { projectId: PRJ },
      body: { conversationId: 'cnv_00000000-2222-4c3d-9f4e-2b7c5d1a3f10' },
    }),
  capture: (client) => client.startCaptureSession({ path: { projectId: PRJ }, body: {} }),
};

/** Families with real handlers: unauthenticated requests fail unauthorized. */
const IMPLEMENTED_FAMILY_SAMPLES: Record<string, (client: RangerClient) => Promise<unknown>> = {
  'credentials-sessions': (client) => client.createApiToken({ body: { name: 'probe' } }),
  'projects-memberships': (client) => client.createProject({ body: { name: 'probe' } }),
  repositories: (client) => client.getRepository({ path: { projectId: PRJ } }),
  'conversations-requirements': (client) => client.listConversations({ path: { projectId: PRJ } }),
  events: (client) => client.replayProjectEvents({ path: { projectId: PRJ } }),
  workspace: (client) => client.getWorkspaceStatus({ path: { projectId: PRJ } }),
  'plans-approvals': (client) => client.listPlans({ path: { projectId: PRJ } }),
  runs: (client) => client.listRuns({ path: { projectId: PRJ } }),
  retrieval: (client) => client.retrievalStatus({ path: { projectId: PRJ } }),
  'desktop-preview': (client) => client.createDesktopSession({ path: { projectId: PRJ }, body: {} }),
};

let proc: ChildProcess;

afterAll(async () => {
  if (proc !== undefined && proc.exitCode === null) {
    proc.kill('SIGTERM');
    await new Promise((resolve) => proc.once('exit', resolve));
  }
});

describe('typed client over the public API', () => {
const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-e2e-'));
  proc = spawn('node', ['dist/src/entrypoints/api.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RANGER_LOG_LEVEL: 'error',
      RANGER_DATA_DIR: dataDir,
      RANGER_HOST: '127.0.0.1',
      RANGER_PORT: String(PORT),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const client = new RangerClient({ baseUrl: BASE });
  /** Authenticated client used to reach the not_configured handlers past auth. */
  let authedClient = client;
  const requestIds: string[] = [];

  it('exposes health and capabilities with unique request ids', async () => {
    const deadline = Date.now() + 15000;
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        const health = await client.getHealth();
        const capabilities = await client.getCapabilities();
        expect(health.status).toBe('ok');
        expect(capabilities.contractVersion).toBe('v1');
        requestIds.push(health.requestId, capabilities.requestId);
        expect(new Set(requestIds).size).toBe(requestIds.length);
        return;
      } catch (cause) {
        lastError = String(cause);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new Error(`api never became healthy: ${lastError}`);
  });

  it('bootstraps an initial principal through the real CLI and authenticates with its credential', async () => {
    const bootstrap = spawn(
      'node',
      ['dist/scripts/bootstrap.js', '--create-principal', 'E2E Driver'],
      {
        cwd: process.cwd(),
        env: { ...process.env, RANGER_LOG_LEVEL: 'error', RANGER_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    const stdout = await new Promise<string>((resolve, reject) => {
      let collected = '';
      bootstrap.stdout?.on('data', (chunk: Buffer) => {
        collected += chunk.toString();
      });
      bootstrap.once('exit', (code) => (code === 0 ? resolve(collected) : reject(new Error(`bootstrap exited ${code}`))));
    });
    // The CLI names the credential file; it must never echo the secret.
    expect(stdout).toContain('credential file: created at');
    const credentialPath = path.join(dataDir, 'bootstrap-credential.txt');
    const token = readFileSync(credentialPath, 'utf8').trim().split('=')[1]!;
    expect(stdout.includes(token)).toBe(false);
    authedClient = new RangerClient({ baseUrl: BASE, headers: { authorization: `Bearer ${token}` } });
    const me = await authedClient.getPrincipal();
    expect(me.principalId.startsWith('prin_')).toBe(true);
    expect(me.displayName).toBe('E2E Driver');
  });

  it('fetches the served openapi document through the client', async () => {
    const doc = await client.getOpenApiDocument();
    expect(doc['openapi']).toBe('3.1.0');
  });

  it('reports explicit capability errors for every unfinished family, with envelope requestIds', async () => {
    for (const family of ROUTE_FAMILIES) {
      // capabilities routes have real handlers; covered by earlier tests here.
      // Implemented families (identity feature) are asserted separately below.
      if (family === 'capabilities' || IMPLEMENTED_FAMILY_SAMPLES[family] !== undefined) continue;
      const sample = NOT_CONFIGURED_FAMILY_SAMPLES[family];
      if (sample === undefined) throw new Error(`no family sample for ${family}`);
      let caught: unknown;
      try {
        await sample(authedClient);
      } catch (cause) {
        caught = cause;
      }
      expect(caught, `family ${family} should refuse`).toBeInstanceOf(RangerApiError);
      const err = caught as RangerApiError;
      expect(err.code, `family ${family}`).toBe('not_configured');
      expect(err.status).toBe(501);
      expect(err.requestId).toBeTruthy();
      requestIds.push(err.requestId);
      expect(new Set(requestIds).size).toBe(requestIds.length);
    }
  });

  it('implemented families demand authentication (standard unauthorized envelope)', async () => {
    for (const [family, sample] of Object.entries(IMPLEMENTED_FAMILY_SAMPLES)) {
      let caught: unknown;
      try {
        await sample(client);
      } catch (cause) {
        caught = cause;
      }
      expect(caught, `family ${family} should refuse`).toBeInstanceOf(RangerApiError);
      const err = caught as RangerApiError;
      expect(err.code, `family ${family}`).toBe('unauthorized');
      expect(err.status).toBe(401);
      expect(err.requestId).toBeTruthy();
      requestIds.push(err.requestId);
      expect(new Set(requestIds).size).toBe(requestIds.length);
    }
  });
});
