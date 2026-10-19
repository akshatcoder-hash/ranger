import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, withTransaction } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { createConversationRow } from '../../src/conversations/store.js';
import { createPlanVersionRow, approvePlanVersionRow } from '../../src/plans/store.js';
import {
  addVoiceSessionUsage,
  createVoiceSessionRow,
  endVoiceSessionRow,
  getVoiceSessionRow,
} from '../../src/voice/store.js';
import { enqueueVoiceEngineeringRun } from '../../src/voice/tools.js';

/**
 * Deterministic voice session behavior: explicit start/end, terminal
 * idempotent end, observed usage accumulation, and the engineering function
 * enqueuing ONE durable approved run keyed by the provider call id.
 */

const tempDirs: string[] = [];
let db: DatabaseSync;
let projectId: string;
let conversationId: string;
let approvalId: string;
let ownerPrincipalId: string;

function makeSession(): string {
  return withTransaction(db, () =>
    createVoiceSessionRow(db, {
      projectId,
      conversationId,
      principalId: 'prin_owner',
      model: 'grok-voice-3.0',
    }).id,
  );
}

function makeApproval(): string {
  return withTransaction(db, () => {
    const plan = createPlanVersionRow(
      db,
      projectId,
      { items: ['item'], acceptanceCriteria: ['criterion'], permittedScope: ['command'] },
      'req-voice',
    );
    const approval = approvePlanVersionRow(
      db,
      projectId,
      plan.plan.id,
      { permittedScope: ['command'], approvedBy: 'owner' },
      'req-voice',
    );
    return approval.approval.id;
  });
}

beforeEach(() => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-voice-'));
  tempDirs.push(dataDir);
  db = openDatabase(dataDir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Voice Owner' });
  ownerPrincipalId = owner.principalId;
  projectId = createProjectRecord(db, { name: 'Voice', engineerDisplayName: 'Ranger', principalId: owner.principalId }).id;
  conversationId = createConversationRow(db, projectId, 'Voice conversation').id;
  approvalId = makeApproval();
});

afterEach(() => {
  db.close();
  const dir = tempDirs.pop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe('voice session lifecycle', () => {
  it('starts active with the pinned model and a bounded expiry', () => {
    const session = withTransaction(db, () =>
      createVoiceSessionRow(db, { projectId, conversationId, principalId: 'prin_owner', model: 'grok-voice-3.0' }),
    );
    expect(session.state).toBe('active');
    expect(session.model).toBe('grok-voice-3.0');
    expect(session.expiresAt).toBeGreaterThan(session.createdAt);
  });

  it('refuses a conversation that does not belong to the project', () => {
    // A second project owned by the same principal: its conversation is
    // still a foreign identity for this project's voice session.
    const otherProject = createProjectRecord(db, {
      name: 'Other',
      engineerDisplayName: 'Ranger',
      principalId: ownerPrincipalId,
    }).id;
    const foreignConversation = createConversationRow(db, otherProject, 'Foreign').id;
    expect(() =>
      withTransaction(db, () =>
        createVoiceSessionRow(db, { projectId, conversationId: foreignConversation, principalId: 'prin_owner', model: 'grok-voice-3.0' }),
      ),
    ).toThrowError(/does not exist in this project/);
  });

  it('ends terminally and idempotently: a second end returns the same state with no change', () => {
    const sessionId = makeSession();
    const first = withTransaction(db, () => endVoiceSessionRow(db, projectId, sessionId, 'client_requested'));
    expect(first.state).toBe('ended');
    const second = withTransaction(db, () => endVoiceSessionRow(db, projectId, sessionId, 'client_requested'));
    expect(second.state).toBe('ended');
    expect(second.endedAt).toBe(first.endedAt);
    expect(second.endReason).toBe('client_requested');
  });

  it('accumulates observed usage and flushes the residual at end', () => {
    const sessionId = makeSession();
    withTransaction(db, () => addVoiceSessionUsage(db, sessionId, { audioSeconds: 1.25, textTokens: 30, toolCalls: 1 }));
    const ended = withTransaction(db, () =>
      endVoiceSessionRow(db, projectId, sessionId, 'provider_disconnect', { audioSeconds: 0.75, textTokens: 10 }),
    );
    expect(ended.audioSeconds).toBeCloseTo(2.0, 5);
    expect(ended.textTokens).toBe(40);
    expect(ended.toolCalls).toBe(1);
  });

  it('a fresh session after a disconnect gets a NEW id and starts active', () => {
    const first = makeSession();
    withTransaction(db, () => endVoiceSessionRow(db, projectId, first, 'provider_disconnect'));
    const second = makeSession();
    expect(second).not.toBe(first);
    expect(getVoiceSessionRow(db, projectId, second)?.state).toBe('active');
  });
});

describe('voice engineering function', () => {
  it('validates arguments, enqueues ONE durable run and returns its reference', () => {
    makeSession();
    const started = Date.now();
    const reference = enqueueVoiceEngineeringRun(db, {
      projectId,
      conversationId,
      callId: `call_${randomUUID()}`,
      requestId: 'req-voice-tool',
      args: { approvalId },
    });
    expect(reference.runId).toMatch(/^run_/);
    expect(Date.now() - started).toBeLessThan(2000);
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(reference.runId) as { state: string; job_id: string };
    expect(run.state).toBe('queued');
    const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(run.job_id) as { status: string };
    expect(job.status).toBe('pending');
  });

  it('the same provider call id returns the SAME run, never a second run', () => {
    const callId = `call_${randomUUID()}`;
    const first = enqueueVoiceEngineeringRun(db, {
      projectId,
      conversationId,
      callId,
      requestId: 'req-voice-tool',
      args: { approvalId },
    });
    const second = enqueueVoiceEngineeringRun(db, {
      projectId,
      conversationId,
      callId,
      requestId: 'req-voice-tool',
      args: { approvalId },
    });
    expect(second.runId).toBe(first.runId);
    expect(second.replayed).toBe(false);
  });

  it('rejects invalid or unauthorized arguments with a stable error and creates no run', () => {
    const before = (db.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number }).c;
    expect(() =>
      enqueueVoiceEngineeringRun(db, {
        projectId,
        conversationId,
        callId: `call_${randomUUID()}`,
        requestId: 'req-voice-tool',
        args: { approvalId: 'not-an-id' },
      }),
    ).toThrowError(/approvalId/);
    expect(() =>
      enqueueVoiceEngineeringRun(db, {
        projectId,
        conversationId,
        callId: `call_${randomUUID()}`,
        requestId: 'req-voice-tool',
        args: { approvalId: 'apr_does-not-exist' },
      }),
    ).toThrowError(/does not exist/);
    const after = (db.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number }).c;
    expect(after).toBe(before);
  });
});
