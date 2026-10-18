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
  activeRunRow,
  bindRunClaim,
  completeRunFromWorker,
  insertRun,
  insertRunToolOutcome,
  listRunToolOutcomes,
  requestCancel,
} from '../../src/runs/store.js';

/**
 * Deterministic run-store tests: state transitions, worker fencing (a stale
 * worker can never commit) and durable tool-outcome records.
 */

const tempDirs: string[] = [];
let db: DatabaseSync;
let projectId: string;
let conversationId: string;

function makeRun(): { runId: string; jobId: string } {
  // Store mutations append events, so they run inside one transaction.
  return withTransaction(db, () => {
    const plan = createPlanVersionRow(db, projectId, {
      items: ['item'],
      acceptanceCriteria: ['criterion'],
      permittedScope: ['command', 'edit:src/'],
    }, 'req-run');
    const approval = approvePlanVersionRow(db, projectId, plan.plan.id, { permittedScope: ['command', 'edit:src/'], approvedBy: 'x' }, 'req-run');
    return insertRun(db, {
      projectId,
      conversationId,
      approvalId: approval.approval.id,
      planId: plan.plan.id,
      planVersion: plan.plan.version,
      jobId: `job_run_${randomUUID()}`,
    });
  });
}

beforeEach(() => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-runs-'));
  tempDirs.push(dataDir);
  db = openDatabase(dataDir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Runs Owner' });
  projectId = createProjectRecord(db, { name: 'Runs', engineerDisplayName: 'Ranger', principalId: owner.principalId }).id;
  conversationId = createConversationRow(db, projectId, 'Run conversation').id;
});

afterEach(() => {
  db.close();
  const dir = tempDirs.pop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe('run lifecycle fencing', () => {
  it('binds a queued run to a worker claim and rejects a stale completion', () => {
    const { runId, jobId } = makeRun();
    const bound = bindRunClaim(db, runId, { workerId: 'worker-A', claimEpoch: 3, jobId, leaseMs: 1000 });
    expect(bound).not.toBeNull();
    expect(bound!.state).toBe('running');

    // A different worker/epoch can never commit completion.
    const stale = completeRunFromWorker(db, runId, {
      workerId: 'worker-B',
      claimEpoch: 3,
      state: 'succeeded',
    });
    expect(stale).toBeNull();
    const staleEpoch = completeRunFromWorker(db, runId, { workerId: 'worker-A', claimEpoch: 2, state: 'succeeded' });
    expect(staleEpoch).toBeNull();

    const valid = completeRunFromWorker(db, runId, { workerId: 'worker-A', claimEpoch: 3, state: 'succeeded' });
    expect(valid).not.toBeNull();
    expect(valid!.state).toBe('succeeded');
    expect(bindRunClaim(db, runId, { workerId: 'worker-C', claimEpoch: 9, jobId, leaseMs: 1000 })).toBeNull();
  });

  it('exposes the one globally active run and refuses none when terminal', () => {
    expect(activeRunRow(db)).toBeNull();
    const first = makeRun();
    expect(activeRunRow(db)!.id).toBe(first.runId);
    bindRunClaim(db, first.runId, { workerId: 'w', claimEpoch: 1, jobId: first.jobId, leaseMs: 1000 });
    completeRunFromWorker(db, first.runId, { workerId: 'w', claimEpoch: 1, state: 'failed', failureCode: 'test', failureMessage: 'honest failure' });
    expect(activeRunRow(db)).toBeNull();
    const second = makeRun();
    expect(activeRunRow(db)!.id).toBe(second.runId);
  });

  it('records a cancel request only while the run is live', () => {
    const { runId, jobId } = makeRun();
    expect(requestCancel(db, runId)).toBe(true); // queued runs are cancellable before any claim
    bindRunClaim(db, runId, { workerId: 'w', claimEpoch: 1, jobId, leaseMs: 1000 });
    expect(requestCancel(db, runId)).toBe(true);
    completeRunFromWorker(db, runId, { workerId: 'w', claimEpoch: 1, state: 'cancelled' });
    expect(requestCancel(db, runId)).toBe(false);
  });

  it('persists bounded tool outcomes with their run', () => {
    const { runId } = makeRun();
    insertRunToolOutcome(db, { runId, callId: 'call_1', name: 'edit_file', status: 'ok', resultJson: '{"path":"src/index.ts"}' });
    insertRunToolOutcome(db, { runId, callId: 'call_2', name: 'run_tests', status: 'denied', error: 'approval_denied: scope' });
    const outcomes = listRunToolOutcomes(db, runId);
    expect(outcomes.map((o) => o.callId)).toEqual(['call_1', 'call_2']);
    expect(outcomes[0]!.name).toBe('edit_file');
    expect(outcomes[1]!.status).toBe('denied');
  });
});
