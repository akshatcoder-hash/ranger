import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyRequest } from 'fastify';
import { Errors } from '../errors.js';
import { appendProjectEvent } from '../events/store.js';
import { getApprovalRow, latestPlanRow } from '../plans/store.js';
import { getConversationRow } from '../conversations/store.js';
import {
  activeRunRow,
  cancelQueuedRun,
  getRunRowForProject,
  insertRun,
  listRunRows,
  requestCancel,
  type RunRow,
} from './store.js';
import { idempotencyKeyFrom, requestHash, withIdempotentMutation } from '../http/idempotency.js';

/**
 * Public run control: start (durable, asynchronous), status and cancel.
 *
 * startRun validates the persisted exact-version approval and enqueues ONE
 * durable job; the worker executes it outside any API request, so launch
 * returns promptly. Cancelling flags the run durably and terminates its real
 * command descendants through the workspace primitive; the worker confirms
 * the cancelled state. Interrupted runs are handled by the reconciliation
 * controller, never resumed.
 */

export const RUN_JOB_TYPE = 'engineering_run';

export interface StartRunInput {
  projectId: string;
  conversationId: string;
  approvalId: string;
}

/** Start one run from an approved plan (idempotent by scoped key). */
export function startRun(db: DatabaseSync, req: FastifyRequest, input: StartRunInput): RunRow {
  return withIdempotentMutation(db, {
    scope: `startRun:${input.projectId}:${req.principalId ?? 'unauthenticated'}`,
    key: idempotencyKeyFrom(req),
    requestHash: requestHash({ params: { projectId: input.projectId }, body: { conversationId: input.conversationId, approvalId: input.approvalId } }),
    // All state-dependent validation lives INSIDE the mutation so an exact
    // retry REPLAYS the stored result instead of tripping the one-active-run
    // check against the run the first attempt created. State + event + the
    // idempotency record commit atomically.
    execute: () => {
      // An identical retry never reaches here (the wrapper replayed the
      // stored run first), so any active run is a genuine conflict.
      const active = activeRunRow(db);
      if (active !== null) {
        throw Errors.conflict('Another run is already active; one run executes at a time', {
          reason: 'run_already_active',
          runId: active.id,
        });
      }
      const conversation = getConversationRow(db, input.projectId, input.conversationId);
      if (conversation === null) {
        throw Errors.notFound(`Conversation ${input.conversationId} does not exist in this project`);
      }
      const approval = getApprovalRow(db, input.projectId, input.approvalId);
      if (approval === null) {
        throw Errors.notFound(`Approval ${input.approvalId} does not exist in this project`);
      }
      if (approval.status !== 'active') {
        throw Errors.conflict('The plan approval is no longer active; a material change requires re-approval', {
          reason: 'approval_invalidated',
          approvalId: approval.id,
        });
      }
      const latest = latestPlanRow(db, input.projectId);
      if (latest === null || latest.id !== approval.planId) {
        throw Errors.conflict('The approval is bound to a superseded plan version', {
          reason: 'approval_superseded',
          currentPlanId: latest?.id ?? null,
        });
      }
      const jobId = `job_${randomUUID()}`;
      const now = Date.now();
      const run = insertRun(db, {
        projectId: input.projectId,
        conversationId: input.conversationId,
        approvalId: approval.id,
        planId: approval.planId,
        planVersion: approval.version,
        jobId,
      });
      db.prepare(
        "INSERT INTO jobs (id, type, payload, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
      ).run(jobId, RUN_JOB_TYPE, JSON.stringify({ runId: run.runId }), now, now);
      appendProjectEvent(db, {
        projectId: input.projectId,
        runId: run.runId,
        type: 'run.state.changed',
        data: { runId: run.runId, from: null, to: 'queued', reason: 'approved_plan' },
        requestId: req.id,
      });
      return getRunRowForProject(db, input.projectId, run.runId)!;
    },
  }).result;
}

/**
 * Cancel a run. Terminal runs answer truthfully with no further effect.
 * For a live run the durable cancel flag commits first; the real command
 * descendants are then TERM/KILLed through the workspace primitive, and the
 * worker confirms the cancelled terminal state.
 */
export async function cancelRun(
  db: DatabaseSync,
  req: FastifyRequest,
  input: { projectId: string; runId: string },
  terminateRunCommands: (projectId: string, runId: string) => Promise<void>,
): Promise<RunRow> {
  const existing = getRunRowForProject(db, input.projectId, input.runId);
  if (existing === null) {
    throw Errors.notFound(`Run ${input.runId} does not exist in this project`);
  }
  if (['succeeded', 'failed', 'cancelled'].includes(existing.state)) {
    return existing; // terminal: nothing to cancel, no event, no effect
  }
  const result = withIdempotentMutation(db, {
    scope: `cancelRun:${input.projectId}:${req.principalId ?? 'unauthenticated'}`,
    key: idempotencyKeyFrom(req),
    requestHash: requestHash({ params: { runId: input.runId } }),
    execute: () => {
      requestCancel(db, input.runId);
      const queued = cancelQueuedRun(db, input.runId);
      if (queued !== null) {
        // Never claimed: no worker owns it. Fail the job so it never runs.
        db.prepare("UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(
          'run cancelled before start',
          Date.now(),
          queued.jobId,
        );
        appendProjectEvent(db, {
          projectId: input.projectId,
          runId: queued.id,
          type: 'run.state.changed',
          data: { runId: queued.id, from: 'queued', to: 'cancelled', reason: 'cancel_requested_before_start' },
          requestId: req.id,
        });
      }
      return getRunRowForProject(db, input.projectId, input.runId)!;
    },
  }).result;
  // After the durable flag: terminate real descendants now (idempotent).
  await terminateRunCommands(input.projectId, input.runId);
  return getRunRowForProject(db, input.projectId, input.runId) ?? result;
}

export function listRunsForProject(db: DatabaseSync, projectId: string): RunRow[] {
  return listRunRows(db, projectId);
}
