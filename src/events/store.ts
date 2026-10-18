import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Ajv, type ValidateFunction } from 'ajv';
import { mapRow, mapRows } from '../db/db.js';
import { Errors } from '../errors.js';
import { EVENT_SCHEMA_VERSION, EVENT_TYPES } from '../contracts/events.js';
import type { RangerProjectEvent } from '../contracts/types.js';
import { iso } from '../http/serialize.js';

/**
 * Central transactional project event history.
 *
 * `appendProjectEvent` is the ONLY writer of project events. It allocates the
 * per-project sequence and inserts the event inside the CALLER's transaction,
 * so the state mutation and its event always commit (or roll back) atomically
 * — a rolled back transaction consumes no sequence, keeping committed
 * sequences dense. Appends outside an open transaction are refused.
 *
 * Every `data` payload is validated against the declared event type schema at
 * append time; undeclared types are refused. Replay reads are pure SELECTs —
 * replaying events never invokes tools or changes state.
 */

export interface AppendEventInput {
  projectId: string;
  type: string;
  data: Record<string, unknown>;
  /** Run/session reference when the event belongs to one; null otherwise. */
  runId?: string | null;
  sessionId?: string | null;
  /** Request id of the mutating request that produced the event. */
  requestId: string;
}

export interface PersistedEvent {
  eventId: string;
  projectId: string;
  runId: string | null;
  sessionId: string | null;
  timestampMs: number;
  sequence: number;
  requestId: string;
  type: string;
  data: Record<string, unknown>;
}

interface EventSqlRow {
  event_id: string;
  project_id: string;
  run_id: string | null;
  session_id: string | null;
  timestamp_ms: number;
  sequence: number;
  request_id: string;
  type: string;
  data: string;
}

// -- append-time schema validation ------------------------------------------

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
const dataValidators = new Map<string, ValidateFunction | undefined>();

function dataValidatorFor(type: string): ValidateFunction | undefined {
  let validate = dataValidators.get(type);
  if (validate === undefined) {
    const def = EVENT_TYPES.find((candidate) => candidate.name === type);
    if (def === undefined) return undefined;
    validate = ajv.compile(def.dataSchema);
    dataValidators.set(type, validate);
  }
  return validate;
}

