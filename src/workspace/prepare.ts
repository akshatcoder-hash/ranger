import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { withTransaction, mapRow } from '../db/db.js';
import { Errors, isAppError, redact } from '../errors.js';
import { appendProjectEvent } from '../events/store.js';
import type { RangerConfig } from '../config.js';
import { SecretResolver } from '../secrets.js';
import { getRepositoryRecord } from '../repositories/store.js';
import { materializeInitialSource, savedSourceMatchesCommit } from '../runs/initial-source.js';
import { activeRunRow } from '../runs/store.js';
import { seedSavedSource } from '../runs/executor.js';
import type { IndexReadiness } from '../retrieval/service.js';
import type { PersistedIndexState } from '../retrieval/index-state.js';
import type { JobHandler } from '../worker/loop.js';
import { WorkspaceService } from './service.js';
import { getWorkspace, listAllSourceFiles } from './store.js';

/**
 * Read-only project preparation for a voice call: one isolated VM seeded
 * with the connected project's committed source, and a real Trace index of
 * exactly that seeded source, built by the durable worker (never inline in
 * an API request or voice session).
 *
 * Contract:
 * - the voice tool enqueues ONE durable job (no arguments; the server binds
 *   project, conversation and session) and returns its id promptly;
 * - the worker validates the connected repository/commit and retrieval
 *   availability BEFORE the VM create, then performs exactly one
 *   create -> seed -> index sequence through the existing services;
 * - any failure stops, destroys the VM this job created (an uncertain create
 *   is never retried or destroyed blindly) and records a failed event;
 * - progress is the durable `workspace.preparation.updated` event history;
 *   'ready' is only recorded after the index was actually built, and callers
 *   re-prove readiness against the durable index record, never the event;
 * - a ready VM/index is reused only when it matches the connected project
 *   revision; anything else is an explicit refusal (no auto-recovery).
 *
 * Plan approval is not involved: nothing here edits code or runs project
 * commands. Approved coding runs keep their own exact-approval gating.
 */

export const PREPARE_JOB_TYPE = 'project_workspace_prep';
export const PREPARATION_EVENT_TYPE = 'workspace.preparation.updated';

export interface PreparePayload {
  projectId: string;
  conversationId: string;
  sessionId: string;
}

export interface PrepareReference {
  jobId: string;
  status: 'queued' | 'running' | 'ready';
}

export interface PreparationEventData {
  jobId: string;
  phase: 'queued' | 'preparing' | 'indexing' | 'ready' | 'failed';
  fileCount?: number;
  byteCount?: number;
  indexElapsedMs?: number;
  elapsedMs?: number;
  errorCode?: string;
  message?: string;
  repositoryCommit?: string;
}

function appendPreparation(
  db: DatabaseSync,
  input: { projectId: string; sessionId: string | null; requestId: string; data: PreparationEventData },
): void {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.data)) {
    if (value !== undefined) data[key] = value;
  }
  appendProjectEvent(db, {
    projectId: input.projectId,
    sessionId: input.sessionId,
    type: PREPARATION_EVENT_TYPE,
    data,
    requestId: input.requestId,
  });
}

/** The latest durable preparation event of a project (the status history head). */
export function latestPreparation(db: DatabaseSync, projectId: string): PreparationEventData | null {
  const row = mapRow<{ data: string }>(
    db
      .prepare('SELECT data FROM project_events WHERE project_id = ? AND type = ? ORDER BY sequence DESC LIMIT 1')
      .get(projectId, PREPARATION_EVENT_TYPE),
  );
  if (row === undefined) return null;
  try {
    return JSON.parse(row.data) as PreparationEventData;
  } catch {
    return null;
  }
}

