import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/config.js';
import { openDatabase, withTransaction } from '../../src/db/db.js';
import { requestProjectWorkspacePrep } from '../../src/workspace/prepare.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApiServer } from '../../src/http/app.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { addMembershipRow } from '../../src/projects/store.js';
import { createCredential, createPrincipal } from '../../src/auth/principals.js';
import { FakeInstabox } from '../../src/workspace/instabox.js';
import { setWorkspaceProviderForTests } from '../../src/workspace/runtime.js';

/**
 * Public workspace/viewing API over a fake Instabox provider.
 * Labeled deterministic: no live VM, no secret file, no shared ledger.
 */

const tempDirs: string[] = [];

afterEach(() => {
  setWorkspaceProviderForTests(null);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface Harness {
  app: FastifyInstance;
  ownerAuth: Record<string, string>;
  otherAuth: Record<string, string>;
  projectId: string;
  otherProjectId: string;
  provider: FakeInstabox;
  dataDir: string;
}

async function harness(): Promise<Harness> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-ws-api-'));
  tempDirs.push(dataDir);
  const ledger = path.join(dataDir, 'ledger.json');
  writeFileSync(
    ledger,
    JSON.stringify({
      version: 1,
      xai: { limitUsd: 5, softAdmissionUsd: 4, observedUsd: 0, reservedUsd: 0, operations: [] },
      instabox: {
        maxAdditionalCreations: 6,
        maxConcurrent: 1,
        maxLifetimeSeconds: 600,
        additionalCreations: 0,
        machines: [],
      },
    }),
  );
  const provider = new FakeInstabox();
  setWorkspaceProviderForTests(provider);
  const config = await loadConfig({
    RANGER_DATA_DIR: dataDir,
    RANGER_LOG_LEVEL: 'error',
    RANGER_LIVE_BUDGET_FILE: ledger,
  } as NodeJS.ProcessEnv);
  const db = openDatabase(dataDir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const owner = ensureInitialPrincipal(db, {
    dataDir,
    repoRoot: process.cwd(),
    displayName: 'Owner',
  });
  const ownerSecret = readFileSync(owner.credentialPath, 'utf8').trim().split('=')[1]!;
  const otherPrincipal = createPrincipal(db, 'Other');
  const otherCred = createCredential(db, otherPrincipal.id, 'api_token', 'other-token');
  const project = createProjectRecord(db, {
    name: 'Workspace',
    engineerDisplayName: 'Ranger',
    principalId: owner.principalId,
  });
  const otherProject = createProjectRecord(db, {
    name: 'Other',
    engineerDisplayName: 'Other',
    principalId: otherPrincipal.id,
  });
  void addMembershipRow;
  const app = await buildApiServer({ config, db });
  return {
    app,
    ownerAuth: { authorization: `Bearer ${ownerSecret}` },
    otherAuth: { authorization: `Bearer ${otherCred.secret}` },
    projectId: project.id,
    otherProjectId: otherProject.id,
    provider,
    dataDir,
  };
}

describe('workspace public API (deterministic fake provider)', () => {
  it('connects and queues preparation without a voice session, deduplicating reconnects and calls', async () => {
    const h = await harness();
    const url = `/v1/projects/${h.projectId}/repository`;
    const payload = { url: 'https://github.com/jonschlinkert/is-number', ref: 'HEAD' };
    expect((await h.app.inject({ method: 'PUT', url, headers: h.otherAuth, payload })).statusCode).toBe(403);
    const db = new DatabaseSync(path.join(h.dataDir, 'ranger.db'));
    expect(db.prepare('SELECT count(*) AS n FROM jobs').get()?.['n']).toBe(0);
    expect((await h.app.inject({ method: 'PUT', url, headers: h.ownerAuth, payload })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'PUT', url, headers: h.ownerAuth, payload })).statusCode).toBe(200);
    expect(db.prepare('SELECT count(*) AS n FROM voice_sessions').get()?.['n']).toBe(0);
    const jobs = db.prepare('SELECT id,payload FROM jobs').all() as Array<{ id: string; payload: string }>;
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0]!.payload)).toMatchObject({ projectId: h.projectId, sessionId: null });
    expect(withTransaction(db, () => requestProjectWorkspacePrep(db, {
      projectId: h.projectId, conversationId: '', sessionId: 'vcs_later', requestId: 'later', readiness: () => null,
    })).jobId).toBe(jobs[0]!.id);
    expect(db.prepare('SELECT count(*) AS n FROM jobs').get()?.['n']).toBe(1);
    db.close();
    await h.app.close();
  });

  it('authorizes and validates human desktop input, and refuses input after Stop VM', async () => {
    const h = await harness();
    await h.app.inject({ method: 'POST', url: `/v1/projects/${h.projectId}/workspace`, headers: h.ownerAuth, payload: {} });
    const url = `/v1/projects/${h.projectId}/workspace/desktop/input`;
    const click = { action: 'click', x: 10, y: 20 };
    expect((await h.app.inject({ method: 'POST', url, headers: h.otherAuth, payload: click })).statusCode).toBe(403);
    expect(h.provider.desktopInputs).toHaveLength(0);
    for (const payload of [click, { action: 'type', text: 'hello' }, { action: 'press', keys: ['ctrl', 'a'] },
      { action: 'drag', x: 1, y: 1, toX: 20, toY: 30 }, { action: 'scroll', x: 5, y: 5, direction: 'down', amount: 3 }]) {
      expect((await h.app.inject({ method: 'POST', url, headers: h.ownerAuth, payload })).statusCode).toBe(200);
    }
    expect(h.provider.desktopInputs).toHaveLength(5);
    for (const payload of [{ ...click, x: -1 }, { ...click, machineId: 'foreign' }, { ...click, x: 20000 },
      { action: 'exec', command: 'bad' }, { action: 'type', text: 'x'.repeat(2001) }, { action: 'press', keys: ['bad key'] }]) {
      expect((await h.app.inject({ method: 'POST', url, headers: h.ownerAuth, payload })).statusCode).toBe(400);
    }
    await h.app.inject({ method: 'DELETE', url: `/v1/projects/${h.projectId}/workspace`, headers: h.ownerAuth });
    expect((await h.app.inject({ method: 'POST', url, headers: h.ownerAuth, payload: click })).statusCode).toBe(409);
    expect(h.provider.desktopInputs).toHaveLength(5);
    await h.app.close();
  });
  it('does not leave a creating row after capacity rejection and allows a later retry', async () => {
    const h = await harness();
    const file = path.join(h.dataDir, 'ledger.json');
    const ledger = JSON.parse(readFileSync(file, 'utf8'));
    ledger.instabox.maxConcurrent = 0;
    writeFileSync(file, JSON.stringify(ledger));
    const create = () => h.app.inject({ method: 'POST', url: `/v1/projects/${h.projectId}/workspace`, headers: h.ownerAuth, payload: {} });
    expect((await create()).json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'vm_capacity' } } });
    expect(h.provider.creates).toHaveLength(0);
    const db = new DatabaseSync(path.join(h.dataDir, 'ranger.db'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE project_id = ?').get(h.projectId)?.['n']).toBe(0);
    ledger.instabox.maxConcurrent = 5;
    ledger.instabox.maxLifetimeSeconds = null;
    writeFileSync(file, JSON.stringify(ledger));
    expect((await create()).statusCode).toBe(200);
    expect(h.provider.creates[0]?.timeoutMs).toBeNull();
    expect(db.prepare('SELECT deadline_at FROM workspaces WHERE project_id = ?').get(h.projectId)?.['deadline_at']).toBeNull();
    const stop = await h.app.inject({ method: 'DELETE', url: `/v1/projects/${h.projectId}/workspace`, headers: h.ownerAuth });
    expect(stop.statusCode).toBe(200);
    expect(h.provider.kills).toHaveLength(1);
    db.close();
    await h.app.close();
  });

  it('recovers a definite create failure but refuses duplicate uncertain creates', async () => {
    const h = await harness();
    const create = () => h.app.inject({ method: 'POST', url: `/v1/projects/${h.projectId}/workspace`, headers: h.ownerAuth, payload: {} });
    h.provider.failNextCreateDefinite();
    expect((await create()).json()).toMatchObject({ error: { details: { reason: 'provider_unavailable' } } });
    h.provider.failNextCreateAmbiguous('m_lost');
    expect((await create()).json()).toMatchObject({ error: { details: { reason: 'uncertain_create' } } });
    expect(h.provider.creates).toHaveLength(2);
    expect((await create()).json()).toMatchObject({ error: { details: { reason: 'uncertain_create' } } });
    expect(h.provider.creates).toHaveLength(2);
    await h.app.close();
  });
  it('creates, writes, runs, screenshots and destroys through authorized routes', async () => {
    const h = await harness();
    const created = await h.app.inject({
      method: 'POST',
      url: `/v1/projects/${h.projectId}/workspace`,
      headers: { ...h.ownerAuth, 'idempotency-key': 'create-1' },
      payload: { sourceRevision: 'abc123' },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as { workspace: { observedState: string; adapterKind: string; sourceRevision: string } };
    expect(body.workspace.observedState).toBe('running');
    expect(body.workspace.adapterKind).toBe('vm');
    expect(body.workspace.sourceRevision).toBe('abc123');
    expect(JSON.stringify(body)).not.toMatch(/m_fake|INSTABOX|stream\.example/);

    const written = await h.app.inject({
      method: 'PUT',
      url: `/v1/projects/${h.projectId}/workspace/file`,
      headers: h.ownerAuth,
      payload: { path: 'src/app.ts', contentBase64: Buffer.from('export const n = 1;\n').toString('base64') },
    });
    expect(written.statusCode).toBe(200);

    const listed = await h.app.inject({
      method: 'GET',
      url: `/v1/projects/${h.projectId}/workspace/files?path=src`,
      headers: h.ownerAuth,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ files: [{ path: 'src/app.ts', type: 'file' }] });

    const command = await h.app.inject({
      method: 'POST',
      url: `/v1/projects/${h.projectId}/workspace/commands`,
      headers: h.ownerAuth,
      payload: { command: 'echo', args: ['ready'], timeoutMs: 5000 },
    });
    expect(command.statusCode).toBe(200);
    const commandBody = command.json() as { command: { commandId: string; state: string; exitCode: number } };
    expect(commandBody.command.state).toBe('succeeded');
    expect(commandBody.command.exitCode).toBe(0);

    const logs = await h.app.inject({
      method: 'GET',
      url: `/v1/projects/${h.projectId}/workspace/commands/${commandBody.command.commandId}/logs?sinceByte=0`,
      headers: h.ownerAuth,
    });
    expect(logs.statusCode).toBe(200);
    expect(String((logs.json() as { logs: string }).logs)).toContain('ready');
    const partialLogs = await h.app.inject({ method: 'GET',
      url: `/v1/projects/${h.projectId}/workspace/commands/${commandBody.command.commandId}/logs?sinceByte=1`,
      headers: h.ownerAuth });
    expect(partialLogs.statusCode).toBe(200);
    expect(partialLogs.json().logs).toBe((logs.json() as { logs: string }).logs.slice(1));
    for (const invalid of ['-1', '1.5', 'NaN', '9007199254740993']) {
      const rejected = await h.app.inject({ method: 'GET',
        url: `/v1/projects/${h.projectId}/workspace/commands/${commandBody.command.commandId}/logs?sinceByte=${invalid}`,
        headers: h.ownerAuth });
      expect(rejected.statusCode).toBe(400);
    }
    const stringBody = await h.app.inject({ method: 'POST', url: `/v1/projects/${h.projectId}/workspace/commands`,
      headers: h.ownerAuth, payload: { command: 'echo', args: ['no'], timeoutMs: '5000' } });
    expect(stringBody.statusCode).toBe(400);

    const shot = await h.app.inject({
      method: 'POST',
      url: `/v1/projects/${h.projectId}/workspace/screenshots`,
      headers: h.ownerAuth,
      payload: {},
    });
    expect(shot.statusCode).toBe(200);
    expect((shot.json() as { contentBase64: string }).contentBase64.length).toBeGreaterThan(8);

    const artifactsBefore = await h.app.inject({ method: 'GET', url: `/v1/projects/${h.projectId}/workspace/artifacts`, headers: h.ownerAuth });
    const frame = await h.app.inject({ method: 'POST', url: `/v1/projects/${h.projectId}/workspace/screenshots`,
      headers: h.ownerAuth, payload: { saveArtifact: false } });
    expect(frame.statusCode).toBe(200);
    expect(frame.json()).toMatchObject({ artifactId: null, contentBase64: expect.any(String) });
    const artifactsAfter = await h.app.inject({ method: 'GET', url: `/v1/projects/${h.projectId}/workspace/artifacts`, headers: h.ownerAuth });
    expect(artifactsAfter.json().artifacts).toEqual(artifactsBefore.json().artifacts);
    const invalidFrame = await h.app.inject({ method: 'POST', url: `/v1/projects/${h.projectId}/workspace/screenshots`,
      headers: h.ownerAuth, payload: { saveArtifact: 'false' } });
    expect(invalidFrame.statusCode).toBe(400);

    const destroyed = await h.app.inject({
      method: 'DELETE',
      url: `/v1/projects/${h.projectId}/workspace`,
      headers: h.ownerAuth,
    });
    expect(destroyed.statusCode).toBe(200);
    const db = new DatabaseSync(path.join(h.dataDir, 'ranger.db'));
    const saved = db.prepare('SELECT relative_path, content FROM workspace_source_files').all() as Array<{
      relative_path: string;
      content: Buffer;
    }>;
    expect(saved.some((row) => row.relative_path === 'src/app.ts')).toBe(true);
    db.close();
    await h.app.close();
  });

  it('rejects a foreign principal and a client-supplied sandbox id', async () => {
    const h = await harness();
    await h.app.inject({
      method: 'POST',
      url: `/v1/projects/${h.projectId}/workspace`,
      headers: h.ownerAuth,
      payload: {},
    });
    const foreign = await h.app.inject({
      method: 'GET',
      url: `/v1/projects/${h.projectId}/workspace/status`,
      headers: h.otherAuth,
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect(JSON.stringify(foreign.json())).not.toContain('m_fake');

    const adopted = await h.app.inject({
      method: 'POST',
      url: `/v1/projects/${h.otherProjectId}/workspace`,
      headers: h.otherAuth,
      payload: { sandboxId: 'm_fake_1', machineId: 'm_fake_1' },
    });
    expect(adopted.statusCode).toBe(400);
    expect(adopted.json()).toMatchObject({ error: { code: 'validation_failed' } });
    expect(h.provider.creates).toHaveLength(1);
    await h.app.close();
  });

  it('rejects pause, resume and restart as unsupported, not success', async () => {
    const h = await harness();
    const pause = await h.app.inject({
      method: 'POST',
      url: `/v1/projects/${h.projectId}/runs/run_00000000-0000-4000-8000-000000000099/pause`,
      headers: h.ownerAuth,
      payload: {},
    });
    expect(pause.statusCode).toBe(501);
    expect(pause.json()).toMatchObject({ error: { code: 'unsupported_operation' } });
    const resume = await h.app.inject({
      method: 'POST',
      url: `/v1/projects/${h.projectId}/runs/run_00000000-0000-4000-8000-000000000099/resume`,
      headers: h.ownerAuth,
      payload: {},
    });
    expect(resume.statusCode).toBe(501);
    expect(resume.json()).toMatchObject({ error: { code: 'unsupported_operation' } });
    await h.app.close();
  });

  it('returns a process handle for a background command and kills a TERM-ignoring descendant', async () => {
    const h = await harness();
    await h.app.inject({
      method: 'POST',
      url: `/v1/projects/${h.projectId}/workspace`,
      headers: h.ownerAuth,
      payload: {},
    });
    const started = await h.app.inject({
      method: 'POST',
      url: `/v1/projects/${h.projectId}/workspace/commands`,
      headers: h.ownerAuth,
      payload: { command: 'sleep', args: ['30'], timeoutMs: 30000, background: true },
    });
    expect(started.statusCode).toBe(200);
    const body = started.json() as { command: { commandId: string; state: string } };
    expect(body.command.state).toBe('running');
    const leader = h.provider.lastBackgroundPid();
    expect(leader).toBeGreaterThan(0);
    h.provider.markTermIgnoring(leader!);
    const stopped = await h.app.inject({
      method: 'POST',
      url: `/v1/projects/${h.projectId}/workspace/commands/${body.command.commandId}/terminate`,
      headers: h.ownerAuth,
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ command: { state: 'terminated' } });
    expect(h.provider.signals.map((signal) => signal.signal)).toEqual(['TERM', 'KILL']);
    await h.app.close();
  });

  it('keeps provider stream material server-side on desktop session create', async () => {
    const h = await harness();
    await h.app.inject({
      method: 'POST',
      url: `/v1/projects/${h.projectId}/workspace`,
      headers: h.ownerAuth,
      payload: {},
    });
    const session = await h.app.inject({
      method: 'POST',
      url: `/v1/projects/${h.projectId}/desktop/sessions`,
      headers: h.ownerAuth,
      payload: { ttlSeconds: 60 },
    });
    expect(session.statusCode).toBe(200);
    const body = session.json() as { session: { gatewayPath: string; sessionId: string } };
    expect(body.session.gatewayPath).toContain('/desktop/sessions/');
    expect(JSON.stringify(body)).not.toContain('stream.example');
    expect(JSON.stringify(body)).not.toContain('BEGIN CERT');
    await h.app.close();
  });
});
