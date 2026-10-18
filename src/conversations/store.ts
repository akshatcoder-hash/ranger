import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { mapRow, mapRows } from '../db/db.js';
import { Errors } from '../errors.js';

/**
 * Conversation persistence: conversations, messages, clarification
 * questions/answers and versioned requirement/decision threads.
 *
 * Multi-statement writers here allocate dense per-thread ordinals/versions
 * and MUST run inside the caller's transaction (handlers own the
 * transaction so the mutation and its events commit atomically together
 * with any idempotency record). Reads are pure SELECTs.
 */

export type MessageRole = 'user' | 'agent' | 'system';

/**
 * Opaque list cursor for message pagination: {v:1, after: ordinal}.
 */
export function encodeMessageCursor(afterOrdinal: number): string {
  return Buffer.from(JSON.stringify({ v: 1, after: afterOrdinal }), 'utf8').toString('base64url');
}

export function decodeMessageCursor(raw: string): { after: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw Errors.invalidCursor('Message cursor is malformed', { reason: 'cursor_malformed' });
  }
  const cursor = parsed as { v?: unknown; after?: unknown } | null;
  if (
    cursor === null ||
    typeof cursor !== 'object' ||
    cursor.v !== 1 ||
    typeof cursor.after !== 'number' ||
    !Number.isInteger(cursor.after) ||
    cursor.after < 0
  ) {
    throw Errors.invalidCursor('Message cursor is malformed', { reason: 'cursor_malformed' });
  }
  return { after: cursor.after };
}

export interface ConversationRow {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
}

export function createConversationRow(db: DatabaseSync, projectId: string, title: string): ConversationRow {
  const row: ConversationRow = { id: `cnv_${randomUUID()}`, projectId, title, createdAt: Date.now() };
  db.prepare('INSERT INTO conversations (id, project_id, title, created_at) VALUES (?, ?, ?, ?)').run(
    row.id,
    row.projectId,
    row.title,
    row.createdAt,
  );
  return row;
}

function mapConversation(row: { id: string; project_id: string; title: string; created_at: number }): ConversationRow {
  return { id: row.id, projectId: row.project_id, title: row.title, createdAt: row.created_at };
}

export function getConversationRow(db: DatabaseSync, projectId: string, conversationId: string): ConversationRow | null {
  const row = mapRow<{ id: string; project_id: string; title: string; created_at: number }>(
    db.prepare('SELECT id, project_id, title, created_at FROM conversations WHERE id = ? AND project_id = ?').get(
      conversationId,
      projectId,
    ),
  );
  return row === undefined ? null : mapConversation(row);
}

export function listConversationRows(db: DatabaseSync, projectId: string): ConversationRow[] {
  const rows = mapRows<{ id: string; project_id: string; title: string; created_at: number }>(
    db
      .prepare('SELECT id, project_id, title, created_at FROM conversations WHERE project_id = ? ORDER BY created_at, id')
      .all(projectId),
  );
  return rows.map(mapConversation);
}

// -- messages ----------------------------------------------------------------

export interface MessageRow {
  id: string;
  conversationId: string;
  ordinal: number;
  role: MessageRole;
  content: string;
  createdAt: number;
}

export function appendMessageRow(db: DatabaseSync, conversationId: string, role: MessageRole, content: string): MessageRow {
  db.prepare(
    `INSERT INTO messages (id, conversation_id, ordinal, role, content, created_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM messages WHERE conversation_id = ?), ?, ?, ?)`,
  ).run(`msg_${randomUUID()}`, conversationId, conversationId, role, content, Date.now());
  const inserted = mapRow<MessageSqlRow>(
    db
      .prepare('SELECT id, conversation_id, ordinal, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY ordinal DESC LIMIT 1')
      .get(conversationId),
  );
  if (inserted === undefined) throw Errors.internal('Message row disappeared during append');
  return mapMessage(inserted);
}

