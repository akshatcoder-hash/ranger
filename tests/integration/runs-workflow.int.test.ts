import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/db.js';
import { loadConfig, type RangerConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApiServer } from '../../src/http/app.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { setWorkspaceProviderForTests } from '../../src/workspace/runtime.js';
import { FakeInstabox } from '../../src/workspace/instabox.js';
import { setPlanningTransportForTests } from '../../src/planning/runtime.js';
import type { ResponsesCall, ResponsesResult } from '../../src/agent/transport.js';
import type { RangerProjectEvent } from '../../src/contracts/types.js';
import { insertRunToolOutcome } from '../../src/runs/store.js';

/**
 * Approved-run workflow integration tests over the PUBLIC API with real
 * SQLite and the deterministic Instabox wire model. The xAI transport is a
 * scripted protocol mock (explicitly NOT live evidence): live planning,
 * injection and coding evidence is collected once in the reserved customer
 * window, not here.
 */


const tempDirs: string[] = [];

interface ScriptStep {
  output?: Array<Record<string, unknown>>;
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number };
  delayMs?: number;
}

function functionCallItem(name: string, args: unknown, callId: string): Record<string, unknown> {
  return { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) };
}

function messageItem(text: string): Record<string, unknown> {
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
}

/** Scripted Responses protocol transport (deterministic; fails on extra calls). */
function scriptedTransport(steps: ScriptStep[]): {
  transport: { create(call: ResponsesCall): Promise<ResponsesResult> };
  calls: ResponsesCall[];
} {
  const calls: ResponsesCall[] = [];
  return {
    calls,
    transport: {
      create: async (call): Promise<ResponsesResult> => {
        calls.push(call);
        const step = steps[calls.length - 1];
        if (step === undefined) throw new Error('protocol mock: unexpected extra provider call');
        if (step.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
        const usage = step.usage ?? { inputTokens: 1000, outputTokens: 500 };
        return {
          output: step.output ?? [],
          usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens },
          responseId: `resp_mock_${calls.length}`,
        };
      },
    },
  };
}

interface TestHarness {
  dataDir: string;
  ledgerFile: string;
  app: FastifyInstance;
  db: DatabaseSync;
  config: RangerConfig;
  provider: FakeInstabox;
  bearer: Record<string, string>;
  projectId: string;
  conversationId: string;
  requirementId: string;
  close: () => void;
}

async function openHarness(env: Record<string, string> = {}): Promise<TestHarness> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-runs-int-'));
  tempDirs.push(dataDir);
  const ledgerFile = path.join(dataDir, 'ledger.json');
  writeFileSync(
    ledgerFile,
    JSON.stringify({
      version: 1,
      xai: { limitUsd: 5, softAdmissionUsd: 4, observedUsd: 0, reservedUsd: 0, operations: [] },
      instabox: {
        maxAdditionalCreations: 9,
        maxConcurrent: 1,
        maxLifetimeSeconds: 600,
        additionalCreations: 0,
        machines: [],
        pendingReservations: [],
      },
    }),
  );
  const config = await loadConfig({
    RANGER_DATA_DIR: dataDir,
    RANGER_LOG_LEVEL: 'error',
    RANGER_LIVE_BUDGET_FILE: ledgerFile,
    ...env,
  } as NodeJS.ProcessEnv);
  const db = openDatabase(dataDir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Runs Driver' });
  const app = await buildApiServer({ config, db });
  const provider = new FakeInstabox();
  setWorkspaceProviderForTests(provider);
  const bearer = { authorization: `Bearer ${readFileSync(owner.credentialPath, 'utf8').trim().split('=')[1]!}` };
  return {
    dataDir,
    ledgerFile,
    app,
    db,
    config,
    provider,
    bearer,
    projectId: '',
    conversationId: '',
    requirementId: '',
    close: () => {
      app.close();
      // The restart-persistence test closes the DB itself; teardown is idempotent.
      try {
        db.close();
      } catch (cause) {
        if (!(cause instanceof Error) || !/not open/.test(cause.message)) throw cause;
      }
      setWorkspaceProviderForTests(null);
      setPlanningTransportForTests(null);
    },
  };
}

/** Drive the persisted clarification -> answers -> plan -> approval -> run flow. */
async function seedConversation(h: TestHarness, request: string): Promise<void> {
  const project = await h.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: h.bearer,
    payload: { name: 'Support integration', engineerDisplayName: 'Ranger' },
  });
  h.projectId = (project.json() as { project: { projectId: string } }).project.projectId;
  const conversation = await h.app.inject({
    method: 'POST',
    url: `/v1/projects/${h.projectId}/conversations`,
    headers: h.bearer,
    payload: { title: 'Initial request' },
  });
  h.conversationId = (conversation.json() as { conversation: { conversationId: string } }).conversation.conversationId;
  await h.app.inject({
    method: 'POST',
    url: `/v1/projects/${h.projectId}/conversations/${h.conversationId}/messages`,
    headers: h.bearer,
    payload: { role: 'user', content: request },
  });
  const requirement = await h.app.inject({
    method: 'POST',
    url: `/v1/projects/${h.projectId}/requirements`,
    headers: h.bearer,
    payload: { content: request },
  });
  h.requirementId = (requirement.json() as { requirement: { requirementId: string } }).requirement.requirementId;
}

async function planAndApprove(h: TestHarness, scope: string[]): Promise<{ planId: string; approvalId: string; version: number }> {
  const clarification = await h.app.inject({
    method: 'POST',
    url: `/v1/projects/${h.projectId}/conversations/${h.conversationId}/clarification`,
    headers: h.bearer,
    payload: {},
  });
  expect(clarification.statusCode, clarification.body).toBe(200);
  const questions = (clarification.json() as { questions: Array<{ questionId: string }> }).questions;
  for (const question of questions) {
    const answer = await h.app.inject({
      method: 'POST',
      url: `/v1/projects/${h.projectId}/conversations/${h.conversationId}/questions/${question.questionId}/answers`,
      headers: h.bearer,
      payload: { content: 'Use the synthetic fixtures; never issue a refund without a human confirmation.' },
    });
    expect(answer.statusCode, answer.body).toBe(200);
  }
  const generated = await h.app.inject({
    method: 'POST',
    url: `/v1/projects/${h.projectId}/plans/generate`,
    headers: h.bearer,
    payload: { conversationId: h.conversationId },
  });
  expect(generated.statusCode, generated.body).toBe(200);
  const plan = (generated.json() as { plan: { planId: string; version: number } }).plan;
  const approved = await h.app.inject({
    method: 'POST',
    url: `/v1/projects/${h.projectId}/plans/${plan.planId}/approvals`,
    headers: h.bearer,
    payload: { permittedScope: scope },
  });
  expect(approved.statusCode, approved.body).toBe(200);
  return { planId: plan.planId, approvalId: (approved.json() as { approval: { approvalId: string } }).approval.approvalId, version: plan.version };
}

