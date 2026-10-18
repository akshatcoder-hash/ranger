import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDatabase, withTransaction } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPrincipal } from '../../src/auth/principals.js';
import { createProjectRow } from '../../src/projects/store.js';
import {
  appendMessageRow,
  appendThreadVersion,
  createAnswerRow,
  createConversationRow,
  createQuestionRow,
  createVersionedThread,
  getConversationRow,
  getQuestionRow,
  listConversationRows,
  listMessageRows,
} from '../../src/conversations/store.js';
import { isAppError } from '../../src/errors.js';

function makeDb(): DatabaseSync {
  const dir = mkdtempSync(path.join(tmpdir(), 'ranger-conversations-unit-'));
  const db = openDatabase(dir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  return db;
}

function makeProject(db: DatabaseSync, name = 'Conversation Project'): string {
  const principal = createPrincipal(db, 'Owner');
  return createProjectRow(db, { name, engineerDisplayName: 'Ranger', principalId: principal.id }).id;
}

describe('conversations store', () => {
  it('creates and lists conversations scoped to the project', () => {
    const db = makeDb();
    const a = makeProject(db, 'A');
    const b = makeProject(db, 'B');
    const cnv = withTransaction(db, () => createConversationRow(db, a, 'Integration thread'));
    expect(cnv.projectId).toBe(a);
    expect(getConversationRow(db, a, cnv.id)?.title).toBe('Integration thread');
    expect(getConversationRow(db, b, cnv.id)).toBeNull();
    withTransaction(db, () => createConversationRow(db, b, 'Other thread'));
    expect(listConversationRows(db, a).map((c) => c.id)).toEqual([cnv.id]);
    expect(listConversationRows(db, b)).toHaveLength(1);
    db.close();
  });

  it('appends messages with dense per-conversation ordinals and pages stably', () => {
    const db = makeDb();
    const projectId = makeProject(db);
    const cnv = withTransaction(db, () => createConversationRow(db, projectId, 'T'));
    withTransaction(db, () => {
      for (let i = 0; i < 4; i += 1) {
        const message = appendMessageRow(db, cnv.id, i % 2 === 0 ? 'user' : 'agent', `m${i}`);
        expect(message.ordinal).toBe(i + 1);
      }
    });
    const all = listMessageRows(db, cnv.id, {});
    expect(all.messages.map((m) => m.ordinal)).toEqual([1, 2, 3, 4]);
    expect(all.hasMore).toBe(false);
    const page = listMessageRows(db, cnv.id, { afterOrdinal: 2, limit: 2 });
    expect(page.messages.map((m) => m.content)).toEqual(['m2', 'm3']);
    expect(page.hasMore).toBe(false);
    const tight = listMessageRows(db, cnv.id, { afterOrdinal: 0, limit: 2 });
    expect(tight.messages.map((m) => m.ordinal)).toEqual([1, 2]);
    expect(tight.hasMore).toBe(true);
    db.close();
  });

  it('records questions and answers where each answer references the exact question', () => {
    const db = makeDb();
    const projectId = makeProject(db);
    const cnv = withTransaction(db, () => createConversationRow(db, projectId, 'Q&A'));
    const question = withTransaction(db, () => createQuestionRow(db, cnv.id, 'Which refund policy applies?'));
    expect(getQuestionRow(db, cnv.id, question.id)?.prompt).toBe('Which refund policy applies?');
    const answer = withTransaction(db, () => createAnswerRow(db, question.id, 'Policy v3'));
    expect(answer.questionId).toBe(question.id);
    // A question from another conversation does not resolve here.
    const other = withTransaction(db, () => createConversationRow(db, projectId, 'Other'));
    expect(getQuestionRow(db, other.id, question.id)).toBeNull();
    db.close();
  });

  it('appends immutable requirement versions; prior versions stay readable', () => {
    const db = makeDb();
    const projectId = makeProject(db);
    const first = withTransaction(db, () => createVersionedThread(db, 'requirement', projectId, 'Require refunds to ask a human'));
    expect(first.thread.currentVersion).toBe(1);
    const second = withTransaction(db, () => appendThreadVersion(db, 'requirement', projectId, first.thread.id, 'Also dedupe tickets'));
    expect(second.thread.currentVersion).toBe(2);
    expect(second.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(second.versions[0]!.content).toBe('Require refunds to ask a human');
    db.close();
  });

  it('never exposes requirement threads across projects', () => {
    const db = makeDb();
    const a = makeProject(db, 'A');
    const b = makeProject(db, 'B');
    const created = withTransaction(db, () => createVersionedThread(db, 'requirement', a, 'content'));
    let caught: unknown;
    try {
      withTransaction(db, () => appendThreadVersion(db, 'requirement', b, created.thread.id, 'hijack'));
    } catch (cause) {
      caught = cause;
    }
    expect(isAppError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('not_found');
    db.close();
  });
});
