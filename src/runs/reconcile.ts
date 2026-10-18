import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db/db.js';
import { appendProjectEvent } from '../events/store.js';
import { confirmInstaboxCreation, recordInstaboxRelease, releaseInstaboxReservation } from '../budget/ledger.js';
import { failStaleRun, getRunRow, type RunRow } from './store.js';
import { listCommandsForRun, getWorkspace, markWorkspaceDestroyed } from '../workspace/store.js';
import { terminateCommandRow } from '../workspace/terminate.js';
import { closeRecordedSessions } from '../workspace/cleanup.js';
import type { InstaboxProvider } from '../workspace/provider.js';

/**
 * Reconciliation controller: the honest end for interrupted work.
 *
 * When the control worker died or its lease expired, a later controller
 * marks the run FAILED with a real reason, fences the stale worker so it
 * can never commit, terminates remaining command descendants and destroys
 * the recorded workspace. It NEVER resumes model/tool work, restores a
 * checkpoint or automatically retries: the user starts a new approved run.
 *
 * This also carries the narrow provider-accounting reconciliation that is
 * NOT run recovery: an uncertain Instabox create resolves its recorded
 * identity (destroy + settle accounting) or stops without a second create.
 */

export interface ReconcileDeps {
  db: DatabaseSync;
  /** The Instabox provider, or a lazy resolver (credentials read on first use). */
  provider: InstaboxProvider | (() => InstaboxProvider);
  ledgerFile: string | null;
}

export interface ReconcileReport {
  failedRuns: string[];
  terminatedCommands: number;
  destroyedWorkspaces: string[];
  resolvedUncertainWorkspaces: number;
}

/** Find runs whose worker lease expired while still queued/running. */
function staleRunRows(db: DatabaseSync, now: number): RunRow[] {
  const rows = db
    .prepare(
      `SELECT r.* FROM runs r
       WHERE r.state IN ('queued', 'running')
         AND (
           (r.lease_expires_at IS NOT NULL AND r.lease_expires_at < ?)
           OR (
             r.lease_expires_at IS NULL AND EXISTS (
               SELECT 1 FROM jobs j
               WHERE j.id = r.job_id AND j.status = 'claimed'
                 AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at < ?
             )
           )
         )`,
    )
    .all(now, now) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row['id']),
    projectId: String(row['project_id']),
    conversationId: String(row['conversation_id']),
    approvalId: String(row['approval_id']),
    planId: String(row['plan_id']),
    planVersion: Number(row['plan_version']),
    state: String(row['state']) as RunRow['state'],
    failureCode: (row['failure_code'] as string | null) ?? null,
    failureMessage: (row['failure_message'] as string | null) ?? null,
    usageJson: (row['usage_json'] as string | null) ?? null,
    turns: (row['turns'] as number | null) ?? null,
    jobId: String(row['job_id']),
    workerId: (row['worker_id'] as string | null) ?? null,
    claimEpoch: (row['claim_epoch'] as number | null) ?? null,
    leaseExpiresAt: (row['lease_expires_at'] as number | null) ?? null,
    cancelRequested: Number(row['cancel_requested']) === 1,
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    startedAt: (row['started_at'] as number | null) ?? null,
    finishedAt: (row['finished_at'] as number | null) ?? null,
  }));
}

export async function reconcileInterruptedRuns(deps: ReconcileDeps): Promise<ReconcileReport> {
  const provider = typeof deps.provider === 'function' ? deps.provider() : deps.provider;
  const { db, ledgerFile } = deps;
  const now = Date.now();
  const report: ReconcileReport = {
    failedRuns: [],
    terminatedCommands: 0,
    destroyedWorkspaces: [],
    resolvedUncertainWorkspaces: 0,
  };

  for (const run of staleRunRows(db, now)) {
    // 1. Fail the durable job so no later loop picks it up.
    db.prepare(
      "UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'claimed')",
    ).run('control worker interrupted or lease expired', now, run.jobId);

    // 2. Explicitly fail the run. From this commit on, the stale worker's
    // own completion is rejected by the run-state fencing.
    const failed = failStaleRun(db, run.id, 'control_worker_lease_expired', 'The control worker died or its lease expired; model and tool work is never resumed or retried.');
    if (failed !== null) {
      withTransaction(db, () => {
        appendProjectEvent(db, {
          projectId: run.projectId,
          runId: run.id,
          type: 'run.state.changed',
          data: { runId: run.id, from: run.state, to: 'failed', reason: 'control_worker_lease_expired' },
          requestId: `reconcile_${randomUUID()}`,
        });
      });
      report.failedRuns.push(run.id);
    }

    // 3. Cancel remaining command descendants and destroy the recorded
    // workspace (owned resources only, never a new provider action). Both
    // background (recorded pid) and supervised foreground (discovery
    // marker) commands are terminated with TERM then a liveness-checked
    // KILL; recorded desktop/preview sessions close before the machine.
    const ws = getWorkspace(db, run.projectId);
    for (const command of listCommandsForRun(db, run.id)) {
      if (command.state !== 'running' || ws?.machineId === null || ws === null) continue;
      try {
        await terminateCommandRow(provider, ws.machineId, command);
        report.terminatedCommands += 1;
      } catch {
        // Best effort: the machine may already be gone.
      }
    }
    if (ws !== null && ws.machineId !== null && ws.observedState !== 'destroyed' && !ws.uncertain) {
      try {
        // Destroy the machine FIRST: a session-close failure must never leave
        // a provider resource alive. If the kill itself fails the row stays
        // recorded so the sweep below (and later sweeps) retry the destroy.
        await provider.kill(ws.machineId);
        try {
          await closeRecordedSessions({ db, provider, projectId: run.projectId });
        } catch {
          // Session closure is best effort once the machine is gone.
        }
        if (ledgerFile !== null && ws.reservationId !== null) {
          recordInstaboxRelease(ledgerFile, ws.machineId);
        }
        markWorkspaceDestroyed(db, run.projectId);
        report.destroyedWorkspaces.push(ws.machineId);
      } catch {
        // Best effort: the next sweep retries via the orphan sweep below.
      }
    }
  }

  report.destroyedWorkspaces.push(...(await destroyOrphanedWorkspaces({ db, provider, ledgerFile })));

  report.resolvedUncertainWorkspaces = await reconcileUncertainWorkspaces({ db, provider, ledgerFile });
  return report;
}