async function allEvents(h: TestHarness): Promise<RangerProjectEvent[]> {
  const response = await h.app.inject({
    method: 'GET',
    url: `/v1/projects/${h.projectId}/events`,
    headers: h.bearer,
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { events: RangerProjectEvent[] }).events;
}

/** Connect a repository through the public API (the same path the live driver uses). */
async function connectRepositoryViaApi(h: TestHarness, url: string, ref = 'main'): Promise<{ status: number; commit: string | null }> {
  const response = await h.app.inject({
    method: 'PUT',
    url: `/v1/projects/${h.projectId}/repository`,
    headers: h.bearer,
    payload: { url, ref },
  });
  const body = response.json() as { repository?: { commit?: string } };
  return { status: response.statusCode, commit: body.repository?.commit ?? null };
}

/** Create a plan and approval directly (deterministic; no planning transport). */
async function planAndApproveDirectly(h: TestHarness, scope: string[]): Promise<string> {
  const plan = await h.app.inject({
    method: 'POST',
    url: `/v1/projects/${h.projectId}/plans`,
    headers: h.bearer,
    payload: { items: ['work'], acceptanceCriteria: ['done'], permittedScope: scope },
  });
  expect(plan.statusCode, plan.body).toBe(200);
  const planId = (plan.json() as { plan: { planId: string } }).plan.planId;
  const approved = await h.app.inject({
    method: 'POST',
    url: `/v1/projects/${h.projectId}/plans/${planId}/approvals`,
    headers: h.bearer,
    payload: { permittedScope: scope },
  });
  expect(approved.statusCode, approved.body).toBe(200);
  return (approved.json() as { approval: { approvalId: string } }).approval.approvalId;
}

/** Invoke the engineering-run handler directly and return the terminal run row. */
async function runHandlerToTerminal(
  h: TestHarness,
  runId: string,
  coding: { create(call: ResponsesCall): Promise<ResponsesResult> },
): Promise<{ state: string; failureCode: string | null }> {
  const { engineeringRunHandler } = await import('../../src/runs/executor.js');
  const job = h.db.prepare('SELECT job_id FROM runs WHERE id = ?').get(runId) as { job_id: string };
  await engineeringRunHandler({ db: h.db, config: h.config, retrieval: null, transportFactory: () => coding })({
    id: job.job_id,
    type: 'engineering_run',
    payload: { runId },
    claimEpoch: 1,
  });
  const run = h.db.prepare('SELECT state, failure_code FROM runs WHERE id = ?').get(runId) as {
    state: string;
    failure_code: string | null;
  };
  return { state: run.state, failureCode: run.failure_code };
}

async function startRun(h: TestHarness, approvalId: string, key: string): Promise<string> {
  const started = await h.app.inject({
    method: 'POST',
    url: `/v1/projects/${h.projectId}/runs`,
    headers: { ...h.bearer, 'idempotency-key': key },
    payload: { conversationId: h.conversationId, approvalId },
  });
  expect(started.statusCode, started.body).toBe(200);
  return (started.json() as { run: { runId: string } }).run.runId;
}

describe('approved run workflow (deterministic providers, public API)', () => {
  it('keeps tool evidence readable when one historical result was truncated or is not an object', async () => {
    const h = await openHarness();
    try {
      await seedConversation(h, 'Inspect saved execution results.');
      const approval = await planAndApproveDirectly(h, ['command']);
      const runId = await startRun(h, approval, 'read-evidence-only');
      insertRunToolOutcome(h.db, { runId, callId: 'valid-result', name: 'edit_file', status: 'ok', resultJson: JSON.stringify({ path: 'src/greeting.ts', saved: true }), error: null });
      for (const [index, json] of ['{"logs":"truncated', 'null', '[]'].entries()) {
        insertRunToolOutcome(h.db, { runId, callId: `invalid-${index}`, name: 'run_tests', status: 'ok', resultJson: json, error: null });
      }
      const response = await h.app.inject({ method: 'GET', url: `/v1/projects/${h.projectId}/runs/${runId}/tools`, headers: h.bearer });
      expect(response.statusCode, response.body).toBe(200);
      const tools = response.json().tools as Array<{ callId: string; result: Record<string, unknown> }>;
      expect(tools.find(tool => tool.callId === 'valid-result')?.result).toEqual({ path: 'src/greeting.ts', saved: true });
      expect(tools.filter(tool => tool.callId.startsWith('invalid-')).map(tool => tool.result)).toEqual(Array(3).fill({ evidenceUnavailable: true, reason: 'stored_result_invalid' }));
      expect(h.db.prepare('SELECT COUNT(*) AS c FROM workspaces').get()).toMatchObject({ c: 0 });
    } finally { h.close(); rmSync(h.dataDir, { recursive: true, force: true }); }
  });

  it('rejects a run started before any approval with the standard envelope and no job', async () => {
    const h = await openHarness();
    try {
      setPlanningTransportForTests(() => {
        throw new Error('planning must not be reached in this test');
      });
      await seedConversation(h, 'When a ticket arrives, look up the order and draft a reply using our refund policy.');
      const response = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/runs`,
        headers: h.bearer,
        payload: { conversationId: h.conversationId, approvalId: 'apr_00000000-0000-4000-8000-000000000000' },
      });
      expect(response.statusCode, response.body).toBe(404);
      const body = response.json() as { requestId: string; error: { code: string } };
      expect(body.error.code).toBe('not_found');
      const jobs = h.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number };
      expect(jobs.n).toBe(0);
    } finally {
      h.close();
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });

  it('plans, approves an exact version, starts one run idempotently and executes it to success', async () => {
    const planning = scriptedTransport([
      { output: [messageItem(JSON.stringify({ questions: ['Which HTTP framework should the integration use?', 'Where does the order service live?'] }))] },
      {
        output: [
          messageItem(
            JSON.stringify({
              items: ['Add order lookup to the inbox handler', 'Draft replies from the refund policy', 'Gate refunds behind human confirmation'],
              acceptanceCriteria: ['A ticket triggers an order lookup', 'Refunds wait for human confirmation'],
              permittedScope: ['edit:src/', 'command', 'launch', 'evidence'],
              decisions: ['Use the existing HTTP server style', 'Refunds require explicit human approval'],
            }),
          ),
        ],
      },
    ]);
    setPlanningTransportForTests(() => planning.transport);
    const h = await openHarness();
    try {
      await seedConversation(h, 'When a ticket arrives, look up the order, draft a reply using our refund policy, and ask a human before any refund.');

      // Public reads of questions with their answers (each answer references
      // the exact question it answers).
      const listed = await h.app.inject({
        method: 'GET',
        url: `/v1/projects/${h.projectId}/conversations/${h.conversationId}/questions`,
        headers: h.bearer,
      });
      expect(listed.statusCode, listed.body).toBe(200);

      const { planId, approvalId } = await planAndApprove(h, ['edit:src/', 'command', 'launch', 'evidence']);
      expect(planId).toMatch(/^pln_/);
      expect(approvalId).toMatch(/^apr_/);

      // Decisions persisted as versioned threads and publicly readable.
      const decisions = await h.app.inject({
        method: 'GET',
        url: `/v1/projects/${h.projectId}/decisions`,
        headers: h.bearer,
      });
      expect((decisions.json() as { decisions: Array<{ currentVersion: number }> }).decisions.length).toBeGreaterThanOrEqual(1);

      // Start the run; the duplicate with the same key replays one run.
      const startKey = { 'idempotency-key': 'start-run-once' };
      const first = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/runs`,
        headers: { ...h.bearer, ...startKey },
        payload: { conversationId: h.conversationId, approvalId },
      });
      expect(first.statusCode, first.body).toBe(200);
      const runId = (first.json() as { run: { runId: string } }).run.runId;
      const replay = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/runs`,
        headers: { ...h.bearer, ...startKey },
        payload: { conversationId: h.conversationId, approvalId },
      });
      expect(replay.statusCode).toBe(200);
      expect((replay.json() as { run: { runId: string } }).run.runId).toBe(runId);
      const runs = h.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number };
      expect(runs.n).toBe(1);
      const jobs = h.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'engineering_run'").get() as { n: number };
      expect(jobs.n).toBe(1);

      // A second start while the run is active is refused.
      const second = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/runs`,
        headers: h.bearer,
        payload: { conversationId: h.conversationId, approvalId },
      });
      expect(second.statusCode).toBe(409);
      expect((second.json() as { error: { details?: { reason?: string } } }).error.details?.reason).toBe('run_already_active');

      // Execute the run in-process with a scripted coding loop: edit a file,
      // run the tests (real exit code), then stop.
      const coding = scriptedTransport([
        { output: [functionCallItem('edit_file', { path: 'src/integration.ts', content: 'export const integration = true;\n' }, 'call_1')] },
        { output: [functionCallItem('run_tests', { command: 'echo', args: ['tests-ok'] }, 'call_2')] },
        { output: [messageItem('Integration complete; tests passed.')] },
      ]);
      const { engineeringRunHandler } = await import('../../src/runs/executor.js');
      const { WorkerLoop } = await import('../../src/worker/loop.js');
      const handler = engineeringRunHandler({
        db: h.db,
        config: h.config,
        retrieval: null,
        transportFactory: () => coding.transport,
      });
      const loop = new WorkerLoop(h.db, new Map([['engineering_run', handler]]), {
        pollMs: 25,
        leaseMs: 60_000,
        workerId: 'worker-test',
        logger: { info: () => undefined, error: () => undefined },
      });
      loop.start();
      const deadline = Date.now() + 30_000;
      let run: { state: string; failure_code: string | null; usage_json: string | null; turns: number | null } | undefined;
      for (;;) {
        run = h.db.prepare('SELECT state, failure_code, usage_json, turns FROM runs WHERE id = ?').get(runId) as
          | { state: string; failure_code: string | null; usage_json: string | null; turns: number | null }
          | undefined;
        if (run !== undefined && ['succeeded', 'failed', 'cancelled'].includes(run.state)) break;
        if (Date.now() > deadline) throw new Error(`run never reached a terminal state: ${JSON.stringify(run)}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await loop.stop();
      expect(run!.state).toBe('succeeded');
      expect(run!.usage_json).toContain('inputTokens');

      // Durable tool records with real outcomes, readable through the API.
      const tools = await h.app.inject({ method: 'GET', url: `/v1/projects/${h.projectId}/runs/${runId}/tools`, headers: h.bearer });
      expect(tools.statusCode, tools.body).toBe(200);
      const toolRows = (tools.json() as { tools: Array<{ name: string; status: string }> }).tools;
      expect(toolRows.map((t) => `${t.name}:${t.status}`)).toEqual(['edit_file:ok', 'run_tests:ok']);

      // The test outcome came from the real exit code, not model prose.
      const tests = await h.app.inject({ method: 'GET', url: `/v1/projects/${h.projectId}/workspace/test-results`, headers: h.bearer });
      const testRows = (tests.json() as { testResults: Array<{ exitCode: number }> }).testResults;
      expect(testRows.length).toBeGreaterThanOrEqual(1);
      expect(testRows.every((t) => t.exitCode === 0)).toBe(true);

      // Saved source and diff persist outside the VM.
      const diff = await h.app.inject({ method: 'GET', url: `/v1/projects/${h.projectId}/workspace/diff`, headers: h.bearer });
      expect((diff.json() as { changedFiles: string[] }).changedFiles).toContain('src/integration.ts');

      // Events: state transitions plus per-tool progress, no pause claims.
      const events = await allEvents(h);
      const stateEvents = events.filter((e) => e.type === 'run.state.changed');
      expect(stateEvents.map((e) => (e.data as Record<string, unknown>)['to'])).toEqual(['queued', 'running', 'succeeded']);
      expect(events.filter((e) => e.type === 'run.tool.progress')).toHaveLength(2);

      // Restart: reopen the store and the API; every record survives.
      h.app.close();
      h.db.close();
      const reopened = await loadConfig({ RANGER_DATA_DIR: h.dataDir, RANGER_LOG_LEVEL: 'error', RANGER_LIVE_BUDGET_FILE: h.ledgerFile } as NodeJS.ProcessEnv);
      const db2 = openDatabase(h.dataDir);
      const app2 = await buildApiServer({ config: reopened, db: db2 });
      try {
        const runAfter = await app2.inject({ method: 'GET', url: `/v1/projects/${h.projectId}/runs/${runId}`, headers: h.bearer });
        expect(runAfter.statusCode, runAfter.body).toBe(200);
        expect((runAfter.json() as { run: { state: string } }).run.state).toBe('succeeded');
        const toolsAfter = await app2.inject({ method: 'GET', url: `/v1/projects/${h.projectId}/runs/${runId}/tools`, headers: h.bearer });
        expect((toolsAfter.json() as { tools: unknown[] }).tools).toHaveLength(2);
        const diffAfter = await app2.inject({ method: 'GET', url: `/v1/projects/${h.projectId}/workspace/diff`, headers: h.bearer });
        expect((diffAfter.json() as { changedFiles: string[] }).changedFiles).toContain('src/integration.ts');
        const testsAfter = await app2.inject({ method: 'GET', url: `/v1/projects/${h.projectId}/workspace/test-results`, headers: h.bearer });
        expect((testsAfter.json() as { testResults: unknown[] }).testResults.length).toBeGreaterThanOrEqual(1);
        const questionsAfter = await app2.inject({
          method: 'GET',
          url: `/v1/projects/${h.projectId}/conversations/${h.conversationId}/questions`,
          headers: h.bearer,
        });
        const persistedQuestions = (questionsAfter.json() as { questions: Array<{ answers: Array<{ questionId: string }> }> }).questions;
        expect(persistedQuestions.length).toBe(2);
        for (const question of persistedQuestions) {
          expect(question.answers.length).toBeGreaterThanOrEqual(1);
        }
      } finally {
        app2.close();
        db2.close();
      }
    } finally {
      h.close();
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });

  it('cancels a running run: descendants are terminated, provider work stops, the machine is cleaned up', async () => {
    const h = await openHarness();
    try {
      setPlanningTransportForTests(() => {
        throw new Error('no planning in this test');
      });
      await seedConversation(h, 'Long running task');
      const plan = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/plans`,
        headers: h.bearer,
        payload: { items: ['work'], acceptanceCriteria: ['done'], permittedScope: ['edit:src/', 'command', 'launch', 'evidence'] },
      });
      const planId = (plan.json() as { plan: { planId: string } }).plan.planId;
      const approved = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/plans/${planId}/approvals`,
        headers: h.bearer,
        payload: { permittedScope: ['edit:src/', 'command', 'launch', 'evidence'] },
      });
      const approvalId = (approved.json() as { approval: { approvalId: string } }).approval.approvalId;
      const started = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/runs`,
        headers: h.bearer,
        payload: { conversationId: h.conversationId, approvalId },
      });
      const runId = (started.json() as { run: { runId: string } }).run.runId;

      // Turn 1 launches a real (fake-provider) background process; turn 2
      // hangs until the test releases it, so the cancel lands mid-run.
      let resolveSecond: () => void = () => undefined;
      const secondCallP = new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });
      const coding = {
        transport: {
          create: async (call: ResponsesCall) => {
            if (coding.calls.push(call) === 1) {
              return {
                output: [functionCallItem('launch_app', { command: 'sleep', args: ['300'] }, 'call_launch')],
                usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
                responseId: 'resp_1',
              };
            }
            await secondCallP;
            return { output: [functionCallItem('edit_file', { path: 'src/never.ts', content: 'x' }, 'call_after_cancel')], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, responseId: 'resp_2' };
          },
        },
        calls: [] as ResponsesCall[],
      };
      const { engineeringRunHandler } = await import('../../src/runs/executor.js');
      const { WorkerLoop } = await import('../../src/worker/loop.js');
      const handler = engineeringRunHandler({ db: h.db, config: h.config, retrieval: null, transportFactory: () => coding.transport });
      const loop = new WorkerLoop(h.db, new Map([['engineering_run', handler]]), {
        pollMs: 25,
        leaseMs: 60_000,
        workerId: 'worker-cancel-test',
        logger: { info: () => undefined, error: () => undefined },
      });
      loop.start();
      // Wait for the background command to exist and the second dial to start.
      const waitDeadline = Date.now() + 20_000;
      for (;;) {
        const commands = h.db.prepare("SELECT COUNT(*) AS n FROM workspace_commands WHERE state = 'running'").get() as { n: number };
        if (commands.n >= 1 && coding.calls.length >= 2) break;
        if (Date.now() > waitDeadline) throw new Error(`background command/second dial never arrived; calls=${coding.calls.length}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const cancelled = await h.app.inject({ method: 'POST', url: `/v1/projects/${h.projectId}/runs/${runId}/cancel`, headers: h.bearer });
      expect(cancelled.statusCode, cancelled.body).toBe(200);

      // The real descendant got TERM (and the record shows termination).
      const terminated = h.db.prepare("SELECT state FROM workspace_commands WHERE state = 'terminated'").get() as { state: string } | undefined;
      expect(terminated?.state).toBe('terminated');
      expect(h.provider.signals.some((s) => s.signal === 'TERM')).toBe(true);

      // Cancel of an already-terminal run is truthful and effectless.
      const again = await h.app.inject({ method: 'POST', url: `/v1/projects/${h.projectId}/runs/${runId}/cancel`, headers: h.bearer });
      expect(again.statusCode).toBe(200);

      // Release the hung provider call; the loop must stop without further
      // tool work and mark the run cancelled.
      resolveSecond();
      const deadline = Date.now() + 20_000;
      for (;;) {
        const row = h.db.prepare('SELECT state, failure_code FROM runs WHERE id = ?').get(runId) as { state: string; failure_code: string | null } | undefined;
        if (row?.state === 'cancelled') break;
        if (Date.now() > deadline) throw new Error(`run never cancelled: ${JSON.stringify(row)}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await loop.stop();
      expect(coding.calls).toHaveLength(2);
      const sideEffects = h.db.prepare("SELECT COUNT(*) AS n FROM run_tool_outcomes WHERE name = 'edit_file'").get() as { n: number };
      expect(sideEffects.n).toBe(0);
      expect(h.provider.kills.length).toBeGreaterThanOrEqual(1);
      const workspaceRow = h.db.prepare('SELECT observed_state FROM workspaces WHERE project_id = ?').get(h.projectId) as { observed_state: string };
      expect(workspaceRow.observed_state).toBe('destroyed');
    } finally {
      h.close();
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });

  it('cancels a run blocked on a foreground command: the run-owned row is visible, the group is terminated and recorded sessions close before destroy', async () => {
    const h = await openHarness();
    try {
      setPlanningTransportForTests(() => {
        throw new Error('no planning in this test');
      });
      await seedConversation(h, 'Long running foreground task');
      const plan = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/plans`,
        headers: h.bearer,
        payload: { items: ['work'], acceptanceCriteria: ['done'], permittedScope: ['edit:src/', 'command', 'launch', 'evidence'] },
      });
      const planId = (plan.json() as { plan: { planId: string } }).plan.planId;
      const approved = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/plans/${planId}/approvals`,
        headers: h.bearer,
        payload: { permittedScope: ['edit:src/', 'command', 'launch', 'evidence'] },
      });
      const approvalId = (approved.json() as { approval: { approvalId: string } }).approval.approvalId;
      const started = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/runs`,
        headers: h.bearer,
        payload: { conversationId: h.conversationId, approvalId },
      });
      const runId = (started.json() as { run: { runId: string } }).run.runId;

      // Turn 1 runs a real FOREGROUND command (run_command) whose guest exec
      // hangs until the fake releases it; the hang models a blocked tool.
      const hang = h.provider.hangNextForeground({ ignoresTerm: true });
      const coding = {
        transport: {
          create: async (call: ResponsesCall): Promise<ResponsesResult> => {
            coding.calls.push(call);
            return {
              output: [functionCallItem('run_command', { command: 'sleep', args: ['300'], timeoutMs: 60_000 }, 'call_fg')],
              usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
              responseId: 'resp_1',
            };
          },
        },
        calls: [] as ResponsesCall[],
      };
      const { engineeringRunHandler } = await import('../../src/runs/executor.js');
      const { WorkerLoop } = await import('../../src/worker/loop.js');
      const handler = engineeringRunHandler({ db: h.db, config: h.config, retrieval: null, transportFactory: () => coding.transport });
      const loop = new WorkerLoop(h.db, new Map([['engineering_run', handler]]), {
        pollMs: 25,
        leaseMs: 60_000,
        workerId: 'worker-fg-cancel-test',
        logger: { info: () => undefined, error: () => undefined },
      });
      loop.start();

      // THE defect regression: while the foreground exec is in flight, a
      // run-owned RUNNING command row must already exist for public cancel.
      const rowDeadline = Date.now() + 20_000;
      let inFlight: { id: string; state: string } | undefined;
      for (;;) {
        inFlight = h.db.prepare("SELECT id, state FROM workspace_commands WHERE run_id = ? AND state = 'running'").get(runId) as
          | { id: string; state: string }
          | undefined;
        if (inFlight !== undefined) break;
        if (Date.now() > rowDeadline) throw new Error('foreground command row never became visible while in flight');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      // Recorded desktop and preview sessions exist while the run is active.
      const desktop = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/desktop/sessions`,
        headers: h.bearer,
        payload: { ttlSeconds: 30 },
      });
      expect(desktop.statusCode, desktop.body).toBe(200);
      const preview = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/preview/sessions`,
        headers: h.bearer,
        payload: { guestPort: 4173 },
      });
      expect(preview.statusCode, preview.body).toBe(200);

      const cancelled = await h.app.inject({ method: 'POST', url: `/v1/projects/${h.projectId}/runs/${runId}/cancel`, headers: h.bearer });
      expect(cancelled.statusCode, cancelled.body).toBe(200);

      const deadline = Date.now() + 20_000;
      for (;;) {
        const row = h.db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as { state: string } | undefined;
        if (row?.state === 'cancelled') break;
        if (Date.now() > deadline) throw new Error(`run never cancelled: ${JSON.stringify(row)}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await loop.stop();
      hang.assertResolved();

      // The blocked foreground command was terminated for real: TERM then a
      // liveness-checked KILL reached the fake guest process group.
      expect(h.provider.signals.map((s) => s.signal)).toEqual(['TERM', 'KILL']);
      const commandRow = h.db.prepare('SELECT state, exit_code FROM workspace_commands WHERE id = ?').get(inFlight!.id) as {
        state: string;
        exit_code: number | null;
      };
      expect(commandRow.state).toBe('terminated');

      // The tool outcome is truthful: no forged pass, no further model work.
      expect(coding.calls).toHaveLength(1);
      const outcomes = h.db.prepare("SELECT name, status, result_json FROM run_tool_outcomes WHERE run_id = ?").all(runId) as Array<{
        name: string;
        status: string;
        result_json: string | null;
      }>;
      expect(outcomes.some((o) => o.name === 'run_command' && o.status === 'ok' && (JSON.parse(o.result_json ?? '{}') as { state?: string }).state === 'terminated')).toBe(true);
      expect(JSON.stringify(outcomes)).not.toContain('"passed":true');

      // Recorded streams and tunnels closed BEFORE the workspace destroy,
      // with observable persisted close state.
      const closed = h.db
        .prepare(
          `SELECT
             (SELECT revoked_at FROM desktop_sessions WHERE project_id = ? AND state = 'revoked' LIMIT 1) AS desktop_revoked_at,
             (SELECT stopped_at FROM preview_sessions WHERE project_id = ? AND state = 'stopped' LIMIT 1) AS preview_stopped_at,
             (SELECT destroyed_at FROM workspaces WHERE project_id = ?) AS destroyed_at`,
        )
        .get(h.projectId, h.projectId, h.projectId) as { desktop_revoked_at: number | null; preview_stopped_at: number | null; destroyed_at: number | null };
      expect(closed.desktop_revoked_at).not.toBeNull();
      expect(closed.preview_stopped_at).not.toBeNull();
      expect(closed.destroyed_at).not.toBeNull();
      expect(closed.desktop_revoked_at!).toBeLessThanOrEqual(closed.destroyed_at!);
      expect(closed.preview_stopped_at!).toBeLessThanOrEqual(closed.destroyed_at!);
      expect(h.provider.order).toContain('streams-revoked');
      const killedAt = h.provider.order.findIndex((entry) => entry.startsWith('killed:'));
      expect(killedAt).toBeGreaterThanOrEqual(0);
      expect(h.provider.order.indexOf('streams-revoked')).toBeLessThan(killedAt);
      const workspaceRow = h.db.prepare('SELECT observed_state FROM workspaces WHERE project_id = ?').get(h.projectId) as { observed_state: string };
      expect(workspaceRow.observed_state).toBe('destroyed');
    } finally {
      h.close();
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });

  it('marks an interrupted run failed with cleanup, rejects the stale worker and never resumes', async () => {
    const h = await openHarness();
    try {
      setPlanningTransportForTests(() => {
        throw new Error('no planning in this test');
      });
      await seedConversation(h, 'Interrupted task');
      const plan = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/plans`,
        headers: h.bearer,
        payload: { items: ['work'], acceptanceCriteria: ['done'], permittedScope: ['edit:src/', 'command'] },
      });
      const planId = (plan.json() as { plan: { planId: string } }).plan.planId;
      const approved = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/plans/${planId}/approvals`,
        headers: h.bearer,
        payload: { permittedScope: ['edit:src/', 'command'] },
      });
      const approvalId = (approved.json() as { approval: { approvalId: string } }).approval.approvalId;
      const started = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/runs`,
        headers: h.bearer,
        payload: { conversationId: h.conversationId, approvalId },
      });
      const runId = (started.json() as { run: { runId: string } }).run.runId;

      // A real worker child process claims the run and dies mid-run (SIGKILL).
      const scriptFile = path.join(h.dataDir, 'agent-script.json');
      writeFileSync(
        scriptFile,
        JSON.stringify({
          steps: [
            { output: [functionCallItem('run_command', { command: 'echo', args: ['started'] }, 'call_1')], usage: { inputTokens: 100, outputTokens: 50 } },
            { delayMs: 600_000 },
          ],
        }),
      );
      const configFile = path.join(h.dataDir, 'config.json');
      writeFileSync(configFile, JSON.stringify({ limits: { jobLeaseMs: 1500, workerPollMs: 100 } }));
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        RANGER_DATA_DIR: h.dataDir,
        RANGER_LOG_LEVEL: 'error',
        RANGER_LIVE_BUDGET_FILE: h.ledgerFile,
        RANGER_CONFIG_FILE: configFile,
        RANGER_WORKSPACE_PROVIDER: 'deterministic',
        RANGER_AGENT_SCRIPT_FILE: scriptFile,
      };
      const child = await new Promise<ChildProcess>((resolve, reject) => {
        const process_ = execFile('node', ['dist/src/entrypoints/worker.js'], { env: childEnv, cwd: process.cwd() }, (error) => {
          void error; // the child is SIGKILLed by the test on purpose
        });
        process_.stdout?.on('data', (chunk: Buffer) => {
          if (String(chunk).includes('ranger worker started')) resolve(process_);
        });
        process_.on('error', reject);
      });
      const waitDeadline = Date.now() + 30_000;
      for (;;) {
        const row = h.db.prepare('SELECT state, worker_id, claim_epoch FROM runs WHERE id = ?').get(runId) as
          | { state: string; worker_id: string | null; claim_epoch: number | null }
          | undefined;
        if (row?.state === 'running' && row.worker_id !== null) break;
        if (Date.now() > waitDeadline) throw new Error(`child never started the run: ${JSON.stringify(row)}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const binding = h.db.prepare('SELECT worker_id, claim_epoch FROM runs WHERE id = ?').get(runId) as { worker_id: string; claim_epoch: number };
      // Wait until real tool work has a durable record, so the interruption
      // provably does not remove or replay it.
      for (;;) {
        const outcomes = h.db.prepare('SELECT COUNT(*) AS n FROM run_tool_outcomes WHERE run_id = ?').get(runId) as { n: number };
        if (outcomes.n >= 1) break;
        if (Date.now() > waitDeadline) throw new Error('tool outcome never recorded before interruption');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      child.kill('SIGKILL');

      // After the lease expires, a later controller marks the run failed and
      // cleans up its recorded resources. It never resumes the model/tool work.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const { reconcileInterruptedRuns } = await import('../../src/runs/reconcile.js');
      const report = await reconcileInterruptedRuns({ db: h.db, ledgerFile: h.ledgerFile, provider: h.provider });
      expect(report.failedRuns).toContain(runId);
      const failed = h.db.prepare('SELECT state, failure_code FROM runs WHERE id = ?').get(runId) as { state: string; failure_code: string };
      expect(failed.state).toBe('failed');
      expect(failed.failure_code).toBe('control_worker_lease_expired');
      const job = h.db.prepare('SELECT status FROM jobs WHERE id = (SELECT job_id FROM runs WHERE id = ?)').get(runId) as { status: string };
      expect(job.status).toBe('failed');

      // A stale completion from the dead worker is rejected after fencing.
      const { completeRunFromWorker } = await import('../../src/runs/store.js');
      const stale = completeRunFromWorker(h.db, runId, { workerId: binding.worker_id, claimEpoch: binding.claim_epoch, state: 'succeeded' });
      expect(stale).toBeNull();
      const stillFailed = h.db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as { state: string };
      expect(stillFailed.state).toBe('failed');

      // The completed tool work keeps its durable records (no resume, no retry).
      const tools = h.db.prepare('SELECT COUNT(*) AS n FROM run_tool_outcomes WHERE run_id = ?').get(runId) as { n: number };
      expect(tools.n).toBeGreaterThanOrEqual(1);
    } finally {
      h.close();
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });

  it('fails a run explicitly when the workspace create is uncertain and never creates again', async () => {
    const h = await openHarness();
    try {
      setPlanningTransportForTests(() => {
        throw new Error('no planning in this test');
      });
      await seedConversation(h, 'Uncertain create task');
      const plan = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/plans`,
        headers: h.bearer,
        payload: { items: ['work'], acceptanceCriteria: ['done'], permittedScope: ['edit:src/'] },
      });
      const planId = (plan.json() as { plan: { planId: string } }).plan.planId;
      const approved = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/plans/${planId}/approvals`,
        headers: h.bearer,
        payload: { permittedScope: ['edit:src/'] },
      });
      const approvalId = (approved.json() as { approval: { approvalId: string } }).approval.approvalId;
      const started = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/runs`,
        headers: h.bearer,
        payload: { conversationId: h.conversationId, approvalId },
      });
      const runId = (started.json() as { run: { runId: string } }).run.runId;

      h.provider.failNextCreateAmbiguous('m_lost_machine');
      const { engineeringRunHandler } = await import('../../src/runs/executor.js');
      await engineeringRunHandler({ db: h.db, config: h.config, retrieval: null, transportFactory: () => ({ create: async (): Promise<ResponsesResult> => { throw new Error('never dialed'); } }) })({
        id: (h.db.prepare('SELECT job_id FROM runs WHERE id = ?').get(runId) as { job_id: string }).job_id,
        type: 'engineering_run',
        payload: { runId },
        claimEpoch: 1,
      });
      const run = h.db.prepare('SELECT state, failure_code FROM runs WHERE id = ?').get(runId) as { state: string; failure_code: string };
      expect(run.state).toBe('failed');
      expect(run.failure_code).toBe('uncertain_create');
      expect(h.provider.creates).toHaveLength(1); // never a second create

      // A later controller resolves the recorded identity for cleanup and
      // accounting: the machine is destroyed exactly once and the ledger
      // records creation + release.
      const { reconcileInterruptedRuns } = await import('../../src/runs/reconcile.js');
      const report = await reconcileInterruptedRuns({ db: h.db, ledgerFile: h.ledgerFile, provider: h.provider });
      expect(report.resolvedUncertainWorkspaces).toBe(1);
      expect(h.provider.kills).toContain('m_lost_machine');
      const ledger = JSON.parse(readFileSync(h.ledgerFile, 'utf8')) as {
        instabox: { additionalCreations: number; machines: Array<{ machineId: string; releasedAt: number | null }> };
      };
      expect(ledger.instabox.additionalCreations).toBe(1);
      expect(ledger.instabox.machines.some((m) => m.machineId === 'm_lost_machine' && m.releasedAt !== null)).toBe(true);
      const workspaceRow = h.db.prepare('SELECT observed_state FROM workspaces WHERE project_id = ?').get(h.projectId) as { observed_state: string };
      expect(workspaceRow.observed_state).toBe('destroyed');
    } finally {
      h.close();
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });

  it('reclaims a failed run machine on later sweeps when the first destroy failed', async () => {
    const h = await openHarness();
    try {
      // Scripted clarification + plan (deterministic; never a live dial).
      // The transport is built ONCE: the factory may be invoked per dial and
      // a per-dial instance would restart at step one.
      const planning = scriptedTransport([
        { output: [messageItem(JSON.stringify({ questions: ['Where do the fixtures live?'] }))] },
        {
          output: [
            messageItem(
              JSON.stringify({
                items: ['Integrate the fixtures'],
                acceptanceCriteria: ['Tickets flow end to end'],
                permittedScope: ['edit:src/', 'command'],
              }),
            ),
          ],
        },
      ]);
      setPlanningTransportForTests(() => planning.transport);
      await seedConversation(h, 'Orphan reclaim task');
      const { approvalId } = await planAndApprove(h, ['edit:src/', 'command']);
      const started = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/runs`,
        headers: h.bearer,
        payload: { conversationId: h.conversationId, approvalId },
      });
      const runId = (started.json() as { run: { runId: string } }).run.runId;

      // The incident shape from the live window: the run was failed honestly
      // but its machine destroy failed once (control process died in between),
      // leaving a recorded running workspace with no active run behind.
      const { reserveInstaboxCreation, confirmInstaboxCreation, recordInstaboxRelease } = await import('../../src/budget/ledger.js');
      const reservation = reserveInstaboxCreation(h.ledgerFile, { feature: 'runs-workflow-int', purpose: h.projectId, killTimeoutMs: 600_000 });
      confirmInstaboxCreation(h.ledgerFile, { reservationId: reservation.reservationId, machineId: 'm_orphan_machine', purpose: h.projectId });
      h.db.prepare("UPDATE runs SET state = 'failed', failure_code = 'control_worker_lease_expired' WHERE id = ?").run(runId);
      h.db
        .prepare(
          "INSERT INTO workspaces (project_id, operation_key, machine_id, reservation_id, desired_state, observed_state, kill_timeout_ms, deadline_at, uncertain, created_at) VALUES (?, ?, 'm_orphan_machine', ?, 'running', 'running', 600000, ?, 0, ?)",
        )
        .run(h.projectId, `runs-workflow-int:${h.projectId}`, reservation.reservationId, Date.now() + 600_000, Date.now());

      const { reconcileInterruptedRuns } = await import('../../src/runs/reconcile.js');
      const report = await reconcileInterruptedRuns({ db: h.db, ledgerFile: h.ledgerFile, provider: h.provider });
      expect(report.destroyedWorkspaces).toContain('m_orphan_machine');
      expect(h.provider.kills).toContain('m_orphan_machine');
      const workspaceRow = h.db.prepare('SELECT observed_state FROM workspaces WHERE project_id = ?').get(h.projectId) as { observed_state: string };
      expect(workspaceRow.observed_state).toBe('destroyed');
      const ledger = JSON.parse(readFileSync(h.ledgerFile, 'utf8')) as {
        instabox: { machines: Array<{ machineId: string; releasedAt: number | null }> };
      };
      expect(ledger.instabox.machines.find((m) => m.machineId === 'm_orphan_machine')?.releasedAt).not.toBeNull();

      // Idempotent: the reclaimed workspace is not killed twice.
      const killsBefore = h.provider.kills.length;
      await reconcileInterruptedRuns({ db: h.db, ledgerFile: h.ledgerFile, provider: h.provider });
      expect(h.provider.kills.filter((id) => id === 'm_orphan_machine')).toHaveLength(1);
      expect(h.provider.kills.length).toBe(killsBefore);
      expect(recordInstaboxRelease(h.ledgerFile, 'm_orphan_machine')).toBeUndefined();
    } finally {
      h.close();
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });

  it('invalidates the v1 approval on a material change, names impact and blocks the old approval', async () => {
    const planning = scriptedTransport([
      {
        output: [
          messageItem(
            JSON.stringify({
              items: ['Change the reply template'],
              acceptanceCriteria: ['The reply uses the new template'],
              permittedScope: ['edit:src/', 'command'],
              impactedPaths: ['src/reply.ts', 'src/integration.ts'],
              impactedTests: ['tests/reply.test.ts'],
            }),
          ),
        ],
      },
    ]);
    setPlanningTransportForTests(() => planning.transport);
    const h = await openHarness();
    try {
      await seedConversation(h, 'Change the reply template.');
      const plan1 = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/plans`,
        headers: h.bearer,
        payload: { items: ['Original work'], acceptanceCriteria: ['Original criterion'], permittedScope: ['edit:src/', 'command'] },
      });
      const plan1Id = (plan1.json() as { plan: { planId: string } }).plan.planId;
      const approved1 = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/plans/${plan1Id}/approvals`,
        headers: h.bearer,
        payload: { permittedScope: ['edit:src/', 'command'] },
      });
      const approval1 = (approved1.json() as { approval: { approvalId: string } }).approval.approvalId;

      // A requirement version change then a new plan version (v2).
      await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/requirements`,
        headers: h.bearer,
        payload: { content: 'Change the reply template and validate it.', requirementId: h.requirementId },
      });
      const generated = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/plans/generate`,
        headers: h.bearer,
        payload: { conversationId: h.conversationId },
      });
      expect(generated.statusCode, generated.body).toBe(200);
      const plan2 = (generated.json() as { plan: { planId: string; version: number } }).plan;
      expect(plan2.version).toBe(2);

      // The old approval is invalidated; starting a run with it is blocked.
      const blocked = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/runs`,
        headers: h.bearer,
        payload: { conversationId: h.conversationId, approvalId: approval1 },
      });
      expect(blocked.statusCode).toBe(409);
      expect((blocked.json() as { error: { details?: { reason?: string } } }).error.details?.reason).toBe('approval_invalidated');

      const events = await allEvents(h);
      const invalidation = events.find((e) => e.type === 'plan.approval.invalidated');
      expect(invalidation).toBeDefined();
      expect((invalidation!.data as Record<string, unknown>)['impactedPaths']).toEqual(['src/reply.ts', 'src/integration.ts']);
      expect((invalidation!.data as Record<string, unknown>)['impactedTests']).toEqual(['tests/reply.test.ts']);

      // Prohibited scope has no enabling route at plan or approval time.
      const prohibitedPlan = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/plans`,
        headers: h.bearer,
        payload: { items: ['deploy'], acceptanceCriteria: ['deployed'], permittedScope: ['deploy:production'] },
      });
      expect(prohibitedPlan.statusCode).toBe(400);
      expect((prohibitedPlan.json() as { error: { details?: { reason?: string } } }).error.details?.reason).toBe('prohibited_scope');
      const prohibitedApproval = await h.app.inject({
        method: 'POST',
        url: `/v1/projects/${h.projectId}/plans/${plan2.planId}/approvals`,
        headers: h.bearer,
        payload: { permittedScope: ['purchase'] },
      });
      expect(prohibitedApproval.statusCode).toBe(400);
    } finally {
      h.close();
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });

  it('emits one atomic repository.disconnected event and replays it exactly once under an idempotency key', async () => {
    const { createFixtureRepo } = await import('../helpers/fixture-repo.js');
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ranger-repo-fixture-'));
    tempDirs.push(baseDir);
    const fixture = createFixtureRepo(baseDir);
    const h = await openHarness({ RANGER_APPROVED_SNAPSHOT_ROOTS: baseDir });
    try {
      const project = await h.app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: h.bearer,
        payload: { name: 'Disconnect', engineerDisplayName: 'Ranger' },
      });
      h.projectId = (project.json() as { project: { projectId: string } }).project.projectId;
      const connected = await h.app.inject({
        method: 'PUT',
        url: `/v1/projects/${h.projectId}/repository`,
        headers: h.bearer,
        payload: { url: fixture.fileUrl, ref: 'main' },
      });
      expect(connected.statusCode, connected.body).toBe(200);
      const key = { 'idempotency-key': 'disconnect-once' };
      const first = await h.app.inject({ method: 'DELETE', url: `/v1/projects/${h.projectId}/repository`, headers: { ...h.bearer, ...key } });
      expect(first.statusCode, first.body).toBe(200);
      const second = await h.app.inject({ method: 'DELETE', url: `/v1/projects/${h.projectId}/repository`, headers: { ...h.bearer, ...key } });
      expect(second.statusCode).toBe(200);
      const events = await allEvents(h);
      const disconnects = events.filter((e) => e.type === 'repository.disconnected');
      expect(disconnects).toHaveLength(1);
      expect(disconnects[0]!.data['commit']).toBeTruthy();
    } finally {
      h.close();
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });

  it('materializes the connected approved repository into persisted source BEFORE any VM create, at the recorded revision', async () => {
    const { createFixtureRepo } = await import('../helpers/fixture-repo.js');
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ranger-initial-src-'));
    tempDirs.push(baseDir);
    const fixture = createFixtureRepo(baseDir);
    setPlanningTransportForTests(() => {
      throw new Error('no planning in this test');
    });
    const h = await openHarness({ RANGER_APPROVED_SNAPSHOT_ROOTS: baseDir });
    try {
      await seedConversation(h, 'Build the integration per the connected repository.');
      const connected = await connectRepositoryViaApi(h, fixture.fileUrl);
      expect(connected.status).toBe(200);
      const commit = connected.commit;
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
      const approvalId = await planAndApproveDirectly(h, ['edit:src/', 'command']);

      // Same idempotency key on the original call and the identical replay:
      // one run, one job (the deterministic one-creation rehearsal).
      const runId = await startRun(h, approvalId, 'initial-source-once');
      const replayId = await startRun(h, approvalId, 'initial-source-once');
      expect(replayId).toBe(runId);

      const coding = scriptedTransport([
        { output: [functionCallItem('edit_file', { path: 'src/integration.ts', content: 'export const integration = true;\n' }, 'call_1')] },
        { output: [messageItem('done')] },
      ]);
      const outcome = await runHandlerToTerminal(h, runId, coding.transport);
      expect(outcome.state, outcome.failureCode ?? '').toBe('succeeded');

      // Deterministic one-creation rehearsal: exactly ONE provider create.
      expect(h.provider.creates).toHaveLength(1);
      // The recorded repository revision rode the workspace create.
      const ws = h.db.prepare('SELECT machine_id, source_revision FROM workspaces WHERE project_id = ?').get(h.projectId) as {
        machine_id: string;
        source_revision: string | null;
      };
      expect(ws.source_revision).toBe(commit);

      // The verified initial base is persisted with its own semantic origin
      // (distinct from successful guest edits) and exact bytes.
      const initial = h.db
        .prepare("SELECT origin, content FROM workspace_source_files WHERE project_id = ? AND relative_path = 'index.ts'")
        .get(h.projectId) as { origin: string; content: Uint8Array };
      expect(initial.origin).toBe('initial_checkout');
      expect(Buffer.from(initial.content).toString('utf8')).toBe('export const version = 1;\n');
      // A successful guest edit persists with the guest-edit origin.
      const edited = h.db
        .prepare("SELECT origin FROM workspace_source_files WHERE project_id = ? AND relative_path = 'src/integration.ts'")
        .get(h.projectId) as { origin: string };
      expect(edited.origin).toBe('guest_edit');

      // Readback through the public API matches the connected checkout.
      const read = await h.app.inject({
        method: 'GET',
        url: `/v1/projects/${h.projectId}/workspace/file`,
        query: { path: 'index.ts' },
        headers: h.bearer,
      });
      expect(read.statusCode, read.body).toBe(200);
      expect(Buffer.from((read.json() as { contentBase64: string }).contentBase64, 'base64').toString('utf8')).toBe(
        'export const version = 1;\n',
      );

      // The materialized source reached the VM BEFORE the coding loop: the
      // fresh fake machine already holds the file when the agent runs.
      expect(h.provider.machineFile(ws.machine_id, 'index.ts') ?? '<missing>').toBe('export const version = 1;\n');
    } finally {
      h.close();
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });

  it('preserves generated saved source on a subsequent run instead of re-materializing the repository', async () => {
    const { createFixtureRepo } = await import('../helpers/fixture-repo.js');
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ranger-initial-src-'));
    tempDirs.push(baseDir);
    const fixture = createFixtureRepo(baseDir);
    setPlanningTransportForTests(() => {
      throw new Error('no planning in this test');
    });
    const h = await openHarness({ RANGER_APPROVED_SNAPSHOT_ROOTS: baseDir });
    try {
      await seedConversation(h, 'Build the integration per the connected repository.');
      expect((await connectRepositoryViaApi(h, fixture.fileUrl)).status).toBe(200);
      const approvalId = await planAndApproveDirectly(h, ['edit:src/', 'command']);

      const run1 = await startRun(h, approvalId, 'preserved-run-1');
      const coding1 = scriptedTransport([
        { output: [functionCallItem('edit_file', { path: 'src/integration.ts', content: 'export const integration = true;\n' }, 'c1')] },
        { output: [messageItem('done')] },
      ]);
      expect((await runHandlerToTerminal(h, run1, coding1.transport)).state).toBe('succeeded');

      // The checkout CHANGES after the first run (new commit). The second
      // run must seed from the saved generated source, never re-read the
      // moving repository.
      writeFileSync(fixture.trackedFile, 'NEW COMMIT CONTENT — must never leak\n');
      execFileSync('git', ['-C', fixture.root, 'add', 'index.ts'], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
      execFileSync('git', ['-C', fixture.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'rewrite index'], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });

      const run2 = await startRun(h, approvalId, 'preserved-run-2');
      const coding2 = scriptedTransport([
        { output: [functionCallItem('edit_file', { path: 'src/more.ts', content: 'export const more = 1;\n' }, 'c2')] },
        { output: [messageItem('done')] },
      ]);
      expect((await runHandlerToTerminal(h, run2, coding2.transport)).state).toBe('succeeded');

      // Each run created exactly one fresh VM (two total), and the saved
      // generated source survived into the second VM unchanged.
      expect(h.provider.creates).toHaveLength(2);
      const ws2 = h.db.prepare('SELECT machine_id, source_revision FROM workspaces WHERE project_id = ?').get(h.projectId) as {
        machine_id: string;
        source_revision: string | null;
      };
      expect(h.provider.machineFile(ws2.machine_id, 'index.ts') ?? '<missing>').toBe('export const version = 1;\n');
      expect(h.provider.machineFile(ws2.machine_id, 'src/integration.ts') ?? '<missing>').toBe('export const integration = true;\n');
      // The initial base keeps its origin and its ORIGINAL bytes; the later
      // commit content never leaked into the workspace.
      const initial = h.db
        .prepare("SELECT origin, content FROM workspace_source_files WHERE project_id = ? AND relative_path = 'index.ts'")
        .get(h.projectId) as { origin: string; content: Uint8Array };
      expect(initial.origin).toBe('initial_checkout');
      expect(Buffer.from(initial.content).toString('utf8')).toBe('export const version = 1;\n');
      expect(h.provider.machineFile(ws2.machine_id, 'src/more.ts') ?? '<missing>').toBe('export const more = 1;\n');
    } finally {
      h.close();
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });

  it('fails the run explicitly BEFORE any create when the connected repository is a remote reference', async () => {
    setPlanningTransportForTests(() => {
      throw new Error('no planning in this test');
    });
    const h = await openHarness();
    try {
      await seedConversation(h, 'Build the integration per the remote repository.');
      // Metadata-only connect stays allowed (no snapshot was recorded).
      const connected = await connectRepositoryViaApi(h, 'https://example.com/acme/support.git');
      expect(connected.status).toBe(200);
      expect(connected.commit).toBe('');
      const approvalId = await planAndApproveDirectly(h, ['edit:src/', 'command']);

      const runId = await startRun(h, approvalId, 'remote-repo-run');
      const outcome = await runHandlerToTerminal(h, runId, {
        create: async (): Promise<ResponsesResult> => {
          throw new Error('must never dial');
        },
      });
      expect(outcome.state).toBe('failed');
      expect(outcome.failureCode).toBe('initial_source_unmaterializable');
      // The failure happened BEFORE any creation: zero machines, zero source.
      expect(h.provider.creates).toHaveLength(0);
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM workspace_source_files WHERE project_id = ?').get(h.projectId)).toEqual({ n: 0 });
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE project_id = ?').get(h.projectId)).toEqual({ n: 0 });
      // The run failed honestly through the public event record.
      const events = await allEvents(h);
      const failed = events.filter((e) => e.type === 'run.state.changed').at(-1);
      expect((failed!.data as Record<string, unknown>)['to']).toBe('failed');
    } finally {
      h.close();
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });

  it('fails the run explicitly BEFORE any create when the checkout became unreadable', async () => {
    const { createFixtureRepo } = await import('../helpers/fixture-repo.js');
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ranger-initial-src-'));
    tempDirs.push(baseDir);
    const fixture = createFixtureRepo(baseDir);
    setPlanningTransportForTests(() => {
      throw new Error('no planning in this test');
    });
    const h = await openHarness({ RANGER_APPROVED_SNAPSHOT_ROOTS: baseDir });
    try {
      await seedConversation(h, 'Build the integration per the connected repository.');
      const connected = await connectRepositoryViaApi(h, fixture.fileUrl);
      expect(connected.status).toBe(200);
      expect(connected.commit).toMatch(/^[0-9a-f]{40}$/);
      const approvalId = await planAndApproveDirectly(h, ['edit:src/', 'command']);

      // The approved checkout vanished after connect: the initial source
      // cannot materialize, so the run must fail before any create instead
      // of silently booting an empty repo.
      rmSync(fixture.root, { recursive: true, force: true });

      const runId = await startRun(h, approvalId, 'vanished-checkout-run');
      const outcome = await runHandlerToTerminal(h, runId, {
        create: async (): Promise<ResponsesResult> => {
          throw new Error('must never dial');
        },
      });
      expect(outcome.state).toBe('failed');
      expect(outcome.failureCode).toBe('initial_source_unmaterializable');
      expect(h.provider.creates).toHaveLength(0);
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM workspace_source_files WHERE project_id = ?').get(h.projectId)).toEqual({ n: 0 });
    } finally {
      h.close();
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });
});
