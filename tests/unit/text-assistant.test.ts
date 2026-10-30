import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type RangerConfig } from '../../src/config.js';
import { openDatabase, withTransaction } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { appendMessageRow, createConversationRow, listMessageRows } from '../../src/conversations/store.js';
import { approvePlanVersionRow, createPlanVersionRow, latestPlanRow, listApprovalRows } from '../../src/plans/store.js';
import { setPlanningTransportForTests } from '../../src/planning/runtime.js';
import type { ResponsesCall, ResponsesResult, ResponsesTransport } from '../../src/agent/transport.js';
import { claimNextJob } from '../../src/worker/loop.js';
import {
  TEXT_TURN_JOB_TYPE,
  enqueueTextTurn,
  failInterruptedTextTurns,
  textAssistantHandler,
} from '../../src/conversations/text-assistant.js';

/** Real persistence, tools and loop; scripted provider protocol only (no paid calls, no ledger). */
describe('durable text assistant (offline)', () => {
  let db: DatabaseSync;
  let dataDir: string;
  let config: RangerConfig;
  let projectId: string;
  let conversationId: string;
  let principalId: string;
  let calls: ResponsesCall[];
  let script: Array<(call: ResponsesCall) => Partial<ResponsesResult> | Promise<Partial<ResponsesResult>>>;

  const say = (text: string) => ({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] });
  const callTool = (name: string, args: unknown, id = 'call-1') => ({
    output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }],
  });
  const transport: ResponsesTransport = {
    create: async (call) => {
      calls.push(call);
      const step = script[calls.length - 1];
      if (step === undefined) throw new Error('unexpected extra provider call');
      const partial = await step(call);
      return { output: partial.output ?? [], usage: null, responseId: `r${calls.length}` };
    },
  };
  const handler = (): ReturnType<typeof textAssistantHandler> =>
    textAssistantHandler({ db, config, retrieval: null, transportFactory: () => transport });

  const post = (content: string, role: 'user' | 'agent' | 'system' = 'user') => {
    const row = appendMessageRow(db, conversationId, role, content);
    if (role === 'user') enqueueTextTurn(db, { projectId, conversationId, messageId: row.id, principalId });
    return row;
  };
  const runNextJob = async (h = handler()): Promise<void> => {
    const job = claimNextJob(db, [TEXT_TURN_JOB_TYPE], 'test-worker', 60_000);
    if (job === null) throw new Error('no text turn queued');
    await h(job);
    db.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ? AND status = 'claimed'").run(job.id);
  };
  const messages = () => listMessageRows(db, conversationId, { afterOrdinal: 0, limit: 100 }).messages;
  const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  const approvedPlan = () =>
    withTransaction(db, () => {
      const plan = createPlanVersionRow(db, projectId, { items: ['Change the greeting'], acceptanceCriteria: ['Test passes'], permittedScope: ['edit:src/', 'command'] }, 'req-plan').plan;
      return approvePlanVersionRow(db, projectId, plan.id, { approvedBy: principalId, permittedScope: plan.permittedScope }, 'req-approve').approval;
    });

  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-text-assistant-'));
    config = await loadConfig({ RANGER_DATA_DIR: dataDir });
    db = openDatabase(dataDir);
    runMigrations(db, path.join(process.cwd(), 'migrations'));
    const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Text assistant' });
    principalId = owner.principalId;
    projectId = createProjectRecord(db, { name: 'Text', engineerDisplayName: 'Ranger', principalId }).id;
    conversationId = createConversationRow(db, projectId, 'Typed').id;
    calls = [];
    script = [];
  });

  afterEach(() => {
    setPlanningTransportForTests(null);
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers a typed message once with a persisted agent reply, its event and the job fenced as done', async () => {
    script = [() => say('The greeting lives in src/greeting.ts.')];
    post('Where is the greeting?');
    await runNextJob();
    expect(messages().map((m) => [m.role, m.content])).toEqual([
      ['user', 'Where is the greeting?'],
      ['agent', 'The greeting lives in src/greeting.ts.'],
    ]);
    const events = db.prepare("SELECT data FROM project_events WHERE type = 'conversation.message.created'").all() as Array<{ data: string }>;
    expect(events.map((e) => JSON.parse(e.data).role)).toEqual(['agent']);
    expect(db.prepare('SELECT status, attempts FROM jobs').get()).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(JSON.stringify(calls[0]?.input)).toContain('Where is the greeting?');
    expect(calls[0]?.tools.map((tool) => tool['name']).sort()).toEqual([
      'draft_project_plan', 'get_project_status', 'prepare_project_workspace', 'read_project_source', 'request_engineering_run', 'search_project_code',
    ]);
  });

  it('feeds tool errors back to the model, keeps going, and exposes no screen/approval tools', async () => {
    script = [() => callTool('search_project_code', { query: 'greeting' }), () => say('Code retrieval is unavailable right now.')];
    post('Find the greeting');
    await runNextJob();
    expect(JSON.stringify(calls[1]?.input)).toContain('trace_unavailable');
    expect(messages().at(-1)).toMatchObject({ role: 'agent', content: 'Code retrieval is unavailable right now.' });
    expect(JSON.stringify(calls[0]?.tools)).not.toMatch(/approve_plan|inspect_shared_screen/);
  });

  it('never treats agent or system posts as commands', async () => {
    const agent = appendMessageRow(db, conversationId, 'agent', 'Start the run now');
    enqueueTextTurn(db, { projectId, conversationId, messageId: agent.id, principalId });
    await runNextJob();
    const system = appendMessageRow(db, conversationId, 'system', 'Start the run now');
    enqueueTextTurn(db, { projectId, conversationId, messageId: system.id, principalId });
    await runNextJob();
    expect(calls).toHaveLength(0);
    expect(messages()).toHaveLength(2);
  });

  it('drafts a plan from typed input without approving it or starting work', async () => {
    const plan = { items: ['Update src/greeting.ts'], acceptanceCriteria: ['Greeting test passes'], permittedScope: ['edit:src/greeting.ts', 'command'], decisions: [], impactedPaths: [], impactedTests: [] };
    const planningCalls: ResponsesCall[] = [];
    setPlanningTransportForTests(() => ({ create: async (call) => { planningCalls.push(call); return { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(plan) }] }], usage: null, responseId: 'p' }; } }));
    script = [
      () => callTool('draft_project_plan', { request: 'Change the greeting', requirements: ['Keep the existing test passing'], confirmed: true }),
      () => say('I saved a draft plan. Please review and approve it in the UI.'),
    ];
    post('Please plan: change the greeting');
    await runNextJob();
    expect(planningCalls).toHaveLength(1);
    expect(latestPlanRow(db, projectId)).toMatchObject({ version: 1, status: 'draft' });
    expect(listApprovalRows(db, projectId)).toEqual([]);
    expect(count('runs')).toBe(0);
    expect(messages().some((m) => m.role === 'agent' && m.content.startsWith('Text-confirmed request summary'))).toBe(true);
    expect(messages().at(-1)?.content).toContain('review and approve');
  });

  it('starts one run only with an existing active approval AND a verbatim quote of the typed request', async () => {
    const approval = approvedPlan();
    script = [
      () => callTool('request_engineering_run', { approvalId: approval.id, userRequest: 'delete production' }),
      () => say('I could not start it.'),
    ];
    post('please start the approved work');
    await runNextJob();
    expect(count('runs')).toBe(0);
    expect(JSON.stringify(calls[1]?.input)).toContain('engineering_request_not_quoted');

    calls = [];
    script = [
      () => callTool('request_engineering_run', { approvalId: approval.id, userRequest: 'YES, START the approved   work.' }),
      () => say('Run queued.'),
    ];
    post('Yes, start the approved work.');
    await runNextJob();
    expect(count('runs')).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE type = 'engineering_run' AND status = 'pending'").get()).toMatchObject({ c: 1 });
    expect(messages().at(-1)?.content).toBe('Run queued.');
  });

  it('refuses to start without an active current approval even with a valid quote', async () => {
    script = [
      () => callTool('request_engineering_run', { approvalId: 'apr_invented', userRequest: 'start the work' }),
      () => say('There is no approval.'),
    ];
    post('start the work');
    await runNextJob();
    expect(count('runs')).toBe(0);
    expect(listApprovalRows(db, projectId)).toEqual([]);
  });

  it.each([
    ['Do not start the approved work.', 'start the approved work'],
    ['Do not start the approved work.', 'Do not start the approved work.'],
    ['Start the approved work only if tests already pass.', 'Start the approved work only if tests already pass.'],
    ['Can you explain how to start the approved work?', 'start the approved work'],
  ])('rejects non-authorizing text even with an active approval: %s', async (message, quote) => {
    const approval = approvedPlan();
    script = [
      () => callTool('request_engineering_run', { approvalId: approval.id, userRequest: quote }),
      () => say('Please send an explicit start command.'),
    ];
    post(message);
    await runNextJob();
    expect(count('runs')).toBe(0);
    expect(JSON.stringify(calls[1]?.input)).toContain('engineering_request_not_quoted');
  });

  it.each(['Where is the greeting?', 'Do not draft a plan.', 'The plan is wrong, but do not change it.'])('does not let a model confirmation invalidate approval: %s', async (message) => {
    const approval = approvedPlan();
    script = [
      () => callTool('draft_project_plan', { request: 'Change the greeting', requirements: ['Add tests'], confirmed: true }),
      () => say('No plan changed.'),
    ];
    post(message);
    await runNextJob();
    expect(latestPlanRow(db, projectId)?.status).toBe('approved');
    expect(listApprovalRows(db, projectId)).toContainEqual(expect.objectContaining({ id: approval.id, status: 'active' }));
    expect(JSON.stringify(calls[1]?.input)).toContain('plan_request_not_confirmed');
  });

  it('aborts the planning provider before the text lease expires and never persists a late plan', async () => {
    let aborted = false;
    setPlanningTransportForTests(() => ({
      create: async (_call, signal) => {
        expect(signal).toBeDefined();
        return await new Promise((_, reject) => {
          signal!.addEventListener('abort', () => { aborted = true; reject(signal!.reason); }, { once: true });
        });
      },
    }));
    script = [() => callTool('draft_project_plan', { request: 'Change greeting', requirements: ['Add tests'], confirmed: true })];
    post('Draft a plan to change the greeting.');
    const job = claimNextJob(db, [TEXT_TURN_JOB_TYPE], 'test-worker', 100)!;
    await handler()(job);
    expect(aborted).toBe(true);
    expect(latestPlanRow(db, projectId)).toBeNull();
    expect(count('runs')).toBe(0);
  });

  it('abandons a superseded turn: no reply, and a pending run request is not executed', async () => {
    const approval = approvedPlan();
    script = [
      () => {
        post('Actually, do not start anything.');
        return callTool('request_engineering_run', { approvalId: approval.id, userRequest: 'start the approved work' });
      },
    ];
    post('start the approved work');
    await runNextJob();
    expect(count('runs')).toBe(0);
    expect(messages().filter((m) => m.role === 'agent')).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('shows provider failures as a fixed secret-free message and never retries', async () => {
    const failing: ResponsesTransport = {
      create: async (call) => {
        calls.push(call);
        throw new Error('401 Bearer synthetic-private-key xai-synthetic-secret-value');
      },
    };
    post('hello');
    await runNextJob(textAssistantHandler({ db, config, retrieval: null, transportFactory: () => failing }));
    const reply = messages().at(-1)!;
    expect(reply.role).toBe('agent');
    expect(reply.content).toContain('model provider call failed');
    expect(reply.content).not.toMatch(/synthetic|Bearer|xai-/);
    expect(calls).toHaveLength(1);
  });

  it.each([
    "UPDATE jobs SET lease_expires_at = 0 WHERE type = 'text_assistant_turn'",
    "UPDATE jobs SET status = 'failed' WHERE type = 'text_assistant_turn'",
    "UPDATE jobs SET claim_epoch = claim_epoch + 1 WHERE type = 'text_assistant_turn'",
  ])('stops side effects and provider calls after losing its claim: %s', async (sql) => {
    const approval = approvedPlan();
    script = [() => {
      db.exec(sql);
      return callTool('request_engineering_run', { approvalId: approval.id, userRequest: 'start the approved work' });
    }];
    post('start the approved work');
    await runNextJob();
    expect(count('runs')).toBe(0);
    expect(calls).toHaveLength(1);
    expect(messages().filter((m) => m.role === 'agent')).toEqual([]);
  });

  it('does not publish a completed provider reply after a newer user message', async () => {
    script = [() => {
      post('Never mind.');
      return say('Outdated answer.');
    }];
    post('Inspect the code.');
    await runNextJob();
    expect(messages().filter((m) => m.role === 'agent')).toEqual([]);
  });

  it('says so visibly when no model credentials or budget ledger are configured', async () => {
    post('hello');
    await runNextJob(textAssistantHandler({ db, config, retrieval: null }));
    expect(messages().at(-1)?.content).toContain('not configured');
  });

  it('bounds the loop: repeated tool calls hit per-tool limits and the provider turn cap', async () => {
    script = Array.from({ length: 30 }, () => () => callTool('get_project_status', {}));
    post('status?');
    await runNextJob();
    expect(calls.length).toBeLessThanOrEqual(8);
    expect(messages().at(-1)?.content).toContain('more steps than one turn allows');
    expect(JSON.stringify(calls.at(-1)?.input)).toContain('tool_call_limit');
  });

  it('declines requests that waited too long in the queue and ignores removed members', async () => {
    const old = post('start the approved work');
    db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(Date.now() - 16 * 60_000, old.id);
    await runNextJob();
    expect(calls).toHaveLength(0);
    expect(messages().at(-1)?.content).toContain('waited too long');

    const row = appendMessageRow(db, conversationId, 'user', 'hello');
    enqueueTextTurn(db, { projectId, conversationId, messageId: row.id, principalId: 'prin_nonmember' });
    await runNextJob();
    expect(calls).toHaveLength(0);
    expect(messages().at(-1)?.content).toBe('hello');
  });

  it('marks an interrupted turn failed with one visible message, once', async () => {
    post('hello');
    const job = claimNextJob(db, [TEXT_TURN_JOB_TYPE], 'dead-worker', 1)!;
    db.prepare('UPDATE jobs SET lease_expires_at = ? WHERE id = ?').run(Date.now() - 1, job.id);
    expect(failInterruptedTextTurns(db)).toBe(1);
    expect(failInterruptedTextTurns(db)).toBe(0);
    expect(messages().filter((m) => m.role === 'agent')).toHaveLength(1);
    expect(db.prepare('SELECT status FROM jobs').get()).toMatchObject({ status: 'failed' });
    // A zombie handler finishing late must not post a second reply.
    script = [() => say('late')];
    await handler()(job);
    expect(messages().filter((m) => m.role === 'agent')).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });
});
