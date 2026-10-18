import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

/**
 * Durable worker loop.
 *
 * Claims jobs from the persisted queue with a lease (fencing epoch increments
 * per claim; only the current owner may complete the job). Foundation ships
 * the loop and claim machinery with an empty handler registry — later
 * milestones register real job handlers. The loop never runs long engineering
 * operations inside an API request.
 */

export interface ClaimedJob {
  id: string;
  type: string;
  payload: unknown;
  claimEpoch: number;
}

export type JobHandler = (job: {
  id: string;
  type: string;
  payload: unknown;
  claimEpoch: number;
}) => Promise<void>;

export interface WorkerLoopOptions {
  pollMs: number;
  leaseMs: number;
  workerId?: string;
  logger: { info: (obj: unknown, msg: string) => void; error: (obj: unknown, msg: string) => void };
}

export function claimNextJob(
  db: DatabaseSync,
  handlerTypes: readonly string[],
  workerId: string,
  leaseMs: number,
): ClaimedJob | null {
  if (handlerTypes.length === 0) return null;
  const now = Date.now();
  const placeholders = handlerTypes.map(() => '?').join(', ');
  db.exec('BEGIN IMMEDIATE');
  try {
    const candidate = db
      .prepare(
        `SELECT id, type, payload, claim_epoch, attempts, max_attempts FROM jobs
         WHERE status = 'pending'
           AND type IN (${placeholders})
           AND (lease_expires_at IS NULL OR lease_expires_at < ?)
         ORDER BY created_at
         LIMIT 1`,
      )
      .get(...handlerTypes, now) as
      | { id: string; type: string; payload: string; claim_epoch: number; attempts: number; max_attempts: number }
      | undefined;
    if (candidate === undefined) {
      db.exec('COMMIT');
      return null;
    }
    const claimEpoch = candidate.claim_epoch + 1;
    const result = db
      .prepare(
        `UPDATE jobs SET status = 'claimed', claimed_by = ?, claim_epoch = ?, claimed_at = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending' AND claim_epoch = ?`,
      )
      .run(workerId, claimEpoch, now, now + leaseMs, now, candidate.id, candidate.claim_epoch);
    db.exec('COMMIT');
    if (result.changes === 0) return null;
    return {
      id: candidate.id,
      type: candidate.type,
      payload: JSON.parse(candidate.payload) as unknown,
      claimEpoch,
    };
  } catch (cause) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // no-op
    }
    throw cause;
  }
}

export class WorkerLoop {
  private timer: NodeJS.Timeout | null = null;
  private readonly workerId: string;
  private running = false;
  private processing = false;
  private loggedIdle = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly handlers: Map<string, JobHandler>,
    private readonly opts: WorkerLoopOptions,
  ) {
    this.workerId = opts.workerId ?? `worker-${randomUUID()}`;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    // Wait for any in-flight job to finish so shutdown never orphans work.
    for (let i = 0; i < 100 && this.processing; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), this.opts.pollMs);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.processing) return;
    this.processing = true;
    try {
      const types = [...this.handlers.keys()];
      if (types.length === 0) {
        if (!this.loggedIdle) {
          this.loggedIdle = true;
          this.opts.logger.info(
            { workerId: this.workerId },
            'worker started; no job handlers registered yet, idling until a milestone registers handlers',
          );
        }
        return;
      }
      const job = claimNextJob(this.db, types, this.workerId, this.opts.leaseMs);
      if (job === null) return;
      const handler = this.handlers.get(job.type);
      if (handler === undefined) {
        // Claim raced with a registry change; leave the job pending.
        this.releaseJob(job);
        return;
      }
      try {
        await handler(job);
        this.completeJob(job, 'succeeded');
      } catch (cause) {
        this.completeJob(job, 'failed', String(cause));
      }
    } catch (cause) {
      this.opts.logger.error({ err: String(cause) }, 'worker tick failed');
    } finally {
      this.processing = false;
      this.schedule();
    }
  }

  private releaseJob(job: ClaimedJob): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = 'pending', claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND claim_epoch = ?`,
      )
      .run(Date.now(), job.id, job.claimEpoch);
  }

  private completeJob(job: ClaimedJob, status: 'succeeded' | 'failed', error?: string): void {
    this.db
      .prepare(
        `UPDATE jobs
         SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ?
         WHERE id = ? AND claim_epoch = ? AND status = 'claimed'`,
      )
      .run(status, error ?? null, Date.now(), job.id, job.claimEpoch);
  }
}
