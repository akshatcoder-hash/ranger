import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { openDatabase, withTransaction } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { createConversationRow } from '../../src/conversations/store.js';
import { connectRepository } from '../../src/repositories/store.js';
import { createVoiceSessionRow } from '../../src/voice/store.js';
import { enqueueVoiceEngineeringRun } from '../../src/voice/tools.js';
import { claimNextJob } from '../../src/worker/loop.js';
import { PREPARE_JOB_TYPE, projectWorkspacePrepHandler, requestProjectWorkspacePrep, type PrepareRetrieval } from '../../src/workspace/prepare.js';
import { createPlanVersionRow, approvePlanVersionRow } from '../../src/plans/store.js';
import { engineeringRunHandler } from '../../src/runs/executor.js';
import { reconcileInterruptedRuns } from '../../src/runs/reconcile.js';
import type { RetrievalService } from '../../src/retrieval/service.js';
import { getWorkspace } from '../../src/workspace/store.js';
import { setWorkspaceProviderForTests } from '../../src/workspace/runtime.js';
import { FakeInstabox } from '../../src/workspace/instabox.js';
import type { ResponsesCall, ResponsesResult } from '../../src/agent/transport.js';

/**
 * One VM for the whole product flow: the VM created by project preparation
 * serves the approved run. Deterministic Instabox wire model and a scripted
 * coding transport; no network, no paid provider.
 */

const tempDirs: string[] = [];

afterAll(() => {
  setWorkspaceProviderForTests(null);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function commitRepo(baseDir: string): string {
  const root = path.join(baseDir, 'support-app');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  const git = (args: string[]): void => {
    execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  };
  git(['init', '--initial-branch=main']);
  writeFileSync(path.join(root, 'src/calculator.ts'), 'export function addNumbers(a: number, b: number): number {\n  return a + b;\n}\n');
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'init']);
  return `file://${root}`;
}

const indexStub: PrepareRetrieval = {
  assertAvailable: async () => undefined,
  reindexDetailed: async () => ({ fileCount: 1, byteCount: 1, indexElapsedMs: 1 }) as Awaited<ReturnType<PrepareRetrieval['reindexDetailed']>>,
};

function scripted(outputs: Array<Array<Record<string, unknown>>>): { create(call: ResponsesCall): Promise<ResponsesResult> } {
  let turn = 0;
  return {
    create: async (): Promise<ResponsesResult> => {
      const output = outputs[turn++];
      if (output === undefined) throw new Error('unexpected extra provider call');
      return { output, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, responseId: `resp_${turn}` };
    },
  };
}

