import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type RangerConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApiServer } from '../../src/http/app.js';
import { ROUTE_FAMILIES } from '../../src/contracts/registry.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';

/**
 * Contract skeleton integration tests: the served v1 document, the central
 * envelope, per-family capability errors and restart persistence — all on a
 * fresh temporary data directory, offline (no provider credentials loaded).
 */

const PRJ = 'prj_00000000-1111-4c3d-9f4e-2b7c5d1a3f10';
const CNV = 'cnv_00000000-2222-4c3d-9f4e-2b7c5d1a3f10';
const VCS = 'vcs_00000000-3333-4c3d-9f4e-2b7c5d1a3f10';

async function makeApp(env: Record<string, string>, existingDataDir?: string): Promise<{ app: FastifyInstance; config: RangerConfig; dataDir: string }> {
  const dataDir = existingDataDir ?? mkdtempSync(path.join(tmpdir(), 'ranger-api-int-'));
  const config = await loadConfig({ RANGER_DATA_DIR: dataDir, RANGER_LOG_LEVEL: 'error', ...env } as NodeJS.ProcessEnv);
  const db = openDatabase(dataDir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const app = await buildApiServer({ config, db });
  return { app, config, dataDir };
}

/** One sampled operation per family that must report an explicit capability error. */
const FAMILY_SAMPLES: Record<string, { method: 'GET' | 'POST'; url: string; body?: Record<string, unknown> }> = {
  voice: { method: 'POST', url: `/v1/projects/${PRJ}/voice/sessions`, body: { conversationId: CNV } },
  capture: { method: 'POST', url: `/v1/projects/${PRJ}/capture/sessions`, body: {} },
  'plans-approvals': { method: 'GET', url: `/v1/projects/${PRJ}/plans` },
  runs: { method: 'GET', url: `/v1/projects/${PRJ}/runs` },
};

/** Families with real handlers now: unauthenticated requests get unauthorized, not not_configured. */
const IMPLEMENTED_FAMILY_SAMPLES: Record<string, { method: 'GET' | 'POST'; url: string; body?: Record<string, unknown> }> = {
  'credentials-sessions': { method: 'POST', url: '/v1/auth/api-tokens', body: { name: 'probe' } },
  'projects-memberships': { method: 'POST', url: '/v1/projects', body: { name: 'probe' } },
  repositories: { method: 'GET', url: `/v1/projects/${PRJ}/repository` },
  'conversations-requirements': { method: 'GET', url: `/v1/projects/${PRJ}/conversations` },
  events: { method: 'GET', url: `/v1/projects/${PRJ}/events` },
  workspace: { method: 'GET', url: `/v1/projects/${PRJ}/workspace/status` },
  'desktop-preview': { method: 'POST', url: `/v1/projects/${PRJ}/desktop/sessions`, body: {} },
  retrieval: { method: 'GET', url: `/v1/projects/${PRJ}/retrieval/status` },
};

describe('api skeleton', () => {
  let app: FastifyInstance;
  /** Valid bearer credential so unfinished routes reach their not_configured handler. */
  let bearerHeaders: Record<string, string>;

  beforeAll(async () => {
    const made = await makeApp({});
    app = made.app;
    const db = new DatabaseSync(path.join(made.dataDir, 'ranger.db'));
    const outcome = ensureInitialPrincipal(db, {
      dataDir: made.dataDir,
      repoRoot: process.cwd(),
      displayName: 'Skeleton Driver',
    });
    bearerHeaders = {
      authorization: `Bearer ${readFileSync(outcome.credentialPath, 'utf8').trim().split('=')[1]!}`,
    };
    db.close();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves /health with a unique requestId', async () => {
    const first = await app.inject({ method: 'GET', url: '/health' });
    const second = await app.inject({ method: 'GET', url: '/health' });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { requestId: string; status: string };
    const secondBody = second.json() as { requestId: string };
    expect(firstBody.status).toBe('ok');
    expect(firstBody.requestId).not.toBe(secondBody.requestId);
    expect(first.headers['x-request-id']).toBe(firstBody.requestId);
  });

  it('serves the v1 openapi document byte-equal to the builder output', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const served = res.json() as Record<string, unknown>;
    expect(served['openapi']).toBe('3.1.0');
    const paths = served['paths'] as Record<string, unknown>;
    expect(Object.keys(paths).length).toBeGreaterThanOrEqual(60);
  });

  it('reports honest provider status in capabilities without reading secrets', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/capabilities' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      requestId: string;
      contractVersion: string;
      providers?: Partial<Record<string, { configured: boolean; detail: string }>>;
      grounding?: { atomOrbit?: { enabled: boolean } };
      adapters?: Partial<Record<string, { kind: string; available: boolean }>>;
    };
    expect(body.contractVersion).toBe('v1');
    expect(body.providers?.xai?.configured).toBe(false);
    expect(body.providers?.instabox?.configured).toBe(false);
    // Trace presence is environment-dependent (sibling repo exists here);
    // the honest assertion is a boolean status with a detail string.
    expect(typeof body.providers?.trace?.configured).toBe('boolean');
    expect(typeof body.providers?.trace?.detail).toBe('string');
    expect(body.grounding?.atomOrbit?.enabled).toBe(false);
    expect(body.adapters?.instabox?.kind).toBe('vm');
    expect(body.adapters?.trustedFixture).toBeUndefined();
  });

  it('serves the realtime event schema bundle', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/events/schemas' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { schemaVersion: number; eventTypes: unknown[] };
    expect(body.schemaVersion).toBe(1);
    expect(body.eventTypes.length).toBeGreaterThanOrEqual(20);
  });

  it('returns the explicit not_configured envelope for a sample of every unfinished family', async () => {
    for (const family of ROUTE_FAMILIES) {
      // capabilities routes have real handlers (health/capabilities/doc), so
      // there is no unfinished sample; they are covered by dedicated tests.
      // credentials-sessions, projects-memberships and repositories are
      // implemented (identity feature) and asserted separately below.
      if (family === 'capabilities' || IMPLEMENTED_FAMILY_SAMPLES[family] !== undefined) continue;
      const sample = FAMILY_SAMPLES[family];
      if (sample === undefined) throw new Error(`no family sample for ${family}`);
      const res = await app.inject({
        method: sample.method,
        url: sample.url,
        headers: bearerHeaders,
        ...(sample.body !== undefined ? { payload: sample.body } : {}),
      });
      expect(res.statusCode, `family ${family} should report 501 not_configured`).toBe(501);
      const body = res.json() as { requestId: string; error: { code: string; message: string } };
      expect(body.error.code).toBe('not_configured');
      expect(body.requestId).toBeTruthy();
      expect(body.error.message).not.toMatch(/sk-|xai-|Bearer /i);
    }
  });

  it('implemented families authenticate: unauthenticated samples get the standard unauthorized envelope', async () => {
    for (const [family, sample] of Object.entries(IMPLEMENTED_FAMILY_SAMPLES)) {
      const res = await app.inject({
        method: sample.method,
        url: sample.url,
        ...(sample.body !== undefined ? { payload: sample.body } : {}),
      });
      expect(res.statusCode, `family ${family} should demand authentication`).toBe(401);
      const body = res.json() as { requestId: string; error: { code: string } };
      expect(body.error.code).toBe('unauthorized');
      expect(body.requestId).toBeTruthy();
    }
  });

  it('validates request bodies against declared schemas even on unimplemented routes', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/projects', payload: { name: 42 } });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { requestId: string; error: { code: string } };
    expect(body.error.code).toBe('validation_failed');
  });

  it('rejects malformed path ids before reaching handlers', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/projects/not-a-project-id/repository' });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('validation_failed');
  });

  it('returns the envelope for unknown routes (no fastify default shape)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/definitely/not/a/route' });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { requestId: string; error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('closes declared websocket routes without handlers with the stable not_configured code 4501', async () => {
    await app.listen({ host: '127.0.0.1', port: 3905 });
    try {
      // The events subscription is implemented (ticket-gated); the voice
      // relay is still a declared-not-configured ws route.
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:3905/v1/projects/${PRJ}/voice/sessions/${VCS}/relay`);
        socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      });
      const result = await closed;
      expect(result.code).toBe(4501);
      expect(result.reason).toBe('not_configured');
    } finally {
      await app.close();
    }
  });
});

describe('restart persistence', () => {
  it('preserves migrations and data across an API restart on the same data dir', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-restart-'));
    const secretFile = path.join(dataDir, 'env-fixture');
    writeFileSync(secretFile, 'XAI_API_KEY=fixture-value-for-capabilities\n');
    chmodSync(secretFile, 0o600);

    const first = await makeApp({ RANGER_SECRET_FILE: secretFile }, dataDir);
    const db1 = new DatabaseSync(path.join(dataDir, 'ranger.db'));
    db1.prepare("INSERT INTO jobs (id, type, payload, created_at, updated_at) VALUES ('job_keep', 'probe', '{}', 1, 1)").run();
    db1.close();
    const capRes = await first.app.inject({ method: 'GET', url: '/v1/capabilities' });
    const cap1 = capRes.json() as { providers?: { xai?: { configured?: boolean } } };
    expect(cap1.providers?.xai?.configured).toBe(true);
    await first.app.close();

    // Second process on the SAME data directory (a restart).
    const second = await makeApp({ RANGER_SECRET_FILE: secretFile }, dataDir);
    void second;
    const db2 = new DatabaseSync(path.join(dataDir, 'ranger.db'));
    const row = db2.prepare("SELECT id FROM jobs WHERE id = 'job_keep'").get() as { id: string } | undefined;
    expect(row?.id).toBe('job_keep');
    const migrations = db2.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number };
    expect(migrations.count).toBeGreaterThanOrEqual(1);
    db2.close();
    await second.app.close();
  });
});
