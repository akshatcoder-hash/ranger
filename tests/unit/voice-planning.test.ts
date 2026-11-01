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
import { appendMessageRow, appendThreadVersion, createConversationRow, listMessageRows, listVersionedThreads } from '../../src/conversations/store.js';
import { approvePlanVersionRow, createPlanVersionRow, latestPlanRow, listApprovalRows } from '../../src/plans/store.js';
import { createVoiceSessionRow, endVoiceSessionRow } from '../../src/voice/store.js';
import { setPlanningTransportForTests } from '../../src/planning/runtime.js';
import type { ResponsesCall, ResponsesResult } from '../../src/agent/transport.js';
import { enqueueVoiceEngineeringRun, runVoicePlanTool, type VoiceToolInput } from '../../src/voice/tools.js';

/** Real persistence/service, scripted model protocol only. No provider calls or paid ledger. */
describe('voice drafting and human approval boundary (offline)', () => {
  let db: DatabaseSync;
  let dataDir: string;
  let config: RangerConfig;
  let input: VoiceToolInput;
  let calls: ResponsesCall[];
  const plan = {
    items: ['Update src/greeting.ts to use the confirmed welcome copy'],
    acceptanceCriteria: ['The greeting unit test checks the exact welcome copy'],
    permittedScope: ['edit:src/greeting.ts', 'command'],
    decisions: ['Keep the existing application design'], impactedPaths: [], impactedTests: [],
  };
  const response = (): ResponsesResult => ({
    responseId: 'offline-plan', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(plan) }] }],
  });

  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-voice-plan-'));
    config = await loadConfig({ RANGER_DATA_DIR: dataDir });
    db = openDatabase(dataDir);
    runMigrations(db, path.join(process.cwd(), 'migrations'));
    const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Voice planning' });
    const projectId = createProjectRecord(db, { name: 'Voice draft', engineerDisplayName: 'Ranger', principalId: owner.principalId }).id;
    const conversationId = createConversationRow(db, projectId, 'Changes').id;
    const session = createVoiceSessionRow(db, { projectId, conversationId, principalId: owner.principalId, model: 'grok-voice-3.0' });
    input = { db, retrieval: null, projectId, conversationId, sessionId: session.id, principalId: owner.principalId, callId: 'draft-1', requestId: 'req-draft', args: { request: 'Change the greeting in src/greeting.ts', requirements: ['Use the welcome copy we confirmed and verify it with the unit test'], confirmed: true } };
    calls = [];
    setPlanningTransportForTests(() => ({ create: async (call) => { calls.push(call); return response(); } }));
  });

  afterEach(() => {
    setPlanningTransportForTests(null);
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('records a labelled confirmed summary, drafts through PlanningService, and requires exact human approval before a run', async () => {
    const result = await runVoicePlanTool({ config }, input);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]?.input)).toContain('src/greeting.ts');
    expect(result.output).toMatchObject({ plan: { version: 1, status: 'draft', permittedScope: plan.permittedScope }, engineeringStarted: false });
    const messages = listMessageRows(db, input.conversationId, { afterOrdinal: 0, limit: 20 }).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'agent' });
    expect(messages[0]?.content).toContain('not a verbatim transcript');
    expect(listVersionedThreads(db, 'requirement', input.projectId)).toHaveLength(2);
    expect(listApprovalRows(db, input.projectId)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS c FROM runs').get()).toMatchObject({ c: 0 });
    expect(() => enqueueVoiceEngineeringRun(db, { ...input, args: { approvalId: 'apr_missing' } })).toThrow();
    const saved = latestPlanRow(db, input.projectId)!;
    const approved = withTransaction(db, () => approvePlanVersionRow(db, input.projectId, saved.id, { approvedBy: input.principalId, permittedScope: saved.permittedScope }, 'req-human-approval'));
    const run = enqueueVoiceEngineeringRun(db, { ...input, callId: 'start-after-human-approval', args: { approvalId: approved.approval.id } });
    expect(run.runId).toMatch(/^run_/);
  });

  it('replays a completed request without a second model call, summary, or plan and rejects changed input', async () => {
    const first = await runVoicePlanTool({ config }, input);
    const second = await runVoicePlanTool({ config }, input);
    expect(second).toEqual({ ...first, replayed: true });
    await expect(runVoicePlanTool({ config }, { ...input, args: { ...(input.args as object), request: 'Different change' } })).rejects.toMatchObject({ details: { reason: 'idempotency_key_reuse' } });
    expect(calls).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS c FROM plan_versions').get()).toMatchObject({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM messages').get()).toMatchObject({ c: 1 });
  });

  it('passes every maximum-sized confirmed requirement to planning without truncating later items', async () => {
    for (let index = 0; index < 60; index += 1) appendMessageRow(db, input.conversationId, 'user', `Older conversation message ${index}`);
    const requirements = Array.from({ length: 12 }, (_, index) => `${'x'.repeat(970)} last-required-condition-${index}`);
    await runVoicePlanTool({ config }, { ...input, args: { request: 'r'.repeat(4000), requirements, confirmed: true } });
    const sent = JSON.stringify(calls[0]?.input);
    expect(sent).toContain('r'.repeat(4000));
    for (const requirement of requirements) expect(sent).toContain(requirement);
    expect(listVersionedThreads(db, 'requirement', input.projectId)).toHaveLength(13);
  });

  it.each([
    { confirmed: false }, { confirmed: undefined }, { requirements: [] }, { requirements: [''] },
    { projectId: 'prj_override' }, { approvalId: 'apr_override' }, { request: 'x'.repeat(4001) },
  ])('rejects missing confirmation or invalid/overriding arguments before any mutation or call: %j', async (change) => {
    await expect(runVoicePlanTool({ config }, { ...input, args: { ...(input.args as object), ...change } })).rejects.toMatchObject({ details: { reason: 'plan_draft_args_invalid' } });
    expect(calls).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM messages').get()).toMatchObject({ c: 0 });
  });

  it('invalidates a materially changed prior approval but never widens or approves it', async () => {
    const old = withTransaction(db, () => {
      const previous = createPlanVersionRow(db, input.projectId, { items: ['Old request'], acceptanceCriteria: ['Old criterion'], permittedScope: ['command'] }, 'req-old').plan;
      return approvePlanVersionRow(db, input.projectId, previous.id, { approvedBy: input.principalId, permittedScope: ['command'] }, 'req-old').approval;
    });
    const result = await runVoicePlanTool({ config }, input);
    expect(result.output).toMatchObject({ plan: { version: 2, status: 'draft' }, invalidatedApprovalIds: [old.id], engineeringStarted: false });
    expect(listApprovalRows(db, input.projectId)).toEqual([expect.objectContaining({ id: old.id, status: 'invalidated', permittedScope: ['command'] })]);
  });

  it('keeps an identical already-approved plan without creating approval or starting work', async () => {
    const existing = withTransaction(db, () => {
      const previous = createPlanVersionRow(db, input.projectId, plan, 'req-old').plan;
      return approvePlanVersionRow(db, input.projectId, previous.id, { approvedBy: input.principalId, permittedScope: previous.permittedScope }, 'req-old');
    });
    const result = await runVoicePlanTool({ config }, input);
    expect(result.output).toMatchObject({ plan: { planId: existing.plan.id, version: 1, status: 'approved' }, invalidatedApprovalIds: [], engineeringStarted: false });
    expect(listApprovalRows(db, input.projectId)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS c FROM runs').get()).toMatchObject({ c: 0 });
  });

  it('exposes proposed preview scope for review without granting it', async () => {
    setPlanningTransportForTests(() => ({ create: async () => ({ ...response(), output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ ...plan, permittedScope: [...plan.permittedScope, 'launch', 'evidence'] }) }] }] }) }));
    const result = await runVoicePlanTool({ config }, input);
    expect(result.output).toMatchObject({ plan: { status: 'draft', permittedScope: [...plan.permittedScope, 'launch', 'evidence'] }, engineeringStarted: false });
    expect(listApprovalRows(db, input.projectId)).toEqual([]);
  });

  it('refuses ended sessions and foreign conversations before any paid work', async () => {
    await expect(runVoicePlanTool({ config }, { ...input, principalId: 'prin_nonmember' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(runVoicePlanTool({ config }, { ...input, conversationId: 'cnv_foreign' })).rejects.toThrow('Conversation not found');
    endVoiceSessionRow(db, input.projectId, input.sessionId, 'client_requested');
    await expect(runVoicePlanTool({ config }, input)).rejects.toMatchObject({ details: { reason: 'session_ended' } });
    expect(calls).toHaveLength(0);
  });

  it('does not retry failed provider calls, even when the same call id arrives later', async () => {
    setPlanningTransportForTests(() => ({ create: async (call) => { calls.push(call); throw new Error('Bearer synthetic-private-key'); } }));
    await expect(runVoicePlanTool({ config }, input)).rejects.toMatchObject({ message: expect.not.stringContaining('synthetic-private-key'), details: { reason: 'plan_draft_failed' } });
    // The chat only shows a conflict, so the cause has to survive in the project's events.
    const failed = db.prepare("SELECT data FROM project_events WHERE project_id = ? AND type = 'plan.draft.failed'").all(input.projectId);
    expect(failed).toHaveLength(1);
    expect(JSON.parse(String(failed[0]!.data))).toMatchObject({ reason: 'plan_draft_failed' });
    expect(String(failed[0]!.data)).not.toContain('synthetic-private-key');
    await expect(runVoicePlanTool({ config }, input)).rejects.toMatchObject({ details: { reason: 'plan_draft_already_attempted' } });
    expect(calls).toHaveLength(1);
    expect(latestPlanRow(db, input.projectId)).toBeNull();
  });

  it('names a rejected plan as the cause instead of a generic draft failure', async () => {
    setPlanningTransportForTests(() => ({ create: async () => ({ ...response(), output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ ...plan, permittedScope: ['deploy'] }) }] }] }) }));
    await expect(runVoicePlanTool({ config }, input)).rejects.toMatchObject({ details: { reason: 'prohibited_scope' } });
    const failed = db.prepare("SELECT data FROM project_events WHERE project_id = ? AND type = 'plan.draft.failed'").all(input.projectId);
    expect(failed.map((row) => JSON.parse(String(row.data)))).toEqual([{ reason: 'prohibited_scope' }]);
  });

  it('blocks concurrent drafts and refuses a stale model answer if the plan changed while waiting', async () => {
    let release!: (result: ResponsesResult) => void;
    setPlanningTransportForTests(() => ({ create: async (call) => { calls.push(call); return new Promise((resolve) => { release = resolve; }); } }));
    const pending = runVoicePlanTool({ config }, input);
    await expect(runVoicePlanTool({ config }, { ...input, callId: 'draft-2' })).rejects.toMatchObject({ details: { reason: 'plan_draft_in_progress' } });
    const newer = withTransaction(db, () => createPlanVersionRow(db, input.projectId, { items: ['A newer operator plan'], acceptanceCriteria: ['Human criterion'], permittedScope: ['command'] }, 'req-newer').plan);
    release(response());
    await expect(pending).rejects.toMatchObject({ details: { reason: 'plan_draft_stale' } });
    expect(latestPlanRow(db, input.projectId)?.id).toBe(newer.id);
    expect(calls).toHaveLength(1);
  });

  it('discards a draft if the user ends the call while the model is working', async () => {
    let release!: (result: ResponsesResult) => void;
    setPlanningTransportForTests(() => ({ create: async () => new Promise((resolve) => { release = resolve; }) }));
    const pending = runVoicePlanTool({ config }, input);
    endVoiceSessionRow(db, input.projectId, input.sessionId, 'client_requested');
    release(response());
    await expect(pending).rejects.toMatchObject({ details: { reason: 'session_ended' } });
    expect(latestPlanRow(db, input.projectId)).toBeNull();
    expect(listApprovalRows(db, input.projectId)).toEqual([]);
  });

  it.each(['requirement', 'message'])('discards a draft if a %s changes while generation is pending', async (kind) => {
    let release!: (result: ResponsesResult) => void;
    setPlanningTransportForTests(() => ({ create: async () => new Promise((resolve) => { release = resolve; }) }));
    const pending = runVoicePlanTool({ config }, input);
    if (kind === 'message') appendMessageRow(db, input.conversationId, 'user', 'Actually preserve the greeting and change the footer.');
    else {
      const requirement = listVersionedThreads(db, 'requirement', input.projectId)[0]!;
      appendThreadVersion(db, 'requirement', input.projectId, requirement.thread.id, 'Do not change the greeting.');
    }
    release(response());
    await expect(pending).rejects.toMatchObject({ details: { reason: 'plan_draft_stale' } });
    expect(latestPlanRow(db, input.projectId)).toBeNull();
    expect(listApprovalRows(db, input.projectId)).toEqual([]);
  });
});
