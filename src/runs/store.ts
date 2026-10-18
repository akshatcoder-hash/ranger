import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { mapRow, mapRows } from '../db/db.js';

/**
 * Durable run rows with worker fencing.
 *
 * A run binds one active approval of the project's current plan version.
 * Exactly one run may be queued/running at a time (one active run globally).
 * The executing worker is fenced by (worker_id, claim_epoch): only the
 * current claim can transition the run to a terminal state, so a stale or
 * dead worker can never commit completion. Interrupted runs are failed
 * explicitly by a later controller (see runs/reconcile.ts) — never resumed.
 */

export type RunState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RunRow {
  id: string;
  projectId: string;
  conversationId: string;
  approvalId: string;
  planId: string;
  planVersion: number;
  state: RunState;
  failureCode: string | null;
  failureMessage: string | null;
  usageJson: string | null;
  turns: number | null;
  jobId: string;
  workerId: string | null;
  claimEpoch: number | null;
  leaseExpiresAt: number | null;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface RunToolOutcomeRow {
  id: string;
  runId: string;
  callId: string;
  name: string;
  status: string;
  resultJson: string | null;
  error: string | null;
  createdAt: number;
}

interface RunSqlRow {
  id: string;
  project_id: string;
  conversation_id: string;
  approval_id: string;
  plan_id: string;
  plan_version: number;
  state: RunState;
  failure_code: string | null;
  failure_message: string | null;
  usage_json: string | null;
  turns: number | null;
  job_id: string;
  worker_id: string | null;
  claim_epoch: number | null;
  lease_expires_at: number | null;
  cancel_requested: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function mapRun(row: RunSqlRow): RunRow {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    approvalId: row.approval_id,
    planId: row.plan_id,
    planVersion: row.plan_version,
    state: row.state,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    usageJson: row.usage_json,
    turns: row.turns,
    jobId: row.job_id,
    workerId: row.worker_id,
    claimEpoch: row.claim_epoch,
    leaseExpiresAt: row.lease_expires_at,
    cancelRequested: row.cancel_requested === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function insertRun(
  db: DatabaseSync,
  input: {
    projectId: string;
    conversationId: string;
    approvalId: string;
    planId: string;
    planVersion: number;
    jobId: string;
  },
): { runId: string; jobId: string } {
  const runId = `run_${randomUUID()}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO runs (id, project_id, conversation_id, approval_id, plan_id, plan_version, state, job_id, cancel_requested, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?)`,
  ).run(runId, input.projectId, input.conversationId, input.approvalId, input.planId, input.planVersion, input.jobId, now, now);
  return { runId, jobId: input.jobId };
}

export function getRunRow(db: DatabaseSync, runId: string): RunRow | null {
  const row = mapRow<RunSqlRow>(db.prepare('SELECT * FROM runs WHERE id = ?').get(runId));
  return row === undefined ? null : mapRun(row);
}

export function getRunRowForProject(db: DatabaseSync, projectId: string, runId: string): RunRow | null {
  const row = mapRow<RunSqlRow>(db.prepare('SELECT * FROM runs WHERE id = ? AND project_id = ?').get(runId, projectId));
  return row === undefined ? null : mapRun(row);
}

export function listRunRows(db: DatabaseSync, projectId: string): RunRow[] {
  return mapRows<RunSqlRow>(db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY created_at, id').all(projectId)).map(mapRun);
}

/** The single globally active (queued or running) run, if any. */
export function activeRunRow(db: DatabaseSync): RunRow | null {
  const row = mapRow<RunSqlRow>(
    db.prepare("SELECT * FROM runs WHERE state IN ('queued', 'running') ORDER BY created_at LIMIT 1").get(),
  );
  return row === undefined ? null : mapRun(row);
}

/** Bind a queued run to one worker claim (fenced). Null when already taken. */
export function bindRunClaim(
  db: DatabaseSync,
  runId: string,
  input: { workerId: string; claimEpoch: number; jobId: string; leaseMs: number },
): RunRow | null {
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE runs
          SET state = 'running', worker_id = ?, claim_epoch = ?, lease_expires_at = ?, started_at = ?, updated_at = ?
        WHERE id = ? AND job_id = ? AND state = 'queued'`,
    )
    .run(input.workerId, input.claimEpoch, now + input.leaseMs, now, now, runId, input.jobId);
  if (result.changes === 0) return null;
  return getRunRow(db, runId);
}

/** Renew the lease; zero changes means the claim was fenced away. */
export function renewRunLease(db: DatabaseSync, runId: string, workerId: string, claimEpoch: number, leaseMs: number): boolean {
  const result = db
    .prepare("UPDATE runs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND worker_id = ? AND claim_epoch = ? AND state = 'running'")
    .run(Date.now() + leaseMs, Date.now(), runId, workerId, claimEpoch);
  return result.changes > 0;
}

/** Flag a cancel request; true when the run was still live. */
export function requestCancel(db: DatabaseSync, runId: string): boolean {
  const result = db
    .prepare("UPDATE runs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND state IN ('queued', 'running')")
    .run(Date.now(), runId);
  return result.changes > 0;
}

/** Mark a queued (never claimed) run cancelled after a cancel request. */
export function cancelQueuedRun(db: DatabaseSync, runId: string): RunRow | null {
  const now = Date.now();
  const result = db
    .prepare("UPDATE runs SET state = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ? AND state = 'queued'")
    .run(now, now, runId);
  if (result.changes === 0) return null;
  return getRunRow(db, runId);
}

/** Fail a stale claim from the reconciliation controller (fenced by state). */
export function failStaleRun(db: DatabaseSync, runId: string, failureCode: string, failureMessage: string): RunRow | null {
  const now = Date.now();
  const result = db
    .prepare(
      "UPDATE runs SET state = 'failed', failure_code = ?, failure_message = ?, finished_at = ?, updated_at = ? WHERE id = ? AND state IN ('queued', 'running')",
    )
    .run(failureCode, failureMessage, now, now, runId);
  if (result.changes === 0) return null;
  return getRunRow(db, runId);
}

/**
 * Terminal completion by the CURRENT worker claim. Null when the claim is
 * stale (dead worker, fenced out) or the run already reached a terminal
 * state — a stale completion is always rejected.
 */
export function completeRunFromWorker(
  db: DatabaseSync,
  runId: string,
  input: {
    workerId: string;
    claimEpoch: number;
    state: 'succeeded' | 'failed' | 'cancelled';
    failureCode?: string;
    failureMessage?: string;
    usage?: { inputTokens: number; outputTokens: number; costUsd: number } | null;
    turns?: number;
  },
): RunRow | null {
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE runs
          SET state = ?, failure_code = ?, failure_message = ?, usage_json = ?, turns = ?, finished_at = ?, updated_at = ?
        WHERE id = ? AND worker_id = ? AND claim_epoch = ? AND state = 'running'`,
    )
    .run(
      input.state,
      input.failureCode ?? null,
      input.failureMessage ?? null,
      input.usage === undefined || input.usage === null ? null : JSON.stringify(input.usage),
      input.turns ?? null,
      now,
      now,
      runId,
      input.workerId,
      input.claimEpoch,
    );
  if (result.changes === 0) return null;
  return getRunRow(db, runId);
}

export function insertRunToolOutcome(
  db: DatabaseSync,
  input: { runId: string; callId: string; name: string; status: string; resultJson?: string | null; error?: string | null },
): RunToolOutcomeRow {
  const id = `rto_${randomUUID()}`;
  const row: RunToolOutcomeRow = {
    id,
    runId: input.runId,
    callId: input.callId,
    name: input.name,
    status: input.status,
    resultJson: input.resultJson ?? null,
    error: input.error ?? null,
    createdAt: Date.now(),
  };
  db.prepare(
    'INSERT INTO run_tool_outcomes (id, run_id, call_id, name, status, result_json, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(row.id, row.runId, row.callId, row.name, row.status, row.resultJson, row.error, row.createdAt);
  return row;
}

export function listRunToolOutcomes(db: DatabaseSync, runId: string): RunToolOutcomeRow[] {
  // rowid breaks created_at ties in insertion order (same-ms outcomes).
  return mapRows<{ id: string; run_id: string; call_id: string; name: string; status: string; result_json: string | null; error: string | null; created_at: number }>(
    db.prepare('SELECT * FROM run_tool_outcomes WHERE run_id = ? ORDER BY created_at, rowid').all(runId),
  ).map((row) => ({
    id: row.id,
    runId: row.run_id,
    callId: row.call_id,
    name: row.name,
    status: row.status,
    resultJson: row.result_json,
    error: row.error,
    createdAt: row.created_at,
  }));
}
