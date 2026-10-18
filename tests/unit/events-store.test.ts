import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { openDatabase, withTransaction } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  appendProjectEvent,
  assertCursorNotExpired,
  decodeEventCursor,
  encodeEventCursor,
  listProjectEvents,
  projectEventHead,
  serializeProjectEvent,
} from '../../src/events/store.js';
import { Errors, isAppError } from '../../src/errors.js';
import { createPrincipal } from '../../src/auth/principals.js';
import { createProjectRow } from '../../src/projects/store.js';
import { EVENT_ENVELOPE_SCHEMA } from '../../src/contracts/events.js';

function makeDb(): DatabaseSync {
  const dir = mkdtempSync(path.join(tmpdir(), 'ranger-events-unit-'));
  const db = openDatabase(dir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  return db;
}

function makeProject(db: DatabaseSync, name = 'Event Project'): string {
  const principal = createPrincipal(db, 'Owner');
  return createProjectRow(db, { name, engineerDisplayName: 'Ranger', principalId: principal.id }).id;
}

function expectAppErrorCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (cause) {
    expect(isAppError(cause)).toBe(true);
    expect((cause as { code: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} error, but the call succeeded`);
}

describe('project event append', () => {
  it('allocates dense strictly increasing per-project sequences inside a transaction', () => {
    const db = makeDb();
    const a = makeProject(db, 'A');
    const b = makeProject(db, 'B');
    withTransaction(db, () => {
      for (let i = 0; i < 3; i += 1) {
        const event = appendProjectEvent(db, { projectId: a, type: 'project.updated', data: { name: 'A', engineerDisplayName: `E${i}` }, requestId: 'req-1' });
        expect(event.sequence).toBe(i + 1);
      }
      const other = appendProjectEvent(db, { projectId: b, type: 'project.updated', data: { name: 'B', engineerDisplayName: 'E' }, requestId: 'req-2' });
      // Per-project allocation: another project starts at 1.
      expect(other.sequence).toBe(1);
    });
    expect(projectEventHead(db, a)).toBe(3);
    expect(projectEventHead(db, b)).toBe(1);
    db.close();
  });

  it('refuses to append outside a transaction so mutation+event commit atomically', () => {
    const db = makeDb();
    const projectId = makeProject(db);
    expectAppErrorCode(
      () => appendProjectEvent(db, { projectId, type: 'project.updated', data: { name: 'A', engineerDisplayName: 'E' }, requestId: 'req-1' }),
      'internal_error',
    );
    expect(projectEventHead(db, projectId)).toBe(0);
    db.close();
  });

  it('rolls back sequence allocation with the surrounding transaction (no gaps)', () => {
    const db = makeDb();
    const projectId = makeProject(db);
    try {
      withTransaction(db, () => {
        appendProjectEvent(db, { projectId, type: 'project.updated', data: { name: 'A', engineerDisplayName: 'E' }, requestId: 'req-1' });
        appendProjectEvent(db, { projectId, type: 'project.updated', data: { name: 'A', engineerDisplayName: 'E2' }, requestId: 'req-1' });
        throw Errors.conflict('forced rollback');
      });
    } catch {
      // expected
    }
    withTransaction(db, () => {
      const event = appendProjectEvent(db, { projectId, type: 'project.updated', data: { name: 'A', engineerDisplayName: 'E3' }, requestId: 'req-2' });
      // The rolled-back transaction never consumed sequence 1.
      expect(event.sequence).toBe(1);
    });
    expect(listProjectEvents(db, projectId, {}).events).toHaveLength(1);
    db.close();
  });

  it('rejects undeclared event types and data violating the declared type schema', () => {
    const db = makeDb();
    const projectId = makeProject(db);
    withTransaction(db, () => {
      expectAppErrorCode(
        () => appendProjectEvent(db, { projectId, type: 'not.a.declared.event', data: {}, requestId: 'req-1' }),
        'internal_error',
      );
      expectAppErrorCode(
        () => appendProjectEvent(db, { projectId, type: 'project.updated', data: { name: 'A' }, requestId: 'req-1' }),
        'internal_error',
      );
      expectAppErrorCode(
        () => appendProjectEvent(db, { projectId, type: 'membership.updated', data: { principalId: 'prin_x', role: 'root' }, requestId: 'req-1' }),
        'internal_error',
      );
    });
    expect(projectEventHead(db, projectId)).toBe(0);
    db.close();
  });
});

describe('event replay and cursors', () => {
  it('replays pages in order with hasMore and no gaps', () => {
    const db = makeDb();
    const projectId = makeProject(db);
    withTransaction(db, () => {
      for (let i = 0; i < 5; i += 1) {
        appendProjectEvent(db, { projectId, type: 'project.updated', data: { name: 'A', engineerDisplayName: `E${i}` }, requestId: 'req-1' });
      }
    });
    expect(listProjectEvents(db, projectId, {}).events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    const page1 = listProjectEvents(db, projectId, { afterSequence: 0, limit: 2 });
    expect(page1.events.map((e) => e.sequence)).toEqual([1, 2]);
    expect(page1.hasMore).toBe(true);
    const page2 = listProjectEvents(db, projectId, { afterSequence: 2, limit: 2 });
    expect(page2.events.map((e) => e.sequence)).toEqual([3, 4]);
    expect(page2.hasMore).toBe(true);
    const page3 = listProjectEvents(db, projectId, { afterSequence: 4, limit: 2 });
    expect(page3.events.map((e) => e.sequence)).toEqual([5]);
    expect(page3.hasMore).toBe(false);
    // Another project's events never leak in.
    const other = makeProject(db, 'Other');
    expect(listProjectEvents(db, other, {}).events).toEqual([]);
    db.close();
  });

  it('round-trips cursors and rejects invalid cursors with the stable code', () => {
    const encoded = encodeEventCursor(7, 1_700_000_000_000);
    expect(decodeEventCursor(encoded)).toEqual({ v: 1, seq: 7, ts: 1_700_000_000_000 });
    for (const bad of ['', 'garbage!!', '%%%', Buffer.from('not json').toString('base64url'), Buffer.from(JSON.stringify({ v: 1 })).toString('base64url'), encodeEventCursor(-1, 1_700_000_000_000)]) {
      expectAppErrorCode(() => decodeEventCursor(bad), 'invalid_cursor');
    }
  });

  it('expires cursors past the replay window with the stable code', () => {
    const now = Date.now();
    const fresh = decodeEventCursor(encodeEventCursor(3, now - 1_000));
    expect(() => assertCursorNotExpired(fresh, 60_000)).not.toThrow();
    const old = decodeEventCursor(encodeEventCursor(3, now - 120_000));
    expectAppErrorCode(() => assertCursorNotExpired(old, 60_000), 'cursor_expired');
  });

  it('serializes events into the contract envelope shape', () => {
    const db = makeDb();
    const projectId = makeProject(db);
    let persisted;
    withTransaction(db, () => {
      persisted = appendProjectEvent(db, { projectId, type: 'project.updated', data: { name: 'A', engineerDisplayName: 'Ranger' }, requestId: 'req-1' });
    });
    const envelope = serializeProjectEvent(persisted!);
    const ajv = new Ajv({ strict: false, validateFormats: false });
    expect(ajv.compile(EVENT_ENVELOPE_SCHEMA)(envelope)).toBe(true);
    expect(envelope.sequence).toBe(1);
    expect(envelope.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.requestId).toBe('req-1');
    db.close();
  });
});
