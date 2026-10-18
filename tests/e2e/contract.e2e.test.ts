import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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

const FAMILY_SAMPLES: Record<string, (client: RangerClient) => Promise<unknown>> = {
  'credentials-sessions': (client) => client.createApiToken({ body: { name: 'probe' } }),
  'projects-memberships': (client) => client.createProject({ body: { name: 'probe' } }),
  repositories: (client) => client.getRepository({ path: { projectId: PRJ } }),
  'conversations-requirements': (client) => client.listConversations({ path: { projectId: PRJ } }),
  events: (client) => client.replayProjectEvents({ path: { projectId: PRJ } }),
  voice: (client) =>
    client.startVoiceSession({
      path: { projectId: PRJ },
      body: { conversationId: 'cnv_00000000-2222-4c3d-9f4e-2b7c5d1a3f10' },
    }),
  capture: (client) => client.startCaptureSession({ path: { projectId: PRJ }, body: {} }),
  'plans-approvals': (client) => client.listPlans({ path: { projectId: PRJ } }),
  runs: (client) => client.listRuns({ path: { projectId: PRJ } }),
  workspace: (client) => client.getWorkspaceStatus({ path: { projectId: PRJ } }),
  'desktop-preview': (client) => client.createDesktopSession({ path: { projectId: PRJ }, body: {} }),
  retrieval: (client) => client.retrievalStatus({ path: { projectId: PRJ } }),
};

let proc: ChildProcess;

afterAll(async () => {
  if (proc !== undefined && proc.exitCode === null) {
    proc.kill('SIGTERM');
    await new Promise((resolve) => proc.once('exit', resolve));
  }
});

describe('typed client over the public API', () => {
  proc = spawn('node', ['dist/src/entrypoints/api.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RANGER_LOG_LEVEL: 'error',
      RANGER_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'ranger-e2e-')),
      RANGER_HOST: '127.0.0.1',
      RANGER_PORT: String(PORT),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const client = new RangerClient({ baseUrl: BASE });
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

  it('fetches the served openapi document through the client', async () => {
    const doc = await client.getOpenApiDocument();
    expect(doc['openapi']).toBe('3.1.0');
  });

  it('reports explicit capability errors for every unfinished family, with envelope requestIds', async () => {
    for (const family of ROUTE_FAMILIES) {
      // capabilities routes have real handlers; covered by earlier tests here.
      if (family === 'capabilities') continue;
      const sample = FAMILY_SAMPLES[family];
      if (sample === undefined) throw new Error(`no family sample for ${family}`);
      let caught: unknown;
      try {
        await sample(client);
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
});
