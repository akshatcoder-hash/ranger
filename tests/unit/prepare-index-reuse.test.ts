import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TraceIndexModule from '../../src/retrieval/trace-index.js';
import type * as TracePinModule from '../../src/retrieval/trace-pin.js';
import type * as TraceMcpModule from '../../src/retrieval/trace-mcp.js';

const fakes = vi.hoisted(() => ({
  builds: 0,
  snapshots: new Map<string, string>(),
}));

vi.mock('../../src/retrieval/trace-index.js', async (original) => ({
  ...(await original<typeof TraceIndexModule>()),
  indexMirror: async (options: { mirrorRoot: string }) => {
    fakes.builds += 1;
    const snapshotId = `snapshot-${fakes.builds}`;
    fakes.snapshots.set(options.mirrorRoot, snapshotId);
    return {
      snapshotId,
      commit: null,
      branch: 'main',
      dirty: false,
      indexedAt: new Date().toISOString(),
      embeddingModel: 'fake-model',
      embeddedChunks: 2,
      filesIndexed: 2,
    };
  },
}));

vi.mock('../../src/retrieval/trace-pin.js', async (original) => ({
  ...(await original<typeof TracePinModule>()),
  verifyTracePin: async () => ({ commit: 'pinned', cliPath: 'cli' }),
}));

vi.mock('../../src/retrieval/trace-mcp.js', async (original) => ({
  ...(await original<typeof TraceMcpModule>()),
  TraceMcpClient: {
    spawn: (options: { mirrorRoot: string }) => ({
      initialize: async () => undefined,
      callTool: async () => ({
        isError: false,
        data: { revision: { snapshotId: fakes.snapshots.get(options.mirrorRoot) }, vectorSearch: { available: true } },
      }),
      close: async () => undefined,
      diagnostics: () => '',
    }),
  },
}));

import { loadConfig, type RangerConfig } from '../../src/config.js';
import { openDatabase, withTransaction } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { createConversationRow } from '../../src/conversations/store.js';
import { connectRepository } from '../../src/repositories/store.js';
import { claimNextJob } from '../../src/worker/loop.js';
import { listProjectEvents } from '../../src/events/store.js';
import { SecretResolver } from '../../src/secrets.js';
import { RetrievalService } from '../../src/retrieval/service.js';
import { readIndexState, writeIndexState } from '../../src/retrieval/index-state.js';
import { PREPARE_JOB_TYPE, projectWorkspacePrepHandler, requestProjectWorkspacePrep } from '../../src/workspace/prepare.js';
import { WorkspaceService } from '../../src/workspace/service.js';
import { getWorkspace, listAllSourceFiles } from '../../src/workspace/store.js';
import { setWorkspaceProviderForTests } from '../../src/workspace/runtime.js';
import { FakeInstabox } from '../../src/workspace/fake-provider.js';

/**
 * Warm preparation for ONE project: a recreated VM adopts that project's own
 * ready index, an already-ready request is answered from a fresh validation,
 * and nothing is created, seeded or overwritten in either path. Deterministic
 * Instabox wire model and a recorded Trace runtime; no network, no paid call.
 */

const tempDirs: string[] = [];

beforeEach(() => {
  fakes.builds = 0;
  fakes.snapshots.clear();
});

afterEach(() => {
  setWorkspaceProviderForTests(null);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function commitRepo(baseDir: string): string {
  const root = path.join(baseDir, 'support-app');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  const git = (args: string[]): void => {
    execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  };
  git(['init', '--initial-branch=main']);
  writeFileSync(path.join(root, 'src/calculator.ts'), 'export function addNumbers(a: number, b: number): number {\n  return a + b;\n}\n');
  writeFileSync(path.join(root, 'src/formatter.ts'), 'export const format = (value: number): string => `value=${value}`;\n');
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'init']);
  return `file://${root}`;
}

interface Fixture {
  db: DatabaseSync;
  config: RangerConfig;
  provider: FakeInstabox;
  projectId: string;
  conversationId: string;
  dataDir: string;
}

async function fixture(): Promise<Fixture> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-prep-reuse-'));
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
  const config = await loadConfig({
    RANGER_DATA_DIR: dataDir,
    RANGER_LOG_LEVEL: 'error',
    RANGER_LIVE_BUDGET_FILE: ledger,
    RANGER_APPROVED_SNAPSHOT_ROOTS: dataDir,
  } as NodeJS.ProcessEnv);
  const db = openDatabase(dataDir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Owner' });
  const projectId = createProjectRecord(db, { name: 'Warm', engineerDisplayName: 'Ranger', principalId: owner.principalId }).id;
  const conversationId = createConversationRow(db, projectId, 'call').id;
  await connectRepository(db, projectId, owner.principalId, { url: commitRepo(dataDir), ref: 'main' }, config.approvedSnapshotRoots);
  const provider = new FakeInstabox();
  setWorkspaceProviderForTests(provider);
  return { db, config, provider, projectId, conversationId, dataDir };
}

