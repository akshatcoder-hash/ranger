import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, type RangerConfig } from '../../src/config.js';
import { openDatabase, withTransaction } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createPrincipal } from '../../src/auth/principals.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { createConversationRow } from '../../src/conversations/store.js';
import { connectRepository } from '../../src/repositories/store.js';
import { createVoiceSessionRow } from '../../src/voice/store.js';
import { runVoiceWorkspaceTool, VOICE_TOOLS } from '../../src/voice/tools.js';
import { RetrievalService } from '../../src/retrieval/service.js';
import { claimNextJob } from '../../src/worker/loop.js';
import { PREPARE_JOB_TYPE, projectWorkspacePrepHandler, type PrepareRetrieval } from '../../src/workspace/prepare.js';
import { listAllSourceFiles } from '../../src/workspace/store.js';
import { setWorkspaceProviderForTests } from '../../src/workspace/runtime.js';
import { FakeInstabox } from '../../src/workspace/instabox.js';
import { listProjectEvents } from '../../src/events/store.js';
import { createPlanVersionRow, approvePlanVersionRow } from '../../src/plans/store.js';
import { enqueueVoiceEngineeringRun } from '../../src/voice/tools.js';

/**
 * Voice preparation smoke: tool enqueue (fast, deduplicated) -> durable
 * worker job (one create -> seed -> real Trace index) -> a FRESH retrieval
 * service (the API process) answers grounded, cited queries from the
 * worker-built index. Deterministic Instabox wire model; real pinned Trace.
 * Failure paths stop before/after the create with owned-VM cleanup.
 */

const LONG = 300_000;
const tempDirs: string[] = [];
const indexDirs: string[] = [];

afterAll(() => {
  setWorkspaceProviderForTests(null);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  for (const dir of indexDirs) if (dir.includes('ranger-cache') || dir.includes('.cache')) rmSync(dir, { recursive: true, force: true });
});

function expectedIndexDir(mirrorRoot: string, traceHome: string): string {
  const label = path.basename(mirrorRoot).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'repo';
  const key = createHash('sha256').update(path.resolve(mirrorRoot)).digest('hex').slice(0, 12);
  return path.join(traceHome, 'indexes', `${label}-${key}`);
}

function commitRepo(baseDir: string): { url: string } {
  const root = path.join(baseDir, 'support-app');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  const git = (args: string[]): void => {
    execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  };
  git(['init', '--initial-branch=main']);
  writeFileSync(path.join(root, 'src/calculator.ts'), 'export function addNumbers(a: number, b: number): number {\n  return a + b;\n}\n');
  writeFileSync(path.join(root, 'src/formatter.ts'), 'export class ResultFormatter {\n  format(value: number): string {\n    return `value=${value}`;\n  }\n}\n');
  writeFileSync(path.join(root, '.env'), 'API_KEY=abcdefghijklmnop123456\n');
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'init']);
  return { url: `file://${root}` };
}

interface Fixture {
  db: DatabaseSync;
  config: RangerConfig;
  provider: FakeInstabox;
  projectId: string;
  otherProjectId: string;
  conversationId: string;
  sessionId: string;
  ownerId: string;
  otherId: string;
}

async function fixture(options: { repoUrl?: string } = {}): Promise<Fixture> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-voice-prep-'));
  tempDirs.push(dataDir);
  const ledger = path.join(dataDir, 'ledger.json');
  writeFileSync(
    ledger,
    JSON.stringify({
      version: 1,
      xai: { limitUsd: 5, softAdmissionUsd: 4, observedUsd: 0, reservedUsd: 0, operations: [] },
      instabox: { maxAdditionalCreations: 9, maxConcurrent: 1, maxLifetimeSeconds: 600, additionalCreations: 0, machines: [], pendingReservations: [] },
    }),
  );
  const repo = options.repoUrl === undefined ? commitRepo(dataDir) : { url: options.repoUrl };
  const config = await loadConfig({
    RANGER_DATA_DIR: dataDir,
    RANGER_LOG_LEVEL: 'error',
    RANGER_LIVE_BUDGET_FILE: ledger,
    RANGER_APPROVED_SNAPSHOT_ROOTS: dataDir,
  } as NodeJS.ProcessEnv);
  const db = openDatabase(dataDir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Owner' });
  const other = createPrincipal(db, 'Other');
  const project = createProjectRecord(db, { name: 'Voice prep', engineerDisplayName: 'Ranger', principalId: owner.principalId });
  const otherProject = createProjectRecord(db, { name: 'Other', engineerDisplayName: 'Ranger', principalId: other.id });
  const conversationId = createConversationRow(db, project.id, 'call').id;
  await connectRepository(db, project.id, owner.principalId, { url: repo.url, ref: 'main' }, config.approvedSnapshotRoots);
  const sessionId = withTransaction(db, () =>
    createVoiceSessionRow(db, { projectId: project.id, conversationId, principalId: owner.principalId, model: 'grok-voice-3.0' }).id,
  );
  const provider = new FakeInstabox();
  setWorkspaceProviderForTests(provider);
  indexDirs.push(expectedIndexDir(path.join(dataDir, 'retrieval-mirrors', project.id), config.providers.traceHome));
  return {
    db,
    config,
    provider,
    projectId: project.id,
    otherProjectId: otherProject.id,
    conversationId,
    sessionId,
    ownerId: owner.principalId,
    otherId: other.id,
  };
}