/** Append one event inside the caller's open transaction. */
export function appendProjectEvent(db: DatabaseSync, input: AppendEventInput): PersistedEvent {
  if (db.isTransaction !== true) {
    throw Errors.internal('appendProjectEvent must run inside the caller transaction so mutation and event commit atomically');
  }
  const validate = dataValidatorFor(input.type);
  if (validate === undefined) {
    throw Errors.internal(`Event type ${input.type} is not declared by the v1 contract`, {
      reason: 'undeclared_event_type',
      type: input.type,
    });
  }
  if (!validate(input.data)) {
    throw Errors.internal(`Event data for ${input.type} does not satisfy the declared schema`, {
      reason: 'invalid_event_data',
      type: input.type,
      // Ajv errors are derived from our own declared schemas: safe details.
      errors: validate.errors ?? [],
    });
  }

  const sequence = allocateEventSequence(db, input.projectId);
  const eventId = `evt_${randomUUID()}`;
  const timestampMs = Date.now();
  db.prepare(
    `INSERT INTO project_events (project_id, sequence, event_id, type, run_id, session_id, timestamp_ms, request_id, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.projectId,
    sequence,
    eventId,
    input.type,
    input.runId ?? null,
    input.sessionId ?? null,
    timestampMs,
    input.requestId,
    JSON.stringify(input.data),
  );
  return {
    eventId,
    projectId: input.projectId,
    runId: input.runId ?? null,
    sessionId: input.sessionId ?? null,
    timestampMs,
    sequence,
    requestId: input.requestId,
    type: input.type,
    data: input.data,
  };
}

/** Allocate the next per-project sequence inside the open transaction. */
function allocateEventSequence(db: DatabaseSync, projectId: string): number {
  db.prepare(
    `INSERT INTO project_event_sequences (project_id, last_sequence) VALUES (?, 1)
     ON CONFLICT(project_id) DO UPDATE SET last_sequence = last_sequence + 1`,
  ).run(projectId);
  const row = mapRow<{ last_sequence: number }>(
    db.prepare('SELECT last_sequence FROM project_event_sequences WHERE project_id = ?').get(projectId),
  );
  if (row === undefined) throw Errors.internal('Event sequence allocator row disappeared during write');
  return row.last_sequence;
}

/** Current head sequence for a project (0 when the project has no events). */
export function projectEventHead(db: DatabaseSync, projectId: string): number {
  const row = mapRow<{ last_sequence: number }>(
    db.prepare('SELECT last_sequence FROM project_event_sequences WHERE project_id = ?').get(projectId),
  );
  return row?.last_sequence ?? 0;
}

export interface EventPage {
  events: PersistedEvent[];
  hasMore: boolean;
}

/** Read events strictly after `afterSequence` in sequence order (pure read). */
export function listProjectEvents(
  db: DatabaseSync,
  projectId: string,
  opts: { afterSequence?: number; limit?: number } = {},
): EventPage {
  const afterSequence = opts.afterSequence ?? 0;
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  const rows = mapRows<EventSqlRow>(
    db
      .prepare(
        `SELECT event_id, project_id, run_id, session_id, timestamp_ms, sequence, request_id, type, data
         FROM project_events
         WHERE project_id = ? AND sequence > ?
         ORDER BY sequence
         LIMIT ?`,
      )
      .all(projectId, afterSequence, limit + 1),
  );
  const hasMore = rows.length > limit;
  return {
    events: rows.slice(0, limit).map(mapEventRow),
    hasMore,
  };
}

function mapEventRow(row: EventSqlRow): PersistedEvent {
  let data: unknown;
  try {
    data = JSON.parse(row.data);
  } catch {
    // A row that fails to parse must never crash a replay; surface it as an
    // empty payload and let schema validation flag it downstream.
    data = {};
  }
  return {
    eventId: row.event_id,
    projectId: row.project_id,
    runId: row.run_id,
    sessionId: row.session_id,
    timestampMs: row.timestamp_ms,
    sequence: row.sequence,
    requestId: row.request_id,
    type: row.type,
    data: data as Record<string, unknown>,
  };
}

/** Map a persisted event onto the v1 realtime envelope. */
export function serializeProjectEvent(event: PersistedEvent): RangerProjectEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: event.eventId,
    projectId: event.projectId,
    runId: event.runId,
    sessionId: event.sessionId,
    timestamp: iso(event.timestampMs),
    sequence: event.sequence,
    requestId: event.requestId,
    type: event.type,
    data: event.data,
  };
}

// -- replay cursors ----------------------------------------------------------

export interface EventCursor {
  v: 1;
  /** Sequence the client has already observed; replay resumes after it. */
  seq: number;
  /** Server timestamp (ms) carried for replay-window expiry. */
  ts: number;
}

/** Encode an opaque replay cursor. */
export function encodeEventCursor(seq: number, tsMs: number): string {
  const payload: EventCursor = { v: 1, seq, ts: tsMs };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode a replay cursor. Any malformed, wrong-version or out-of-range
 * cursor throws `invalid_cursor` (400) — never a silent resync.
 */
export function decodeEventCursor(raw: string): EventCursor {
  let parsed: unknown;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw Errors.invalidCursor('Event cursor is malformed', { reason: 'cursor_malformed' });
  }
  const cursor = parsed as Partial<EventCursor> | null;
  if (
    cursor === null ||
    typeof cursor !== 'object' ||
    cursor.v !== 1 ||
    typeof cursor.seq !== 'number' ||
    !Number.isInteger(cursor.seq) ||
    cursor.seq < 0 ||
    typeof cursor.ts !== 'number' ||
    !Number.isInteger(cursor.ts) ||
    cursor.ts <= 0
  ) {
    throw Errors.invalidCursor('Event cursor is malformed', { reason: 'cursor_malformed' });
  }
  return { v: 1, seq: cursor.seq, ts: cursor.ts };
}

/**
 * Reject cursors older than the replay window with `cursor_expired` (410).
 * The client recovers by resubscribing without a cursor (full replay).
 */
export function assertCursorNotExpired(cursor: EventCursor, replayWindowMs: number): void {
  if (Date.now() - cursor.ts > replayWindowMs) {
    throw Errors.cursorExpired('Event cursor is outside the replay window; resubscribe without a cursor', {
      reason: 'cursor_outside_replay_window',
      replayWindowMs,
    });
  }
}