const readinessOf = (f: Fixture) => (projectId: string) => new RetrievalService({ db: f.db, config: f.config }).readiness(projectId);

/** Request and run one preparation job on a FRESH retrieval service (a worker process). */
async function prepare(f: Fixture, requestId: string): Promise<string> {
  const reference = withTransaction(f.db, () => requestProjectWorkspacePrep(f.db, {
    projectId: f.projectId, conversationId: f.conversationId, sessionId: null, requestId, readiness: readinessOf(f),
  }));
  expect(reference.status).toBe('queued');
  const job = claimNextJob(f.db, [PREPARE_JOB_TYPE], 'worker-test', 60_000)!;
  await projectWorkspacePrepHandler({ db: f.db, config: f.config, retrieval: new RetrievalService({ db: f.db, config: f.config }) })(job);
  f.db.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").run(job.id);
  return job.id;
}

function request(f: Fixture, requestId: string) {
  return withTransaction(f.db, () => requestProjectWorkspacePrep(f.db, {
    projectId: f.projectId, conversationId: f.conversationId, sessionId: null, requestId, readiness: readinessOf(f),
  }));
}

function preparationEvents(f: Fixture): Array<Record<string, unknown>> {
  return listProjectEvents(f.db, f.projectId, { limit: 500 }).events
    .filter((event) => event.type === 'workspace.preparation.updated')
    .map((event) => event.data);
}

async function destroyVm(f: Fixture): Promise<void> {
  await new WorkspaceService({ db: f.db, config: f.config, secrets: SecretResolver.fromConfig(f.config) }).destroy(f.projectId);
}

