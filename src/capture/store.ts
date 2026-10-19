import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { mapRow } from '../db/db.js';
import { Errors } from '../errors.js';

/**
 * Capture session and frame-metadata persistence (feature:
 * lean-voice-latest-frame). ONLY metadata persists; raw frame bytes live
 * exclusively in the bounded in-memory latest-frame slot and are cleared
 * when the capture session ends. There are no recordings and no retained
 * media; `retainEvidence` is an explicit unsupported capability.
 */

export type CaptureSessionState = 'active' | 'ended';

export interface CaptureSessionRow {
  id: string;
  projectId: string;
  conversationId: string | null;
  state: CaptureSessionState;
  generation: number;
  createdAt: number;
  endedAt: number | null;
}

interface CaptureSessionSqlRow {
  id: string;
  project_id: string;
  conversation_id: string | null;
  state: string;
  generation: number;
  created_at: number;
  ended_at: number | null;
}

function mapCaptureSession(row: CaptureSessionSqlRow): CaptureSessionRow {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    state: row.state as CaptureSessionState,
    generation: row.generation,
    createdAt: row.created_at,
    endedAt: row.ended_at,
  };
}

export function getCaptureSessionRow(db: DatabaseSync, projectId: string, sessionId: string): CaptureSessionRow | null {
  const row = mapRow<CaptureSessionSqlRow>(
    db.prepare('SELECT * FROM capture_sessions WHERE id = ? AND project_id = ?').get(sessionId, projectId),
  );
  return row === undefined ? null : mapCaptureSession(row);
}

/** Capture access stays inside the voice call's project and conversation. */
export function activeConversationCaptures(db: DatabaseSync, projectId: string, conversationId: string): CaptureSessionRow[] {
  return (db.prepare(
    "SELECT * FROM capture_sessions WHERE project_id = ? AND conversation_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT 2",
  ).all(projectId, conversationId) as unknown as CaptureSessionSqlRow[]).map(mapCaptureSession);
}

/** Create one active capture session (generation 1). Caller's transaction. */
export function createCaptureSessionRow(
  db: DatabaseSync,
  input: { projectId: string; conversationId?: string | null },
): CaptureSessionRow {
  if (input.conversationId !== undefined && input.conversationId !== null) {
    const conversation = mapRow<{ id: string }>(
      db
        .prepare('SELECT id FROM conversations WHERE id = ? AND project_id = ?')
        .get(input.conversationId, input.projectId),
    );
    if (conversation === undefined) {
      throw Errors.notFound(`Conversation ${input.conversationId} does not exist in this project`);
    }
  }
  const row: CaptureSessionRow = {
    id: `cap_${randomUUID()}`,
    projectId: input.projectId,
    conversationId: input.conversationId ?? null,
    state: 'active',
    generation: 1,
    createdAt: Date.now(),
    endedAt: null,
  };
  db.prepare(
    "INSERT INTO capture_sessions (id, project_id, conversation_id, state, generation, created_at) VALUES (?, ?, ?, 'active', 1, ?)",
  ).run(row.id, row.projectId, row.conversationId, row.createdAt);
  return row;
}

/**
 * End a capture session exactly once: state becomes 'ended' and the
 * generation ADVANCES, so any in-flight inspection bound to the old
 * generation is stale by identity, not by clock. Idempotent. Caller's
 * transaction.
 */
export function endCaptureSessionRow(db: DatabaseSync, projectId: string, sessionId: string): CaptureSessionRow {
  const existing = getCaptureSessionRow(db, projectId, sessionId);
  if (existing === null) {
    throw Errors.notFound(`Capture session ${sessionId} does not exist in this project`);
  }
  if (existing.state === 'ended') return existing;
  db.prepare(
    "UPDATE capture_sessions SET state = 'ended', generation = generation + 1, ended_at = ? WHERE id = ? AND state = 'active'",
  ).run(Date.now(), sessionId);
  return getCaptureSessionRow(db, projectId, sessionId)!;
}

export interface CaptureFrameMetadata {
  frameId: string;
  sessionId: string;
  generation: number;
  byteSize: number;
  width: number;
  height: number;
  captureTimestamp: number;
  createdAt: number;
}

/** Persist frame METADATA only (never bytes). Caller's transaction. */
export function insertFrameMetadata(db: DatabaseSync, input: CaptureFrameMetadata & { id: string }): void {
  db.prepare(
    `INSERT INTO capture_frame_metadata
       (id, session_id, generation, frame_id, byte_size, width, height, capture_timestamp, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.sessionId,
    input.generation,
    input.frameId,
    input.byteSize,
    input.width,
    input.height,
    input.captureTimestamp,
    input.createdAt,
  );
}

export function getFrameMetadata(db: DatabaseSync, sessionId: string, frameId: string): CaptureFrameMetadata | null {
  const row = mapRow<{
    id: string;
    session_id: string;
    generation: number;
    frame_id: string;
    byte_size: number;
    width: number;
    height: number;
    capture_timestamp: number;
    created_at: number;
  }>(
    db
      .prepare('SELECT * FROM capture_frame_metadata WHERE session_id = ? AND frame_id = ?')
      .get(sessionId, frameId),
  );
  if (row === undefined) return null;
  return {
    frameId: row.frame_id,
    sessionId: row.session_id,
    generation: row.generation,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    captureTimestamp: row.capture_timestamp,
    createdAt: row.created_at,
  };
}
