import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { mapRow, withTransaction } from '../db/db.js';
import { Errors } from '../errors.js';

/**
 * Scoped mutation idempotency.
 *
 * Mutating routes accept an `Idempotency-Key` header scoped to the
 * operation, project AND authenticated principal. The FIRST execution of
 * (scope, key) runs the mutation and stores its successful response body in
 * the SAME transaction as the state mutation and its events. An identical
 * retry (same canonical request hash) returns the stored result with no
 * second side effect and no duplicate event; reuse of the key with
 * different input is a `conflict`. Without a key the mutation executes
 * every time (idempotency is opt-in by callers).
 *
 * The principal is part of the scope: the same key and body presented by
 * two principals are independent authorized executions and never replay the
 * other's stored payload (auth middleware guarantees principalId on every
 * mutating route).
 *
 * The stored response is the handler's domain result; the per-request
 * requestId envelope is injected per response (and therefore differs on a
 * replay — only the domain result is replayed, exactly once).
 */

export interface IdempotentOutcome<T> {
  replayed: boolean;
  result: T;
}

/** Stable JSON stringify with object keys in sorted order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/** Canonical hash over the request input (path params, query, body). */
export function requestHash(parts: { params?: unknown; query?: unknown; body?: unknown }): string {
  const hash = createHash('sha256');
  hash.update(canonicalJson({ params: parts.params ?? null, query: parts.query ?? null, body: parts.body ?? null }));
  return hash.digest('hex');
}

/** The scoped idempotency key presented on a mutating request, if any. */
export function idempotencyKeyFrom(req: FastifyRequest): string | undefined {
  const raw = req.headers['idempotency-key'];
  if (Array.isArray(raw)) return raw[0];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value === '' ? undefined : value;
}

interface IdempotencySqlRow {
  request_hash: string;
  response_body: string;
}

/**
 * Run one project-scoped mutation through the idempotency wrapper.
 *
 * `execute` performs the state mutation AND its event appends and must not
 * open its own transaction. With an Idempotency-Key, first execution
 * commits mutation + events + record in ONE transaction; identical retries
 * replay the stored response; conflicting reuse is a 409. The scope binds
 * the operation, project and authenticated principal, so identical requests
 * from different principals never share stored results. Without a key the
 * mutation still commits atomically.
 */
export function runScopedMutation<T>(
  db: DatabaseSync,
  req: FastifyRequest,
  operationId: string,
  projectId: string,
  execute: () => T,
): T {
  return withIdempotentMutation(db, {
    scope: `${operationId}:${projectId}:${req.principalId ?? 'unauthenticated'}`,
    key: idempotencyKeyFrom(req),
    requestHash: requestHash({ params: req.params, query: req.query, body: req.body }),
    execute,
  }).result;
}

/**
 * Read-only peek at a stored idempotent result WITHOUT executing anything.
 *
 * Used by routes whose first execution includes a paid provider dial: the
 * dial must happen outside any transaction and must not repeat on an
 * exact-retry replay. Returns the stored result when (scope, key) exists
 * with the SAME request hash; undefined when absent; a conflicting reuse is
 * left for withIdempotentMutation to reject. No key → undefined.
 */
export function peekIdempotentResult<T>(db: DatabaseSync, opts: { scope: string; key: string | undefined; requestHash: string }): T | undefined {
  if (opts.key === undefined) return undefined;
  const existing = mapRow<IdempotencySqlRow>(
    db.prepare('SELECT request_hash, response_body FROM idempotency_records WHERE scope = ? AND idempotency_key = ?').get(opts.scope, opts.key),
  );
  if (existing === undefined || existing.request_hash !== opts.requestHash) return undefined;
  return JSON.parse(existing.response_body) as T;
}

/**
 * Run one idempotency-scoped mutation inside a single transaction.
 *
 * `execute` performs the state mutation AND its event appends; it must not
 * open its own transaction (this function owns the transaction). Errors from
 * `execute` roll back everything, including the idempotency record, so a
 * failed mutation is always retriable.
 */
export function withIdempotentMutation<T>(
  db: DatabaseSync,
  opts: { scope: string; key: string | undefined; requestHash: string; execute: () => T },
): IdempotentOutcome<T> {
  if (opts.key === undefined) {
    // No key: still atomic, but never recorded or replayed.
    return { replayed: false, result: withTransaction(db, opts.execute) };
  }
  const key = opts.key;
  return withTransaction(db, () => {
    const existing = mapRow<IdempotencySqlRow>(
      db
        .prepare('SELECT request_hash, response_body FROM idempotency_records WHERE scope = ? AND idempotency_key = ?')
        .get(opts.scope, key),
    );
    if (existing !== undefined) {
      if (existing.request_hash !== opts.requestHash) {
        throw Errors.conflict('Idempotency key was already used with a different request', {
          reason: 'idempotency_key_reuse',
          scope: opts.scope,
        });
      }
      return { replayed: true, result: JSON.parse(existing.response_body) as T };
    }
    const result = opts.execute();
    db.prepare(
      `INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response_status, response_body, created_at)
       VALUES (?, ?, ?, 200, ?, ?)`,
    ).run(opts.scope, key, opts.requestHash, JSON.stringify(result) ?? 'null', Date.now());
    return { replayed: false, result };
  });
}