describe('warm project preparation', () => {
  it('lets a recreated same-project VM adopt the ready index with fresh provenance', async () => {
    const f = await fixture();
    const firstJob = await prepare(f, 'req_1');
    const firstMachine = getWorkspace(f.db, f.projectId)!.machineId;
    const built = readIndexState(f.dataDir, f.projectId)!;
    expect(fakes.builds).toBe(1);
    expect(built.provenance['machineId']).toBe(firstMachine);

    await destroyVm(f);
    const secondJob = await prepare(f, 'req_2');
    const secondMachine = getWorkspace(f.db, f.projectId)!.machineId;

    expect(f.provider.creates).toHaveLength(2);
    expect(secondMachine).not.toBe(firstMachine);
    expect(fakes.builds).toBe(1);
    const adopted = readIndexState(f.dataDir, f.projectId)!;
    expect(adopted.snapshotId).toBe(built.snapshotId);
    expect(adopted.indexedAt).toBe(built.indexedAt);
    expect(adopted.indexElapsedMs).toBe(built.indexElapsedMs);
    expect(adopted.provenance).toMatchObject({ jobId: secondJob, machineId: secondMachine });
    expect(adopted.provenance['jobId']).not.toBe(firstJob);

    const events = preparationEvents(f);
    expect(events.slice(-4).map((data) => data['phase'])).toEqual(['queued', 'preparing', 'indexing', 'ready']);
    const ready = events.at(-1)!;
    expect(ready).toMatchObject({ jobId: secondJob, fileCount: 2, repositoryCommit: adopted.provenance['repositoryCommit'] });
    expect(Number.isInteger(ready['indexElapsedMs'])).toBe(true);
    expect(request(f, 'req_3')).toEqual({ jobId: secondJob, status: 'ready' });
  });

  it('rebuilds on a recreated VM when the recorded indexer is not the pinned one', async () => {
    const f = await fixture();
    await prepare(f, 'req_1');
    writeIndexState(f.dataDir, { ...readIndexState(f.dataDir, f.projectId)!, indexerVersion: 'older-trace' });
    await destroyVm(f);
    await prepare(f, 'req_2');
    expect(fakes.builds).toBe(2);
    expect(readIndexState(f.dataDir, f.projectId)!.indexerVersion).toBe(f.config.providers.tracePinnedCommit);
  });

  it('answers an already-ready request with a fresh truthful event and touches no VM', async () => {
    const f = await fixture();
    const jobId = await prepare(f, 'req_1');
    const before = {
      creates: f.provider.creates.length,
      commands: f.provider.commands.length,
      kills: f.provider.kills.length,
      workspace: getWorkspace(f.db, f.projectId),
      source: listAllSourceFiles(f.db, f.projectId).map((file) => `${file.path}:${file.content.toString('hex')}`),
      builds: fakes.builds,
      jobs: f.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()!['n'],
    };
    const eventsBefore = preparationEvents(f).length;
    const startedAt = Date.now();

    expect(request(f, 'req_again')).toEqual({ jobId, status: 'ready' });

    const events = preparationEvents(f);
    expect(events).toHaveLength(eventsBefore + 1);
    const fresh = events.at(-1)!;
    expect(fresh['phase']).toBe('ready');
    expect(fresh['jobId']).toBe(jobId);
    expect(fresh['fileCount']).toBe(2);
    expect(fresh['byteCount']).toBe(listAllSourceFiles(f.db, f.projectId).reduce((n, file) => n + file.content.byteLength, 0));
    expect(fresh['repositoryCommit']).toMatch(/^[0-9a-f]{40}$/);
    expect(fresh['indexElapsedMs']).toBe(readIndexState(f.dataDir, f.projectId)!.indexElapsedMs);
    expect(Number(fresh['elapsedMs'])).toBeGreaterThanOrEqual(0);
    expect(Number(fresh['elapsedMs'])).toBeLessThanOrEqual(Date.now() - startedAt);

    expect(f.provider.creates).toHaveLength(before.creates);
    expect(f.provider.commands).toHaveLength(before.commands);
    expect(f.provider.kills).toHaveLength(before.kills);
    expect(getWorkspace(f.db, f.projectId)).toEqual(before.workspace);
    expect(listAllSourceFiles(f.db, f.projectId).map((file) => `${file.path}:${file.content.toString('hex')}`)).toEqual(before.source);
    expect(fakes.builds).toBe(before.builds);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()!['n']).toBe(before.jobs);
  });

  it('refuses a ready answer for a missing machine, expired, uncertain or different-revision workspace', async () => {
    const f = await fixture();
    await prepare(f, 'req_1');
    const eventsBefore = preparationEvents(f).length;
    const original = getWorkspace(f.db, f.projectId)!;
    const reset = (): void => {
      f.db.prepare('UPDATE workspaces SET machine_id = ?, deadline_at = ?, uncertain = 0, source_revision = ? WHERE project_id = ?')
        .run(original.machineId, original.deadlineAt, original.sourceRevision, f.projectId);
    };
    const mutations: Array<[string, string, string]> = [
      ['UPDATE workspaces SET machine_id = NULL WHERE project_id = ?', 'workspace_stale', 'missing machine'],
      ["UPDATE workspaces SET machine_id = '' WHERE project_id = ?", 'workspace_stale', 'empty machine'],
      ['UPDATE workspaces SET machine_id = \'vm_other\' WHERE project_id = ?', 'workspace_stale', 'different machine'],
      ['UPDATE workspaces SET deadline_at = 1 WHERE project_id = ?', 'workspace_stale', 'expired'],
      ['UPDATE workspaces SET uncertain = 1 WHERE project_id = ?', 'uncertain_create', 'uncertain'],
      ["UPDATE workspaces SET source_revision = 'deadbeef' WHERE project_id = ?", 'workspace_stale', 'revision mismatch'],
    ];
    for (const [sql, reason, label] of mutations) {
      f.db.prepare(sql).run(f.projectId);
      let caught: unknown;
      try {
        request(f, `req_${label}`);
      } catch (cause) {
        caught = cause;
      }
      expect(caught, label).toMatchObject({ details: { reason } });
      reset();
    }
    expect(preparationEvents(f)).toHaveLength(eventsBefore);
    expect(request(f, 'req_restored').status).toBe('ready');
  });

  it('refuses instead of overwriting when the saved source no longer matches the index', async () => {
    const f = await fixture();
    await prepare(f, 'req_1');
    const edited = Buffer.from('export function addNumbers(): number {\n  return 42; // edited in the guest\n}\n');
    f.db.prepare("UPDATE workspace_source_files SET content = ?, size_bytes = ?, updated_at = updated_at + 1 WHERE relative_path = 'src/calculator.ts'")
      .run(edited, edited.byteLength);
    const commands = f.provider.commands.length;
    const eventsBefore = preparationEvents(f).length;

    expect(() => request(f, 'req_edit')).toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'workspace_stale' }) }));

    const saved = listAllSourceFiles(f.db, f.projectId).find((file) => file.path === 'src/calculator.ts')!;
    expect(saved.content.equals(edited)).toBe(true);
    expect(f.provider.commands).toHaveLength(commands);
    expect(f.provider.creates).toHaveLength(1);
    expect(preparationEvents(f)).toHaveLength(eventsBefore);
  });
});