async function preparedProject(maxLifetimeSeconds: number | null = 600) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-reuse-ws-'));
  tempDirs.push(dataDir);
  const ledger = path.join(dataDir, 'ledger.json');
  writeFileSync(
    ledger,
    JSON.stringify({
      version: 1,
      xai: { limitUsd: 5, softAdmissionUsd: 4, observedUsd: 0, reservedUsd: 0, operations: [] },
      instabox: { maxAdditionalCreations: 9, maxConcurrent: 1, maxLifetimeSeconds, additionalCreations: 0, machines: [], pendingReservations: [] },
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
  const projectId = createProjectRecord(db, { name: 'Reuse', engineerDisplayName: 'Ranger', principalId: owner.principalId }).id;
  const conversationId = createConversationRow(db, projectId, 'call').id;
  await connectRepository(db, projectId, owner.principalId, { url: commitRepo(dataDir), ref: 'main' }, config.approvedSnapshotRoots);
  const sessionId = withTransaction(db, () =>
    createVoiceSessionRow(db, { projectId, conversationId, principalId: owner.principalId, model: 'grok-voice-3.0' }).id,
  );
  const provider = new FakeInstabox();
  setWorkspaceProviderForTests(provider);

  withTransaction(db, () =>
    requestProjectWorkspacePrep(db, { projectId, conversationId, sessionId, requestId: 'req_prep', readiness: () => null }),
  );
  const prepJob = claimNextJob(db, [PREPARE_JOB_TYPE], 'worker-prep', 60_000)!;
  await projectWorkspacePrepHandler({ db, config, retrieval: indexStub })(prepJob);
  db.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").run(prepJob.id);
  const prepared = getWorkspace(db, projectId)!;
  expect(prepared.observedState).toBe('running');
  expect(provider.creates).toHaveLength(1);

  const approvedRun = (repositoryCommit?: string) => {
    const scope = ['edit:src/', 'command'];
    const approval = withTransaction(db, () => {
      const plan = createPlanVersionRow(
        db,
        projectId,
        { items: ['work'], acceptanceCriteria: ['done'], permittedScope: scope, ...(repositoryCommit !== undefined ? { repositoryCommit } : {}) },
        'req_plan',
      ).plan;
      return approvePlanVersionRow(db, projectId, plan.id, { permittedScope: scope, approvedBy: owner.principalId }, 'req_approve').approval;
    });
    return enqueueVoiceEngineeringRun(db, { projectId, conversationId, callId: 'run1', requestId: 'req_run', args: { approvalId: approval.id } });
  };

  const execute = (
    run: { jobId: string; runId: string },
    transport: ReturnType<typeof scripted>,
    retrieval: RetrievalService | null,
  ) =>
    engineeringRunHandler({ db, config, retrieval, transportFactory: () => transport })({
      id: run.jobId,
      type: 'engineering_run',
      payload: { runId: run.runId },
      claimEpoch: 1,
    });

  return { db, provider, projectId, prepared, approvedRun, execute, ledger };
}

const editThenTest = () =>
  scripted([
    [{ type: 'function_call', call_id: 'c1', name: 'edit_file', arguments: JSON.stringify({ path: 'src/integration.ts', content: 'export const ok = true;\n' }) }],
    [{ type: 'function_call', call_id: 'c2', name: 'run_tests', arguments: JSON.stringify({ command: 'echo', args: ['tests-ok'] }) }],
    [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }],
  ]);

/** Retrieval spy: persisted readiness is controlled, indexing calls are recorded. */
function spyRetrieval(readiness: { ready: boolean; provenance: Record<string, string> }) {
  const calls = { reindex: 0, reindexDetailed: [] as Array<Record<string, string> | undefined> };
  const service = {
    readiness: () => ({ ready: readiness.ready, reason: 'stale', state: { provenance: readiness.provenance } }),
    reindex: async () => {
      calls.reindex += 1;
    },
    reindexDetailed: async (_projectId: string, options?: { provenance?: Record<string, string> }) => {
      calls.reindexDetailed.push(options?.provenance);
    },
  } as unknown as RetrievalService;
  return { service, calls };
}

describe('approved run on the prepared workspace', () => {
  it.each([600, null])('reuses the prepared VM with lifetime %s: same machine, deadline, index and provenance', async maxLifetimeSeconds => {
    const f = await preparedProject(maxLifetimeSeconds);
    try {
      await reconcileInterruptedRuns({ db: f.db, provider: f.provider, ledgerFile: f.ledger });
      expect(f.provider.kills).toHaveLength(0);
      if (maxLifetimeSeconds === null) expect(f.prepared.deadlineAt).toBeNull();
      const preparedFile = f.provider.machineFile(f.prepared.machineId!, 'src/calculator.ts');
      expect(preparedFile).toContain('addNumbers');
      // A saved-source change after preparation must NOT be re-written over the live VM.
      f.db.prepare("UPDATE workspace_source_files SET content = ? WHERE relative_path = 'src/calculator.ts'").run(Buffer.from('saved-copy\n'));

      const provenance = { repositoryCommit: f.prepared.sourceRevision!, jobId: 'job_prep', machineId: f.prepared.machineId! };
      const spy = spyRetrieval({ ready: true, provenance });
      const run = f.approvedRun(f.prepared.sourceRevision!);
      await f.execute(run, editThenTest(), spy.service);

      expect(f.db.prepare('SELECT state FROM runs WHERE id = ?').get(run.runId)).toMatchObject({ state: 'succeeded' });
      expect(f.provider.creates).toHaveLength(1);
      expect(f.provider.kills).toHaveLength(0);
      // The pre-run index step never rewrote the ready index (which would erase provenance).
      expect(spy.calls.reindex).toBe(0);
      expect(spy.calls.reindexDetailed).toEqual([]);

      const after = getWorkspace(f.db, f.projectId)!;
      expect(after).toMatchObject({ observedState: 'running', destroyedAt: null, machineId: f.prepared.machineId, deadlineAt: f.prepared.deadlineAt });
      expect(f.provider.machineFile(f.prepared.machineId!, 'src/integration.ts')).toBe('export const ok = true;\n');
      expect(f.provider.machineFile(f.prepared.machineId!, 'src/calculator.ts')).toBe(preparedFile);
    } finally {
      f.db.close();
    }
  }, 60_000);

  it('reindexes a changed saved source on reuse with the original provenance', async () => {
    const f = await preparedProject();
    try {
      const provenance = { repositoryCommit: f.prepared.sourceRevision!, jobId: 'job_prep', machineId: f.prepared.machineId! };
      const spy = spyRetrieval({ ready: false, provenance });
      const run = f.approvedRun();
      await f.execute(run, editThenTest(), spy.service);

      expect(f.db.prepare('SELECT state FROM runs WHERE id = ?').get(run.runId)).toMatchObject({ state: 'succeeded' });
      expect(f.provider.creates).toHaveLength(1);
      expect(spy.calls.reindex).toBe(0);
      expect(spy.calls.reindexDetailed).toEqual([provenance]);
    } finally {
      f.db.close();
    }
  }, 60_000);

  it('rejects a running workspace at a different revision than the approved plan: no extra create, no guest work', async () => {
    const f = await preparedProject();
    try {
      const transport = scripted([]);
      const spy = spyRetrieval({ ready: true, provenance: {} });
      const run = f.approvedRun('f'.repeat(40));
      await f.execute(run, transport, spy.service);

      expect(f.db.prepare('SELECT state, failure_code FROM runs WHERE id = ?').get(run.runId)).toMatchObject({
        state: 'failed',
        failure_code: 'workspace_revision_mismatch',
      });
      expect(f.provider.creates).toHaveLength(1);
      expect(f.provider.machineFile(f.prepared.machineId!, 'src/integration.ts')).toBeNull();
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM run_tool_outcomes').get()).toMatchObject({ n: 0 });
      expect(spy.calls.reindex + spy.calls.reindexDetailed.length).toBe(0);
    } finally {
      f.db.close();
    }
  }, 60_000);
});