function tool(f: Fixture, retrieval: RetrievalService | null, name: string, callId: string, args: unknown, principalId = f.ownerId) {
  return runVoiceWorkspaceTool(name, {
    db: f.db,
    retrieval,
    projectId: f.projectId,
    conversationId: f.conversationId,
    sessionId: f.sessionId,
    principalId,
    callId,
    requestId: `req_${callId}`,
    args,
  });
}

async function runPrepJob(f: Fixture, retrieval: PrepareRetrieval): Promise<void> {
  const job = claimNextJob(f.db, [PREPARE_JOB_TYPE], 'worker-test', 60_000);
  expect(job).not.toBeNull();
  await projectWorkspacePrepHandler({ db: f.db, config: f.config, retrieval })(job!);
  f.db.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").run(job!.id);
}

function phases(f: Fixture): Array<Record<string, unknown>> {
  return listProjectEvents(f.db, f.projectId, { limit: 500 })
    .events.filter((event) => event.type === 'workspace.preparation.updated')
    .map((event) => event.data);
}

const stubRetrieval: PrepareRetrieval = {
  assertAvailable: async () => undefined,
  reindexDetailed: async () => {
    throw new Error('index must not be reached');
  },
};

describe('voice project preparation (worker index -> fresh API retrieval)', () => {
  it('enqueues fast and deduplicated, prepares one VM, and a fresh service answers with citations', { timeout: LONG }, async () => {
    const f = await fixture();
    expect(VOICE_TOOLS.map((t) => t.name)).toEqual([
      'request_engineering_run',
      'prepare_project_workspace',
      'search_project_code',
      'read_project_source',
      'inspect_shared_screen',
      'get_project_status',
      'draft_project_plan',
    ]);
    const api = new RetrievalService({ db: f.db, config: f.config });

    // Not ready before preparation: honest refusal, no fake answer.
    await expect(tool(f, api, 'search_project_code', 'c0', { query: 'addNumbers' })).rejects.toMatchObject({
      details: { reason: 'project_index_not_ready' },
    });

    const started = Date.now();
    const first = await tool(f, api, 'prepare_project_workspace', 'c1', {});
    expect(Date.now() - started).toBeLessThan(1000);
    expect(first.output['status']).toBe('queued');
    const replay = await tool(f, api, 'prepare_project_workspace', 'c1', {});
    expect(replay.replayed).toBe(true);
    expect(replay.output['jobId']).toBe(first.output['jobId']);
    const second = await tool(f, api, 'prepare_project_workspace', 'c2', {});
    expect(second.output['jobId']).toBe(first.output['jobId']);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE type = ?').get(PREPARE_JOB_TYPE)).toMatchObject({ n: 1 });
    await expect(tool(f, api, 'prepare_project_workspace', 'c3', { projectId: 'prj_other' })).rejects.toMatchObject({ code: 'validation_failed' });

    // The worker (a separate retrieval instance) does the VM + index work.
    await runPrepJob(f, new RetrievalService({ db: f.db, config: f.config }));
    expect(f.provider.creates).toHaveLength(1);
    expect(f.provider.kills, JSON.stringify(phases(f))).toHaveLength(0);
    const seen = phases(f);
    expect(seen.map((data) => data['phase'])).toEqual(['queued', 'preparing', 'indexing', 'ready']);
    const ready = seen[3]!;
    expect(ready['jobId']).toBe(first.output['jobId']);
    expect(ready['fileCount']).toBe(3);
    expect(ready['byteCount']).toBe(listAllSourceFiles(f.db, f.projectId).reduce((n, file) => n + file.content.byteLength, 0));
    expect(Number(ready['indexElapsedMs'])).toBeGreaterThan(0);
    expect(String(ready['repositoryCommit'])).toMatch(/^[0-9a-f]{40}$/);

    // A FRESH API retrieval service reads the worker-created index.
    const fresh = new RetrievalService({ db: f.db, config: f.config });
    expect(fresh.status(f.projectId).indexed).toBe(true);
    const found = await tool(f, fresh, 'search_project_code', 'c4', { query: 'addNumbers', limit: 3 });
    const results = found.output['results'] as Array<{ filePath: string; citation: { snapshotId: string; contentHash: string } }>;
    expect(found.output['provider']).toBe('trace');
    expect(results[0]!.filePath).toBe('src/calculator.ts');
    expect(results[0]!.citation.snapshotId).toBe(found.output['snapshotId']);
    expect(found.output['repositoryCommit']).toBe(ready['repositoryCommit']);
    expect(JSON.stringify(found.output)).not.toContain('abcdefghijklmnop');

    const read = await tool(f, fresh, 'read_project_source', 'c5', { path: 'src/calculator.ts', startLine: 1, endLine: 3 });
    expect(String(read.output['content'])).toContain('addNumbers');
    await expect(tool(f, fresh, 'read_project_source', 'c6', { path: '.env', startLine: 1, endLine: 1 })).rejects.toMatchObject({
      details: { reason: 'sensitive_path' },
    });

    // Another principal is denied; another project has no index.
    await expect(tool(f, fresh, 'search_project_code', 'c7', { query: 'addNumbers' }, f.otherId)).rejects.toMatchObject({ code: 'forbidden' });
    const crossProject = await runVoiceWorkspaceTool('search_project_code', {
      db: f.db,
      retrieval: fresh,
      projectId: f.otherProjectId,
      conversationId: f.conversationId,
      sessionId: f.sessionId,
      principalId: f.otherId,
      callId: 'c8',
      requestId: 'req_c8',
      args: { query: 'addNumbers' },
    }).catch((cause: unknown) => cause);
    expect(crossProject).toMatchObject({ details: { reason: 'project_index_not_ready' } });

    // Repeat prepare reuses the ready VM + matching index: no second create.
    const again = await tool(f, fresh, 'prepare_project_workspace', 'c9', {});
    expect(again.output).toEqual({ jobId: first.output['jobId'], status: 'ready' });
    expect(f.provider.creates).toHaveLength(1);

    // A source change makes readiness stale; the repeat call is an explicit refusal.
    f.db.prepare("UPDATE workspace_source_files SET content = ?, updated_at = updated_at + 1 WHERE relative_path = 'src/calculator.ts'").run(Buffer.from('changed\n'));
    await expect(tool(f, fresh, 'search_project_code', 'c10', { query: 'addNumbers' })).rejects.toMatchObject({
      details: { reason: 'project_index_not_ready', indexState: 'stale' },
    });
    await expect(tool(f, fresh, 'prepare_project_workspace', 'c11', {})).rejects.toMatchObject({ details: { reason: 'workspace_stale' } });
    expect(f.provider.creates).toHaveLength(1);
    expect(existsSync(indexDirs[indexDirs.length - 1]!)).toBe(true);
  });

  it('fails before any VM when the repository is reference-only', { timeout: LONG }, async () => {
    const f = await fixture({ repoUrl: 'https://example.invalid/acme/app.git' });
    const api = new RetrievalService({ db: f.db, config: f.config });
    await tool(f, api, 'prepare_project_workspace', 'r1', {});
    await runPrepJob(f, stubRetrieval);
    expect(f.provider.creates).toHaveLength(0);
    const last = phases(f).at(-1)!;
    expect(last).toMatchObject({ phase: 'failed', errorCode: 'initial_source_unmaterializable' });
  });

  it('destroys the owned VM when seeding fails and never indexes', { timeout: LONG }, async () => {
    const f = await fixture();
    const api = new RetrievalService({ db: f.db, config: f.config });
    await tool(f, api, 'prepare_project_workspace', 's1', {});
    f.provider.failNextWrite('disk full');
    await runPrepJob(f, stubRetrieval);
    expect(f.provider.creates).toHaveLength(1);
    expect(f.provider.kills).toHaveLength(1);
    expect(phases(f).at(-1)).toMatchObject({ phase: 'failed', errorCode: 'guest_write_failed' });
    expect(f.db.prepare('SELECT observed_state FROM workspaces WHERE project_id = ?').get(f.projectId)).toMatchObject({ observed_state: 'destroyed' });
  });

  it('leaves the exact-approval engineering gate unchanged', async () => {
    const f = await fixture();
    expect(() =>
      enqueueVoiceEngineeringRun(f.db, {
        projectId: f.projectId,
        conversationId: f.conversationId,
        callId: 'e1',
        requestId: 'req_e1',
        args: { approvalId: 'apr_00000000-0000-0000-0000-000000000000' },
      }),
    ).toThrow(/does not exist/);
    void createPlanVersionRow;
    void approvePlanVersionRow;
  });
});