/**
 * Destroy recorded workspaces whose project has no active run. This covers
 * the window between "run failed" and "workspace destroyed": if the destroy
 * of a failed run's machine failed once (or the control process died right
 * after the run was failed), later sweeps still reclaim the provider
 * resource and settle the ledger. Never creates anything.
 */
async function destroyOrphanedWorkspaces(deps: { db: DatabaseSync; provider: InstaboxProvider; ledgerFile: string | null }): Promise<string[]> {
  const { db, provider, ledgerFile } = deps;
  const rows = db
    .prepare(
      `SELECT w.project_id, w.machine_id, w.reservation_id FROM workspaces w
       WHERE w.machine_id IS NOT NULL AND w.observed_state != 'destroyed' AND w.uncertain = 0
         AND w.observed_state != 'uncertain'
         AND NOT EXISTS (
           SELECT 1 FROM runs r WHERE r.project_id = w.project_id AND r.state IN ('queued', 'running')
         )`,
    )
    .all() as Array<{ project_id: string; machine_id: string; reservation_id: string | null }>;
  const destroyed: string[] = [];
  for (const row of rows) {
    try {
      await provider.kill(row.machine_id);
      if (ledgerFile !== null && row.reservation_id !== null) {
        recordInstaboxRelease(ledgerFile, row.machine_id);
      }
      markWorkspaceDestroyed(db, row.project_id);
      destroyed.push(row.machine_id);
    } catch {
      // Unreclaimable this sweep: reported by the next sweep, never guessed.
    }
  }
  return destroyed;
}

/**
 * Resolve uncertain Instabox creates for cleanup and accounting. This is
 * the narrow safety reconciliation from the contract — never a second
 * create, never run recovery.
 */
async function reconcileUncertainWorkspaces(deps: { db: DatabaseSync; provider: InstaboxProvider; ledgerFile: string | null }): Promise<number> {
  const { db, provider, ledgerFile } = deps;  const rows = db
    .prepare("SELECT project_id, operation_key, reservation_id FROM workspaces WHERE uncertain = 1 AND observed_state = 'uncertain'")
    .all() as Array<{ project_id: string; operation_key: string; reservation_id: string | null }>;
  let resolved = 0;
  for (const row of rows) {
    try {
      // Resolve the recorded provider identity from the durable operation key.
      const machine = await provider.listByOperation(row.operation_key);
      if (machine !== null) {
        // The machine exists: settle the creation record, destroy it, record
        // the release. Exactly one creation is accounted — never another.
        if (ledgerFile !== null && row.reservation_id !== null) {
          confirmInstaboxCreation(ledgerFile, { reservationId: row.reservation_id, machineId: machine.machineId, purpose: row.project_id });
        }
        await provider.kill(machine.machineId);
        if (ledgerFile !== null) {
          recordInstaboxRelease(ledgerFile, machine.machineId);
        }
      } else if (ledgerFile !== null && row.reservation_id !== null) {
        // The create never landed: release the outstanding reservation.
        releaseInstaboxReservation(ledgerFile, row.reservation_id);
      }
      markWorkspaceDestroyed(db, row.project_id);
      resolved += 1;
    } catch {
      // Unresolvable accounting stays uncertain and reported, never guessed.
    }
  }
  return resolved;
}

/** Exposed for tests: the current persisted run row (post-reconcile check). */
export function runAfterReconcile(db: DatabaseSync, runId: string): RunRow | null {
  return getRunRow(db, runId);
}