function activePrepJob(db: DatabaseSync, projectId: string): { id: string; status: string } | null {
  const row = mapRow<{ id: string; status: string }>(
    db
      .prepare(
        `SELECT id, status FROM jobs
         WHERE type = ? AND json_extract(payload, '$.projectId') = ? AND status IN ('pending', 'claimed')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(PREPARE_JOB_TYPE, projectId),
  );
  return row ?? null;
}

/**
 * Enqueue ONE preparation job, or answer honestly from current state. Runs
 * inside the caller's (idempotent) transaction so the job row and its
 * `queued` event commit together. Never runs any VM/index work.
 */
export function requestProjectWorkspacePrep(
  db: DatabaseSync,
  input: {
    projectId: string;
    conversationId: string;
    sessionId: string;
    requestId: string;
    readiness: (projectId: string) => IndexReadiness | null;
  },
): PrepareReference {
  const active = activePrepJob(db, input.projectId);
  if (active !== null) {
    return { jobId: active.id, status: active.status === 'claimed' ? 'running' : 'queued' };
  }
  const running = activeRunRow(db);
  if (running !== null) {
    throw Errors.conflict('An engineering run is active; the workspace cannot be prepared until it finishes', {
      reason: 'run_active',
    });
  }
  const workspace = getWorkspace(db, input.projectId);
  if (workspace !== null && workspace.observedState !== 'destroyed') {
    if (workspace.uncertain || workspace.observedState === 'uncertain') {
      throw Errors.conflict('An earlier Instabox create is uncertain; refusing to prepare another workspace', {
        reason: 'uncertain_create',
      });
    }
    if (workspace.observedState !== 'running') {
      throw Errors.conflict('A workspace create is already recorded for this project', {
        reason: 'workspace_create_in_progress',
        observedState: workspace.observedState,
      });
    }
    const repository = getRepositoryRecord(db, input.projectId);
    const readiness = input.readiness(input.projectId);
    const provenance = readiness?.ready === true ? readiness.state.provenance : null;
    const matches =
      provenance !== null &&
      repository !== null &&
      repository.commit !== '' &&
      provenance['repositoryCommit'] === repository.commit &&
      provenance['machineId'] === workspace.machineId &&
      workspace.sourceRevision === repository.commit &&
      workspace.deadlineAt !== null &&
      workspace.deadlineAt > Date.now();
    if (matches && provenance['jobId'] !== undefined) {
      return { jobId: provenance['jobId'], status: 'ready' };
    }
    // A running VM that is not this project's ready, current preparation is
    // never destroyed or silently reused here.
    throw Errors.conflict(
      'A workspace is already running for this project but does not match the connected repository revision with a ready index; destroy it before preparing again',
      { reason: 'workspace_stale', readiness: readiness === null ? 'unavailable' : readiness.ready ? 'ready' : readiness.reason },
    );
  }
  const jobId = `job_${randomUUID()}`;
  const now = Date.now();
  const payload: PreparePayload = {
    projectId: input.projectId,
    conversationId: input.conversationId,
    sessionId: input.sessionId,
  };
  db.prepare(
    "INSERT INTO jobs (id, type, payload, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
  ).run(jobId, PREPARE_JOB_TYPE, JSON.stringify(payload), now, now);
  appendPreparation(db, {
    projectId: input.projectId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    data: { jobId, phase: 'queued' },
  });
  return { jobId, status: 'queued' };
}

// -- worker -------------------------------------------------------------------

export interface PrepareRetrieval {
  assertAvailable(): Promise<void>;
  reindexDetailed(projectId: string, options?: { provenance?: Record<string, string> }): Promise<PersistedIndexState>;
}

export interface PrepareDeps {
  db: DatabaseSync;
  config: RangerConfig;
  retrieval: PrepareRetrieval;
}

function failureCode(cause: unknown, fallback: string): string {
  if (isAppError(cause)) {
    const reason = cause.details?.['reason'];
    if (typeof reason === 'string' && /^[a-z0-9_]{1,64}$/.test(reason)) return reason;
    return cause.code;
  }
  return fallback;
}

function failureMessage(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return redact(raw).slice(0, 300);
}

export function projectWorkspacePrepHandler(deps: PrepareDeps): JobHandler {
  return async (job) => {
    const payload = job.payload as Partial<PreparePayload>;
    if (typeof payload.projectId !== 'string' || typeof payload.sessionId !== 'string') return;
    await executePrepare(deps, job, payload as PreparePayload);
  };
}

async function executePrepare(
  deps: PrepareDeps,
  job: { id: string; claimEpoch: number },
  payload: PreparePayload,
): Promise<void> {
  const { db, config, retrieval } = deps;
  const { projectId, sessionId } = payload;
  const startedAt = Date.now();
  const requestId = `prep_${job.id}`;
  const leaseMs = config.limits.jobLeaseMs;

  // The job lease is renewed while the prep runs (index builds are long).
  // Losing it (the reconciliation controller failed the job) fences every
  // further event and state change; the VM this job created is still
  // destroyed below.
  let leaseLost = false;
  const renewer = setInterval(() => {
    try {
      const renewed = db
        .prepare("UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND claim_epoch = ? AND status = 'claimed'")
        .run(Date.now() + leaseMs, Date.now(), job.id, job.claimEpoch);
      if (renewed.changes === 0) leaseLost = true;
    } catch {
      // A transient lock failure retries on the next tick.
    }
  }, Math.max(250, Math.floor(leaseMs / 4)));

  const jobOwned = (): boolean => {
    const row = mapRow<{ status: string; claim_epoch: number }>(
      db.prepare('SELECT status, claim_epoch FROM jobs WHERE id = ?').get(job.id),
    );
    return row !== undefined && row.status === 'claimed' && row.claim_epoch === job.claimEpoch;
  };

  const emit = (data: PreparationEventData): boolean => {
    if (leaseLost) return false;
    return withTransaction(db, () => {
      if (!jobOwned()) {
        leaseLost = true;
        return false;
      }
      appendPreparation(db, { projectId, sessionId, requestId, data });
      return true;
    });
  };

  let repositoryCommit: string | undefined;
  let fileCount: number | undefined;
  let byteCount: number | undefined;
  /** True only after THIS job's create succeeded: the VM it owns and must clean up. */
  let created = false;

  const workspace = new WorkspaceService({ db, config, secrets: new SecretResolver(config.secretFile) });

  const finishFailed = async (code: string, cause: unknown): Promise<void> => {
    let message = typeof cause === 'string' ? cause : failureMessage(cause);
    if (created) {
      try {
        await workspace.destroy(projectId);
      } catch {
        message = `${message} Workspace cleanup failed; the reconciliation sweep will reclaim it.`.slice(0, 400);
      }
    }
    const recorded = emit({
      jobId: job.id,
      phase: 'failed',
      errorCode: code,
      message: message.slice(0, 400),
      elapsedMs: Date.now() - startedAt,
      ...(repositoryCommit !== undefined ? { repositoryCommit } : {}),
      ...(fileCount !== undefined ? { fileCount } : {}),
      ...(byteCount !== undefined ? { byteCount } : {}),
    });
    if (recorded) {
      db.prepare(
        "UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND claim_epoch = ? AND status = 'claimed'",
      ).run(`${code}: ${message}`.slice(0, 500), Date.now(), job.id, job.claimEpoch);
    }
  };

  try {
    if (!emit({ jobId: job.id, phase: 'preparing' })) return;

    // 1. Validate the connected repository and committed source BEFORE any VM.
    const repository = getRepositoryRecord(db, projectId);
    if (repository === null) {
      await finishFailed('repository_not_connected', 'No repository is connected to this project');
      return;
    }
    repositoryCommit = repository.commit === '' ? undefined : repository.commit;
    let sourceMatches: boolean;
    try {
      const initial = await materializeInitialSource(db, projectId, repository, config.approvedSnapshotRoots);
      // Freshly materialized source was byte-verified against the commit;
      // pre-existing saved source must still equal the connected revision.
      sourceMatches = initial.materialized || (await savedSourceMatchesCommit(db, projectId, repository, config.approvedSnapshotRoots));
    } catch (cause) {
      await finishFailed('initial_source_unmaterializable', cause);
      return;
    }
    if (!sourceMatches) {
      await finishFailed(
        'source_stale',
        'Saved project source does not match the connected repository commit; refusing to substitute a different revision',
      );
      return;
    }
    const sources = listAllSourceFiles(db, projectId);
    fileCount = sources.length;
    byteCount = sources.reduce((total, file) => total + file.content.byteLength, 0);
    if (fileCount === 0) {
      await finishFailed('source_empty', 'The connected repository commit holds no files');
      return;
    }

    // 2. Real retrieval must be usable before any paid VM exists.
    try {
      await retrieval.assertAvailable();
    } catch (cause) {
      await finishFailed('retrieval_unavailable', cause);
      return;
    }

    // 3. No shared-workspace conflicts: never touch a run's or another
    // flow's VM, never repeat an uncertain create.
    if (activeRunRow(db) !== null) {
      await finishFailed('run_active', 'An engineering run is active; the workspace was not prepared');
      return;
    }
    const existing = getWorkspace(db, projectId);
    if (existing !== null && existing.observedState !== 'destroyed') {
      await finishFailed(
        existing.uncertain || existing.observedState === 'uncertain' ? 'uncertain_create' : 'workspace_in_use',
        'A workspace already exists for this project and is not owned by this preparation',
      );
      return;
    }
    if (leaseLost || !jobOwned()) return;

    // 4. Exactly one create, then seed from the saved source, then index.
    try {
      await workspace.create(projectId, repository.commit, requestId);
      created = true;
    } catch (cause) {
      await finishFailed(failureCode(cause, 'workspace_create_failed'), cause);
      return;
    }
    try {
      await seedSavedSource(db, projectId, workspace);
    } catch (cause) {
      await finishFailed(failureCode(cause, 'workspace_seed_failed'), cause);
      return;
    }
    if (leaseLost || !jobOwned()) {
      await finishFailed('worker_interrupted', 'The preparation job lease was lost');
      return;
    }

    if (!emit({ jobId: job.id, phase: 'indexing', fileCount, byteCount, ...(repositoryCommit !== undefined ? { repositoryCommit } : {}) })) {
      await finishFailed('worker_interrupted', 'The preparation job lease was lost');
      return;
    }
    const machineId = getWorkspace(db, projectId)?.machineId ?? '';
    let indexed: PersistedIndexState;
    try {
      indexed = await retrieval.reindexDetailed(projectId, {
        provenance: { repositoryCommit: repository.commit, jobId: job.id, machineId },
      });
    } catch (cause) {
      await finishFailed(failureCode(cause, 'index_failed'), cause);
      return;
    }
    const recorded = emit({
      jobId: job.id,
      phase: 'ready',
      fileCount: indexed.fileCount,
      byteCount: indexed.byteCount,
      indexElapsedMs: indexed.indexElapsedMs,
      elapsedMs: Date.now() - startedAt,
      repositoryCommit: repository.commit,
    });
    if (!recorded) await finishFailed('worker_interrupted', 'The preparation job lease was lost');
  } catch (cause) {
    await finishFailed(failureCode(cause, 'prepare_error'), cause);
  } finally {
    clearInterval(renewer);
  }
}

/**
 * Reconciliation for preparation jobs whose worker died (lease expired):
 * the job fails with a recorded event so the status history never stays at
 * 'preparing'. The orphan sweep then destroys the recorded VM.
 */
export function failInterruptedPreparations(db: DatabaseSync, now: number): string[] {
  const rows = db
    .prepare(
      `SELECT id, payload FROM jobs
       WHERE type = ? AND status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
    )
    .all(PREPARE_JOB_TYPE, now) as Array<{ id: string; payload: string }>;
  const failed: string[] = [];
  for (const row of rows) {
    let payload: Partial<PreparePayload> = {};
    try {
      payload = JSON.parse(row.payload) as Partial<PreparePayload>;
    } catch {
      // A malformed payload is still failed below, just without an event.
    }
    withTransaction(db, () => {
      const updated = db
        .prepare("UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND status = 'claimed'")
        .run('worker_interrupted: control worker died or its lease expired', Date.now(), row.id);
      if (updated.changes === 0 || typeof payload.projectId !== 'string') return;
      appendPreparation(db, {
        projectId: payload.projectId,
        sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : null,
        requestId: `prep_${row.id}`,
        data: {
          jobId: row.id,
          phase: 'failed',
          errorCode: 'worker_interrupted',
          message: 'The control worker died or its lease expired; preparation is never resumed.',
        },
      });
      failed.push(row.id);
    });
  }
  return failed;
}