interface MessageSqlRow {
  id: string;
  conversation_id: string;
  ordinal: number;
  role: string;
  content: string;
  created_at: number;
}

function mapMessage(row: MessageSqlRow): MessageRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    ordinal: row.ordinal,
    role: row.role as MessageRole,
    content: row.content,
    createdAt: row.created_at,
  };
}

export interface MessagePage {
  messages: MessageRow[];
  hasMore: boolean;
}

/** Stable total order by per-conversation ordinal; pages strictly after `afterOrdinal`. */
export function listMessageRows(
  db: DatabaseSync,
  conversationId: string,
  opts: { afterOrdinal?: number; limit?: number } = {},
): MessagePage {
  const afterOrdinal = opts.afterOrdinal ?? 0;
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  const rows = mapRows<MessageSqlRow>(
    db
      .prepare(
        'SELECT id, conversation_id, ordinal, role, content, created_at FROM messages WHERE conversation_id = ? AND ordinal > ? ORDER BY ordinal LIMIT ?',
      )
      .all(conversationId, afterOrdinal, limit + 1),
  );
  return { messages: rows.slice(0, limit).map(mapMessage), hasMore: rows.length > limit };
}

// -- questions and answers ---------------------------------------------------

export interface QuestionRow {
  id: string;
  conversationId: string;
  prompt: string;
  createdAt: number;
}

export function createQuestionRow(db: DatabaseSync, conversationId: string, prompt: string): QuestionRow {
  const row: QuestionRow = { id: `qst_${randomUUID()}`, conversationId, prompt, createdAt: Date.now() };
  db.prepare('INSERT INTO questions (id, conversation_id, prompt, created_at) VALUES (?, ?, ?, ?)').run(
    row.id,
    row.conversationId,
    row.prompt,
    row.createdAt,
  );
  return row;
}

export function getQuestionRow(db: DatabaseSync, conversationId: string, questionId: string): QuestionRow | null {
  const row = mapRow<{ id: string; conversation_id: string; prompt: string; created_at: number }>(
    db
      .prepare('SELECT id, conversation_id, prompt, created_at FROM questions WHERE id = ? AND conversation_id = ?')
      .get(questionId, conversationId),
  );
  return row === undefined
    ? null
    : { id: row.id, conversationId: row.conversation_id, prompt: row.prompt, createdAt: row.created_at };
}

export interface AnswerRow {
  id: string;
  questionId: string;
  content: string;
  createdAt: number;
}

export function createAnswerRow(db: DatabaseSync, questionId: string, content: string): AnswerRow {
  const row: AnswerRow = { id: `ans_${randomUUID()}`, questionId, content, createdAt: Date.now() };
  db.prepare('INSERT INTO answers (id, question_id, content, created_at) VALUES (?, ?, ?, ?)').run(
    row.id,
    row.questionId,
    row.content,
    row.createdAt,
  );
  return row;
}

export function listAnswerRows(db: DatabaseSync, questionId: string): AnswerRow[] {
  return mapRows<{ id: string; question_id: string; content: string; created_at: number }>(
    db.prepare('SELECT id, question_id, content, created_at FROM answers WHERE question_id = ? ORDER BY created_at, id').all(questionId),
  ).map((row) => ({ id: row.id, questionId: row.question_id, content: row.content, createdAt: row.created_at }));
}

// -- requirement and decision threads ----------------------------------------

export interface VersionedThreadRow {
  id: string;
  projectId: string;
  currentVersion: number;
  createdAt: number;
}

export interface ThreadVersionRow {
  version: number;
  content: string;
  createdAt: number;
}

export interface VersionedThread {
  thread: VersionedThreadRow;
  versions: ThreadVersionRow[];
}

type ThreadTables = 'requirement_threads' | 'decision_threads';

function threadTable(kind: 'requirement' | 'decision'): ThreadTables {
  return kind === 'requirement' ? 'requirement_threads' : 'decision_threads';
}

