import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { AppError, Errors } from '../errors.js';

/**
 * Shared live-test admission ledger.
 *
 * The mission-wide file (provider-budget.json) is the single source of truth
 * for live provider spending across ALL workers and validators. Rules:
 * - xAI: $5 total; a paid operation is admitted only while recorded spend
 *   plus a conservative estimate stays at or below the $4 soft admission stop.
 *   The remaining $1 is reserve for in-flight/accounting uncertainty.
 * - Instabox: at most six additional VM creations, one at a time, each with a
 *   server-side kill timeout of at most 600 s and early cleanup. Outstanding
 *   (pending) reservations count against both the concurrency and total caps
 *   until they are confirmed or released, and the requested kill timeout is
 *   validated at reserve time, before any provider create can be attempted.
 * - The ledger is consumed, never reset: writes preserve unknown fields and
 *   append to the operation history. Refusals write nothing.
 * - xAI reservations settle exactly once: at most one observe or one release
 *   per reservation id, under the ledger lock. A repeated or unknown
 *   settlement never frees another reservation's headroom or double counts
 *   usage, so admission can never be inflated past the caps.
 * - Ledger-configured limits may only lower the approved ceilings; missing,
 *   negative, non-finite or inflated limits fail closed (refuse admission).
 * - When accounting is uncertain, refuse: stop paid work and report.
 *
 * All mutations happen under an exclusive lock file next to the ledger so
 * concurrent processes cannot double-spend.
 */

export const XAI_TOTAL_LIMIT_USD = 5;
export const XAI_SOFT_ADMISSION_USD = 4;
export const INSTABOX_MAX_ADDITIONAL_CREATIONS = 6;
export const INSTABOX_MAX_CONCURRENT = 1;
export const INSTABOX_MAX_LIFETIME_SECONDS = 600;

export interface LedgerOperation {
  id: string;
  ts: number;
  provider: 'xai' | 'instabox';
  kind: 'reserve' | 'observe' | 'release' | 'creation' | 'creation-release' | 'machine-release';
  feature: string;
  estimateUsd?: number;
  observedUsd?: number;
  model?: string;
  machineId?: string;
  killTimeoutMs?: number;
  note?: string;
}

export interface LedgerMachine {
  machineId: string;
  createdAt: number;
  releasedAt?: number | null;
  killTimeoutMs?: number;
  purpose?: string;
}

export interface InstaboxPendingReservation {
  reservationId: string;
  ts: number;
  feature: string;
  purpose?: string;
  /** Validated at reserve time; the sandbox must be created with this value. */
  killTimeoutMs: number;
}

export interface BudgetLedgerData {
  version: number;
  xai: {
    limitUsd: number;
    softAdmissionUsd: number;
    observedUsd: number;
    reservedUsd: number;
    operations: LedgerOperation[];
  };
  instabox: {
    maxAdditionalCreations: number;
    maxConcurrent: number;
    maxLifetimeSeconds: number;
    additionalCreations: number;
    machines: LedgerMachine[];
    /** Optional for backward compatibility with ledgers written before it existed. */
    pendingReservations?: InstaboxPendingReservation[];
  };
  [key: string]: unknown;
}

export class BudgetLedgerError extends AppError {
  constructor(message: string, details: Record<string, unknown>) {
    super('budget_exceeded', message, { details });
    this.name = 'BudgetLedgerError';
  }
}

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;

function ledgerPaths(ledgerFile: string): { lock: string; tmp: string } {
  return { lock: `${ledgerFile}.lock`, tmp: `${ledgerFile}.tmp.${process.pid}.${Date.now()}` };
}

/**
 * Hold an exclusive advisory lock on the ledger file. Stale locks (older than
 * LOCK_STALE_MS, i.e. a crashed writer) are broken after their age confirms
 * no live writer can still hold them.
 */
