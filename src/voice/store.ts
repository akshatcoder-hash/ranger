import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { mapRow } from '../db/db.js';
import { Errors } from '../errors.js';
import { getConversationRow } from '../conversations/store.js';

/**
 * Voice session persistence (feature: lean-voice-latest-frame).
 *
 * A voice session binds one principal + project + conversation to exactly
 * one explicit provider relay lifetime. Start/end are explicit; ending is
 * TERMINAL and idempotent: a second end returns the same ended state with
 * no further provider effect. A reconnect always creates a NEW session with
 * a fresh id — nothing here reconstructs upstream provider state, and
 * replaying project events never executes tool work.
 */

/** Hard session duration bound: a session cannot outlive this, even live. */
export const VOICE_SESSION_MAX_MS = 10 * 60_000;

export type VoiceSessionState = 'active' | 'ended';

export type VoiceSessionEndReason =
  | 'client_requested'
  | 'client_disconnect'
  | 'provider_disconnect'
  | 'provider_protocol_error'
  | 'slow_consumer'
  | 'session_limit'
  | 'dial_failed';

export interface VoiceSessionRow {
  id: string;
  projectId: string;
  conversationId: string;
  principalId: string;
  model: string;
  state: VoiceSessionState;
  endReason: VoiceSessionEndReason | null;
  audioSeconds: number;
  textTokens: number;
  toolCalls: number;
  createdAt: number;
  expiresAt: number;
  endedAt: number | null;
}

interface VoiceSessionSqlRow {
  id: string;
  project_id: string;
  conversation_id: string;
  principal_id: string;
  model: string;
  state: string;
  end_reason: string | null;
  audio_seconds: number;
  text_tokens: number;
  tool_calls: number;
  created_at: number;
  expires_at: number;
  ended_at: number | null;
}

function mapVoiceSession(row: VoiceSessionSqlRow): VoiceSessionRow {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    principalId: row.principal_id,
    model: row.model,
    state: row.state as VoiceSessionState,
    endReason: (row.end_reason as VoiceSessionEndReason | null) ?? null,
    audioSeconds: row.audio_seconds,
    textTokens: row.text_tokens,
    toolCalls: row.tool_calls,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
  };
}

export function getVoiceSessionRow(db: DatabaseSync, projectId: string, sessionId: string): VoiceSessionRow | null {
  const row = mapRow<VoiceSessionSqlRow>(
    db.prepare('SELECT * FROM voice_sessions WHERE id = ? AND project_id = ?').get(sessionId, projectId),
  );
  return row === undefined ? null : mapVoiceSession(row);
}

/**
 * Create one active voice session. The conversation must exist in the SAME
 * project (identity is immutable for the session's lifetime). Runs inside
 * the caller's transaction so the row and its event commit atomically.
 */
export function createVoiceSessionRow(
  db: DatabaseSync,
  input: { projectId: string; conversationId: string; principalId: string; model: string },
): VoiceSessionRow {
  const conversation = getConversationRow(db, input.projectId, input.conversationId);
  if (conversation === null) {
    throw Errors.notFound(`Conversation ${input.conversationId} does not exist in this project`);
  }
  const now = Date.now();
  const row: VoiceSessionRow = {
    id: `vcs_${randomUUID()}`,
    projectId: input.projectId,
    conversationId: conversation.id,
    principalId: input.principalId,
    model: input.model,
    state: 'active',
    endReason: null,
    audioSeconds: 0,
    textTokens: 0,
    toolCalls: 0,
    createdAt: now,
    expiresAt: now + VOICE_SESSION_MAX_MS,
    endedAt: null,
  };
  db.prepare(
    `INSERT INTO voice_sessions
       (id, project_id, conversation_id, principal_id, model, state, audio_seconds, text_tokens, tool_calls, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'active', 0, 0, 0, ?, ?)`,
  ).run(
    row.id,
    row.projectId,
    row.conversationId,
    row.principalId,
    row.model,
    row.createdAt,
    row.expiresAt,
  );
  return row;
}

/**
 * End a session exactly once. Terminal and idempotent: when already ended,
 * returns the existing row unchanged with no event, no usage change and no
 * provider effect. Usage accumulators pass through in the same statement so
 * a disconnect race can never lose recorded usage. Caller's transaction.
 */
export function endVoiceSessionRow(
  db: DatabaseSync,
  projectId: string,
  sessionId: string,
  reason: VoiceSessionEndReason,
  usage?: { audioSeconds?: number; textTokens?: number; toolCalls?: number },
): VoiceSessionRow {
  const existing = getVoiceSessionRow(db, projectId, sessionId);
  if (existing === null) {
    throw Errors.notFound(`Voice session ${sessionId} does not exist in this project`);
  }
  if (existing.state === 'ended') return existing;
  db.prepare(
    `UPDATE voice_sessions
     SET state = 'ended',
         end_reason = ?,
         ended_at = ?,
         audio_seconds = audio_seconds + ?,
         text_tokens = text_tokens + ?,
         tool_calls = tool_calls + ?
     WHERE id = ? AND state = 'active'`,
  ).run(
    reason,
    Date.now(),
    usage?.audioSeconds ?? 0,
    usage?.textTokens ?? 0,
    usage?.toolCalls ?? 0,
    sessionId,
  );
  return getVoiceSessionRow(db, projectId, sessionId)!;
}

/**
 * Add observed usage to an ACTIVE session (relay-side counters).
 * Caller's transaction; endVoiceSessionRow flushes any residual delta.
 */
export function addVoiceSessionUsage(
  db: DatabaseSync,
  sessionId: string,
  usage: { audioSeconds?: number; textTokens?: number; toolCalls?: number },
): void {
  db.prepare(
    `UPDATE voice_sessions
     SET audio_seconds = audio_seconds + ?, text_tokens = text_tokens + ?, tool_calls = tool_calls + ?
     WHERE id = ? AND state = 'active'`,
  ).run(usage.audioSeconds ?? 0, usage.textTokens ?? 0, usage.toolCalls ?? 0, sessionId);
}