function threadVersionTable(kind: 'requirement' | 'decision'): string {
  return kind === 'requirement' ? 'requirement_versions' : 'decision_versions';
}

function idColumn(kind: 'requirement' | 'decision'): string {
  return kind === 'requirement' ? 'requirement_id' : 'decision_id';
}

/** Create a fresh thread with its first immutable version (inside a transaction). */
export function createVersionedThread(
  db: DatabaseSync,
  kind: 'requirement' | 'decision',
  projectId: string,
  content: string,
): VersionedThread {
  const table = threadTable(kind);
  const idPrefix = kind === 'requirement' ? 'rqm' : 'dcs';
  const now = Date.now();
  const id = `${idPrefix}_${randomUUID()}`;
  db.prepare(`INSERT INTO ${table} (id, project_id, current_version, created_at) VALUES (?, ?, 1, ?)`).run(id, projectId, now);
  db.prepare(`INSERT INTO ${threadVersionTable(kind)} (${idColumn(kind)}, version, content, created_at) VALUES (?, 1, ?, ?)`).run(
    id,
    content,
    now,
  );
  return { thread: { id, projectId, currentVersion: 1, createdAt: now }, versions: [{ version: 1, content, createdAt: now }] };
}

/**
 * Append the next immutable version to an existing thread (inside a
 * transaction). The thread must belong to the project; version numbers never
 * reuse and prior versions stay readable.
 */
export function appendThreadVersion(
  db: DatabaseSync,
  kind: 'requirement' | 'decision',
  projectId: string,
  threadId: string,
  content: string,
): VersionedThread {
  const table = threadTable(kind);
  const idColumn_ = idColumn(kind);
  const thread = mapRow<{ id: string; project_id: string; current_version: number; created_at: number }>(
    db.prepare(`SELECT id, project_id, current_version, created_at FROM ${table} WHERE id = ? AND project_id = ?`).get(
      threadId,
      projectId,
    ),
  );
  if (thread === undefined) throw Errors.notFound(`Thread ${threadId} does not exist in this project`);
  const nextVersion = thread.current_version + 1;
  const now = Date.now();
  db.prepare(`INSERT INTO ${threadVersionTable(kind)} (${idColumn_}, version, content, created_at) VALUES (?, ?, ?, ?)`).run(
    threadId,
    nextVersion,
    content,
    now,
  );
  db.prepare(`UPDATE ${table} SET current_version = ? WHERE id = ?`).run(nextVersion, threadId);
  return {
    thread: { id: thread.id, projectId: thread.project_id, currentVersion: nextVersion, createdAt: thread.created_at },
    versions: listThreadVersions(db, kind, threadId),
  };
}

function listThreadVersions(db: DatabaseSync, kind: 'requirement' | 'decision', threadId: string): ThreadVersionRow[] {
  const idColumn_ = idColumn(kind);
  return mapRows<{ version: number; content: string; created_at: number }>(
    db
      .prepare(`SELECT version, content, created_at FROM ${threadVersionTable(kind)} WHERE ${idColumn_} = ? ORDER BY version`)
      .all(threadId),
  ).map((row) => ({ version: row.version, content: row.content, createdAt: row.created_at }));
}

export function listVersionedThreads(db: DatabaseSync, kind: 'requirement' | 'decision', projectId: string): VersionedThread[] {
  const table = threadTable(kind);
  const rows = mapRows<{ id: string; project_id: string; current_version: number; created_at: number }>(
    db.prepare(`SELECT id, project_id, current_version, created_at FROM ${table} WHERE project_id = ? ORDER BY created_at, id`).all(projectId),
  );
  return rows.map((row) => ({
    thread: { id: row.id, projectId: row.project_id, currentVersion: row.current_version, createdAt: row.created_at },
    versions: listThreadVersions(db, kind, row.id),
  }));
}
