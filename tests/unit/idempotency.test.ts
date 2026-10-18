import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { requestHash, runScopedMutation, withIdempotentMutation } from '../../src/http/idempotency.js';
import { isAppError } from '../../src/errors.js';

function makeDb(): DatabaseSync {
  const dir = mkdtempSync(path.join(tmpdir(), 'ranger-idem-unit-'));
  const db = openDatabase(dir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  return db;
}

describe('scoped mutation idempotency', () => {
  it('executes once and replays the stored response for identical retries', () => {
    const db = makeDb();
    let executions = 0;
    const run = (key: string | undefined) =>
      withIdempotentMutation(db, {
        scope: 'createConversation:prj_a',
        key,
        requestHash: requestHash({ body: { title: 'T' } }),
        execute: () => {
          executions += 1;
          return { conversationId: 'cnv_1' };
        },
      });
    const first = run('key-1');
    expect(first).toEqual({ replayed: false, result: { conversationId: 'cnv_1' } });
    const retry = run('key-1');
    expect(retry).toEqual({ replayed: true, result: { conversationId: 'cnv_1' } });
    // A different key is a separate execution (new mutation).
    const secondKey = run('key-2');
    expect(secondKey.replayed).toBe(false);
    expect(executions).toBe(2);
    db.close();
  });

  it('conflicts when the same key is reused with different input', () => {
    const db = makeDb();
    const base = { scope: 'postMessage:prj_a', key: 'key-1' };
    withIdempotentMutation(db, {
      ...base,
      requestHash: requestHash({ body: { content: 'hello' } }),
      execute: () => ({ messageId: 'msg_1' }),
    });
    let caught: unknown;
    try {
      withIdempotentMutation(db, {
        ...base,
        requestHash: requestHash({ body: { content: 'hijacked' } }),
        execute: () => {
          throw new Error('must not execute');
        },
      });
    } catch (cause) {
      caught = cause;
    }
    expect(isAppError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('conflict');
    db.close();
  });

  it('executes every time without a key (idempotency is opt-in)', () => {
    const db = makeDb();
    let executions = 0;
    for (let i = 0; i < 3; i += 1) {
      const outcome = withIdempotentMutation(db, {
        scope: 'postMessage:prj_a',
        key: undefined,
        requestHash: requestHash({ body: { content: 'x' } }),
        execute: () => ({ n: (executions += 1) }),
      });
      expect(outcome.replayed).toBe(false);
    }
    expect(executions).toBe(3);
    db.close();
  });

  it('hashes request input canonically over key order and separates params from body', () => {
    expect(requestHash({ body: { a: 1, b: 2 } })).toBe(requestHash({ body: { b: 2, a: 1 } }));
    expect(requestHash({ body: { a: 1, b: 2 } })).not.toBe(requestHash({ body: { a: 1, b: 3 } }));
    expect(requestHash({ params: { projectId: 'prj_a' }, body: { a: 1 } })).not.toBe(
      requestHash({ params: { projectId: 'prj_b' }, body: { a: 1 } }),
    );
    expect(requestHash({ body: { a: 1 } })).not.toBe(requestHash({ body: { a: '1' } }));
  });

  it('scopes records so the same key under another operation or project is independent', () => {
    const db = makeDb();
    const shared = { key: 'key-1', requestHash: requestHash({ body: { x: 1 } }) };
    const a = withIdempotentMutation(db, { scope: 'opA:prj_a', ...shared, execute: () => 'A' });
    const b = withIdempotentMutation(db, { scope: 'opA:prj_b', ...shared, execute: () => 'B' });
    const c = withIdempotentMutation(db, { scope: 'opB:prj_a', ...shared, execute: () => 'C' });
    expect(a.result).toBe('A');
    expect(b.result).toBe('B');
    expect(c.result).toBe('C');
    db.close();
  });

  it('runScopedMutation scopes by the authenticated principal as well as operation/project', () => {
    const db = makeDb();
    const fakeReq = (principalId: string | undefined, key: string) =>
      ({
        principalId,
        headers: { 'idempotency-key': key },
        params: {},
        query: {},
        body: { name: 'Same', engineerDisplayName: 'Same' },
      }) as unknown as FastifyRequest;

    const created: string[] = [];
    const createProject = (principalId: string) =>
      runScopedMutation(db, fakeReq(principalId, 'shared-key'), 'createProject', '-', () => {
        const projectId = `prj_for_${principalId}`;
        created.push(projectId);
        return { projectId };
      });

    // Two principals presenting the SAME key and body never replay each
    // other's stored payload: each gets an independent authorized result.
    const a = createProject('prin_a');
    const b = createProject('prin_b');
    expect(a).toEqual({ projectId: 'prj_for_prin_a' });
    expect(b).toEqual({ projectId: 'prj_for_prin_b' });
    expect(created).toEqual(['prj_for_prin_a', 'prj_for_prin_b']);

    // The same principal's retry stays idempotent (replay, no re-execution).
    const aRetry = createProject('prin_a');
    expect(aRetry).toEqual({ projectId: 'prj_for_prin_a' });
    const bRetry = createProject('prin_b');
    expect(bRetry).toEqual({ projectId: 'prj_for_prin_b' });
    expect(created).toEqual(['prj_for_prin_a', 'prj_for_prin_b']);
    db.close();
  });

  it('runScopedMutation still conflicts within one principal when the body differs', () => {
    const db = makeDb();
    const fakeReq = (body: unknown, key: string) =>
      ({ principalId: 'prin_a', headers: { 'idempotency-key': key }, params: {}, query: {}, body }) as unknown as FastifyRequest;
    runScopedMutation(db, fakeReq({ v: 1 }, 'key-1'), 'updateProject', 'prj_a', () => 'first');
    let caught: unknown;
    try {
      runScopedMutation(db, fakeReq({ v: 2 }, 'key-1'), 'updateProject', 'prj_a', () => 'second');
    } catch (cause) {
      caught = cause;
    }
    expect(isAppError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('conflict');
    db.close();
  });
});