export function withLedgerLock<T>(ledgerFile: string, fn: () => T): T {
  const { lock } = ledgerPaths(ledgerFile);
  mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(lock, 'wx');
      break;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw cause;
      try {
        const age = Date.now() - (existsSync(lock) ? (statTimestamp(lock) ?? 0) : 0);
        if (age > LOCK_STALE_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        // Lock vanished; retry.
      }
      if (Date.now() > deadline) {
        throw Errors.internal('Budget ledger lock timed out', { ledgerFile: 'locked' });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {
      // Another writer may already have broken a stale lock; nothing to do.
    }
  }
}

function statTimestamp(file: string): number | null {
  try {
    const stats = statSync(file);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

/** Read the ledger; a missing file is an explicit error, never auto-created. */
export function readLedger(ledgerFile: string): BudgetLedgerData {
  if (!existsSync(ledgerFile)) {
    throw new BudgetLedgerError('Live budget ledger file is missing', {
      ledger: 'missing',
      action: 'no live operations are permitted until the shared ledger exists',
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(ledgerFile, 'utf8'));
  } catch (cause) {
    throw new BudgetLedgerError('Live budget ledger is not readable JSON', {
      ledger: 'corrupt',
      action: 'stop paid operations and report',
      cause: String(cause),
    });
  }
  return parsed as BudgetLedgerData;
}

/** Atomic write preserving unknown top-level fields. Never resets counters. */
export function writeLedger(ledgerFile: string, data: BudgetLedgerData): void {
  const { tmp } = ledgerPaths(ledgerFile);
  mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + '\n');
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, ledgerFile);
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Ledger-configured limits may be LOWERED by the file's operator but never
 * raised above the approved mission ceilings. Missing, negative, non-finite
 * or inflated values fail closed: admission refuses rather than guessing.
 */
function requireXai(data: BudgetLedgerData): BudgetLedgerData['xai'] {
  if (data.xai === undefined) {
    throw new BudgetLedgerError('Ledger xai section is malformed', { ledger: 'malformed', section: 'xai' });
  }
  const xai = data.xai;
  const malformed =
    !isFinitePositive(xai.limitUsd) ||
    xai.limitUsd > XAI_TOTAL_LIMIT_USD ||
    !isFinitePositive(xai.softAdmissionUsd) ||
    xai.softAdmissionUsd > XAI_SOFT_ADMISSION_USD ||
    xai.softAdmissionUsd > xai.limitUsd ||
    typeof xai.observedUsd !== 'number' ||
    !Number.isFinite(xai.observedUsd) ||
    xai.observedUsd < 0 ||
    typeof xai.reservedUsd !== 'number' ||
    !Number.isFinite(xai.reservedUsd) ||
    xai.reservedUsd < 0 ||
    !Array.isArray(xai.operations);
  if (malformed) {
    throw new BudgetLedgerError(
      'Ledger xai section is malformed or exceeds approved limits; admission refuses rather than guesses',
      { ledger: 'malformed', section: 'xai' },
    );
  }
  return xai;
}

function requireInstabox(data: BudgetLedgerData): BudgetLedgerData['instabox'] {
  if (data.instabox === undefined) {
    throw new BudgetLedgerError('Ledger instabox section is malformed', { ledger: 'malformed', section: 'instabox' });
  }
  const instabox = data.instabox;
  const malformed =
    !isNonNegativeInteger(instabox.maxAdditionalCreations) ||
    instabox.maxAdditionalCreations > INSTABOX_MAX_ADDITIONAL_CREATIONS ||
    !isNonNegativeInteger(instabox.maxConcurrent) ||
    instabox.maxConcurrent > INSTABOX_MAX_CONCURRENT ||
    !isFinitePositive(instabox.maxLifetimeSeconds) ||
    instabox.maxLifetimeSeconds > INSTABOX_MAX_LIFETIME_SECONDS ||
    !isNonNegativeInteger(instabox.additionalCreations) ||
    !Array.isArray(instabox.machines) ||
    (instabox.pendingReservations !== undefined && !Array.isArray(instabox.pendingReservations));
  if (malformed) {
    throw new BudgetLedgerError(
      'Ledger instabox section is malformed or exceeds approved limits; admission refuses rather than guesses',
      { ledger: 'malformed', section: 'instabox' },
    );
  }
  return instabox;
}

function pendingReservations(instabox: BudgetLedgerData['instabox']): InstaboxPendingReservation[] {
  return instabox.pendingReservations ?? [];
}

export interface XaiAdmission {
  reservationId: string;
  reservedUsd: number;
}

/**
 * Reserve budget for one serialized paid xAI operation. Refuses (zero dials)
 * when observed + reserved + estimate would exceed the soft admission stop,
 * or when the estimate is not a positive finite number (uncertain accounting
 * must refuse rather than guess).
 */
export function reserveXaiSpend(
  ledgerFile: string,
  input: { feature: string; estimateUsd: number; model?: string },
): XaiAdmission {
  const { estimateUsd, feature } = input;
  if (typeof estimateUsd !== 'number' || !Number.isFinite(estimateUsd) || estimateUsd <= 0) {
    throw new BudgetLedgerError('xAI estimate must be a positive number; refuse rather than guess', {
      estimateUsd: null,
    });
  }
  return withLedgerLock(ledgerFile, () => {
    const data = readLedger(ledgerFile);
    const xai = requireXai(data);
    const projected = xai.observedUsd + xai.reservedUsd + estimateUsd;
    if (projected > xai.softAdmissionUsd + 1e-9) {
      throw new BudgetLedgerError(
        'xAI budget admission stop reached; paid request refused with zero provider dials',
        {
          softAdmissionUsd: xai.softAdmissionUsd,
          observedUsd: xai.observedUsd,
          reservedUsd: xai.reservedUsd,
          estimateUsd,
        },
      );
    }
    const reservationId = `xai-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    xai.reservedUsd = round4(xai.reservedUsd + estimateUsd);
    xai.operations.push({
      id: reservationId,
      ts: Date.now(),
      provider: 'xai',
      kind: 'reserve',
      feature,
      estimateUsd,
      model: input.model,
    });
    writeLedger(ledgerFile, data);
    return { reservationId, reservedUsd: estimateUsd };
  });
}

/**
 * The settle-once marker for an xAI reservation: at most one observe or one
 * release operation may exist per reservation id, so the shared reservedUsd
 * pool is freed at most once per reservation and usage is counted at most
 * once. Settlement already happened when either operation marker is present.
 */
function findXaiSettlement(operations: LedgerOperation[], reservationId: string): LedgerOperation | undefined {
  return operations.find((o) => o.provider === 'xai' && (o.id === `${reservationId}-observe` || o.id === `${reservationId}-release`));
}

/** Record observed provider usage for a reservation; settles it exactly once. */
export function observeXaiSpend(
  ledgerFile: string,
  input: { reservationId: string; observedUsd: number; note?: string },
): BudgetLedgerData['xai'] {
  return withLedgerLock(ledgerFile, () => {
    const data = readLedger(ledgerFile);
    const xai = requireXai(data);
    const op = xai.operations.find((o) => o.id === input.reservationId && o.kind === 'reserve');
    if (op === undefined) {
      throw new BudgetLedgerError('Unknown xAI reservation', { reservationId: 'unknown' });
    }
    if (findXaiSettlement(xai.operations, input.reservationId) !== undefined) {
      // A reservation is settled exactly once; a repeated observe must never
      // double count usage or free another reservation's headroom.
      throw new BudgetLedgerError('xAI reservation was already settled; refusing double settlement', {
        reservationId: 'already_settled',
      });
    }
    if (typeof input.observedUsd !== 'number' || !Number.isFinite(input.observedUsd) || input.observedUsd < 0) {
      throw new BudgetLedgerError('Observed xAI usage must be a non-negative number', {
        observedUsd: null,
      });
    }
    xai.observedUsd = round4(xai.observedUsd + input.observedUsd);
    xai.reservedUsd = round4(Math.max(0, xai.reservedUsd - (op.estimateUsd ?? 0)));
    op.observedUsd = input.observedUsd;
    xai.operations.push({
      id: `${input.reservationId}-observe`,
      ts: Date.now(),
      provider: 'xai',
      kind: 'observe',
      feature: op.feature,
      observedUsd: input.observedUsd,
      model: op.model,
      note: input.note,
    });
    writeLedger(ledgerFile, data);
    return xai;
  });
}

/**
 * Release a reservation without any observed spend (operation not dialed).
 * Settles the reservation exactly once: releasing an unknown reservation is
 * an idempotent no-op, and releasing one that was already observed or
 * released never frees reservedUsd a second time.
 */
export function releaseXaiReservation(ledgerFile: string, reservationId: string): void {
  withLedgerLock(ledgerFile, () => {
    const data = readLedger(ledgerFile);
    const xai = requireXai(data);
    const op = xai.operations.find((o) => o.id === reservationId && o.kind === 'reserve');
    if (op === undefined) return;
    if (findXaiSettlement(xai.operations, reservationId) !== undefined) return;
    xai.reservedUsd = round4(Math.max(0, xai.reservedUsd - (op.estimateUsd ?? 0)));
    xai.operations.push({
      id: `${reservationId}-release`,
      ts: Date.now(),
      provider: 'xai',
      kind: 'release',
      feature: op.feature,
      estimateUsd: op.estimateUsd,
      note: 'released without spend',
    });
    writeLedger(ledgerFile, data);
  });
}

export interface InstaboxCreationReservation {
  reservationId: string;
  /** Validated requested kill timeout; create the sandbox with exactly this value. */
  killTimeoutMs: number;
}

/**
 * Reserve an Instabox VM creation slot against the mission allowance
 * (max additional creations, one concurrent machine). The requested kill
 * timeout is validated HERE, before any provider create can be attempted
 * against this reservation, and outstanding reservations count against both
 * caps until they are confirmed or released.
 */
export function reserveInstaboxCreation(
  ledgerFile: string,
  input: { feature: string; purpose?: string; killTimeoutMs: number },
): InstaboxCreationReservation {
  return withLedgerLock(ledgerFile, () => {
    const data = readLedger(ledgerFile);
    const instabox = requireInstabox(data);
    const { killTimeoutMs } = input;
    if (typeof killTimeoutMs !== 'number' || !Number.isInteger(killTimeoutMs) || killTimeoutMs <= 0) {
      throw new BudgetLedgerError('Requested kill timeout must be a positive whole number of milliseconds', {
        killTimeoutMs: null,
      });
    }
    if (killTimeoutMs > instabox.maxLifetimeSeconds * 1000) {
      throw new BudgetLedgerError('Requested kill timeout exceeds the approved maximum', {
        killTimeoutMs: null,
        maxLifetimeSeconds: instabox.maxLifetimeSeconds,
      });
    }
    const pending = pendingReservations(instabox);
    const activeMachines = instabox.machines.filter(
      (m) => m.releasedAt === undefined || m.releasedAt === null,
    );
    if (activeMachines.length + pending.length >= instabox.maxConcurrent) {
      throw new BudgetLedgerError('An Instabox machine is already active or reserved; one at a time', {
        maxConcurrent: instabox.maxConcurrent,
        activeMachines: activeMachines.length,
        pendingReservations: pending.length,
      });
    }
    if (instabox.additionalCreations + pending.length >= instabox.maxAdditionalCreations) {
      throw new BudgetLedgerError(
        'Instabox additional creation allowance is exhausted; stop and report',
        {
          maxAdditionalCreations: instabox.maxAdditionalCreations,
          additionalCreations: instabox.additionalCreations,
          pendingReservations: pending.length,
        },
      );
    }
    const reservationId = `ibx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    instabox.pendingReservations = [
      ...pending,
      {
        reservationId,
        ts: Date.now(),
        feature: input.feature,
        purpose: input.purpose,
        killTimeoutMs,
      },
    ];
    recordOperation(data, {
      id: reservationId,
      provider: 'instabox',
      kind: 'reserve',
      feature: input.feature,
      killTimeoutMs,
      note: input.purpose,
    });
    writeLedger(ledgerFile, data);
    return { reservationId, killTimeoutMs };
  });
}

/**
 * Confirm a creation actually happened: consumes allowance and records the
 * machine. Requires an outstanding reservation, so unknown, already-confirmed
 * or released reservations can never fabricate or double count a creation.
 * The recorded kill timeout is the one validated at reserve time, so a
 * timeout violation can no longer throw here after the machine exists: the
 * machine record, counter increment and pending removal commit atomically in
 * one ledger write. If the write fails transiently the reservation stays
 * pending and confirmation can be retried — the real machine is never hidden.
 */
export function confirmInstaboxCreation(
  ledgerFile: string,
  input: { reservationId: string; machineId: string; purpose?: string },
): BudgetLedgerData['instabox'] {
  return withLedgerLock(ledgerFile, () => {
    const data = readLedger(ledgerFile);
    const instabox = requireInstabox(data);
    const pending = pendingReservations(instabox);
    const index = pending.findIndex((r) => r.reservationId === input.reservationId);
    if (index === -1) {
      throw new BudgetLedgerError(
        'Instabox confirmation requires an outstanding reservation; unknown or already-settled reservations cannot record a creation',
        { reservationId: 'unknown' },
      );
    }
    const reservation = pending[index];
    if (reservation === undefined) {
      throw new BudgetLedgerError('Instabox confirmation requires an outstanding reservation', {
        reservationId: 'unknown',
      });
    }
    if (typeof input.machineId !== 'string' || input.machineId.length === 0) {
      throw new BudgetLedgerError('Confirmed machine id must be a non-empty string', { machineId: 'invalid' });
    }
    pending.splice(index, 1);
    instabox.pendingReservations = pending;
    instabox.additionalCreations += 1;
    instabox.machines.push({
      machineId: input.machineId,
      createdAt: Date.now(),
      killTimeoutMs: reservation.killTimeoutMs,
      purpose: input.purpose ?? reservation.purpose,
    });
    recordOperation(data, {
      id: input.reservationId,
      provider: 'instabox',
      kind: 'creation',
      feature: reservation.feature,
      machineId: input.machineId,
      killTimeoutMs: reservation.killTimeoutMs,
      note: input.purpose,
    });
    writeLedger(ledgerFile, data);
    return instabox;
  });
}

/**
 * Release a creation reservation that did NOT result in a machine, freeing
 * its concurrency and allowance slot. Unknown or already-settled
 * reservations are a no-op (nothing was reserved, so nothing is written).
 */
export function releaseInstaboxReservation(ledgerFile: string, reservationId: string): void {
  withLedgerLock(ledgerFile, () => {
    const data = readLedger(ledgerFile);
    const instabox = requireInstabox(data);
    const pending = pendingReservations(instabox);
    const index = pending.findIndex((r) => r.reservationId === reservationId);
    if (index === -1) return;
    pending.splice(index, 1);
    instabox.pendingReservations = pending;
    recordOperation(data, {
      id: reservationId,
      provider: 'instabox',
      kind: 'creation-release',
      feature: 'instabox',
      note: 'released without creation',
    });
    writeLedger(ledgerFile, data);
  });
}

/** Mark a machine released/cleaned up (frees the concurrency slot). */
export function recordInstaboxRelease(ledgerFile: string, machineId: string): void {
  withLedgerLock(ledgerFile, () => {
    const data = readLedger(ledgerFile);
    const instabox = requireInstabox(data);
    const machine = instabox.machines.find((m) => m.machineId === machineId);
    if (machine !== undefined && (machine.releasedAt === undefined || machine.releasedAt === null)) {
      machine.releasedAt = Date.now();
    }
    recordOperation(data, {
      id: `ibx-release-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      provider: 'instabox',
      kind: 'machine-release',
      feature: 'instabox',
      machineId,
    });
    writeLedger(ledgerFile, data);
  });
}

/**
 * Operations are appended to the xai operations list only for xAI; Instabox
 * records live in the instabox section's own history to keep both auditable.
 */
function recordOperation(
  data: BudgetLedgerData,
  op: Omit<LedgerOperation, 'ts'> & { ts?: number },
): void {
  const entry: LedgerOperation = { ts: Date.now(), ...op } as LedgerOperation;
  if (op.provider === 'xai') {
    data.xai.operations.push(entry);
  } else {
    const instaboxHistory = (data.instabox as { operations?: LedgerOperation[] });
    instaboxHistory.operations = instaboxHistory.operations ?? [];
    instaboxHistory.operations.push(entry);
  }
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
