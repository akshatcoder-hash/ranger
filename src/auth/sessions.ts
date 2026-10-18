import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createHash, randomBytes } from 'node:crypto';
import { mapRow, mapRows } from '../db/db.js';
import { generateSecret, verifySecret } from './hashing.js';

/**
 * Revocable browser sessions delivered as an HttpOnly cookie.
 *
 * The cookie value is `<sessionId>.<secret>`; the server stores the secret
 * only as a lookup + scrypt hash. Sessions survive API restarts until they
 * are revoked or expire. Cookie-authenticated mutations additionally require
 * origin/CSRF protection (src/http/auth-middleware.ts); the synchronizer CSRF
 * token is returned once when the session is created and stored hashed.
 */

export const SESSION_COOKIE_NAME = 'ranger_session';
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionRow {
  id: string;
  principalId: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

export interface CookieAuthentication {
  session: SessionRow;
  principalId: string;
  /** Stored hash of the synchronizer CSRF token. */
  csrfHash: string;
}

interface SessionSqlRow {
  id: string;
  principal_id: string;
  secret_hash: string;
  csrf_hash: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

function mapSession(row: SessionSqlRow): SessionRow {
  return {
    id: row.id,
    principalId: row.principal_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export function sessionCookieValue(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

/** Parse the session cookie out of a raw Cookie header (multiple cookies tolerated). */
export function parseSessionCookieHeader(cookieHeader: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return value === '' ? null : value;
  }
  return null;
}

export function serializeSessionCookie(value: string, ttlMs: number): string {
  const maxAge = Math.max(0, Math.floor(ttlMs / 1000));
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

export function createSession(
  db: DatabaseSync,
  principalId: string,
  ttlMs: number = DEFAULT_SESSION_TTL_MS,
): { session: SessionRow; secret: string; csrfToken: string; setCookie: string } {
  const material = generateSecret('ses');
  const id = `ses_${randomUUID()}`;
  const now = Date.now();
  const expiresAt = now + ttlMs;
  const csrfToken = randomBytes(24).toString('base64url');
  const csrfHash = createHash('sha256').update(csrfToken, 'utf8').digest('hex');
  db.prepare(
    `INSERT INTO browser_sessions (id, principal_id, secret_lookup, secret_hash, csrf_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, principalId, material.lookup, material.hash, csrfHash, now, expiresAt);
  const session: SessionRow = { id, principalId, createdAt: now, expiresAt, revokedAt: null };
  return {
    session,
    secret: material.secret,
    csrfToken,
    setCookie: serializeSessionCookie(sessionCookieValue(id, material.secret), ttlMs),
  };
}

/** Authenticate a presented cookie value. Returns null when unknown/revoked/expired. */
export function authenticateCookie(db: DatabaseSync, cookieValue: string): CookieAuthentication | null {
  const dot = cookieValue.indexOf('.');
  if (dot <= 0) return null;
  const sessionId = cookieValue.slice(0, dot);
  const secret = cookieValue.slice(dot + 1);
  const row = mapRow<SessionSqlRow>(
    db.prepare('SELECT * FROM browser_sessions WHERE id = ?').get(sessionId),
  );
  if (row === undefined || row.revoked_at !== null) return null;
  if (row.expires_at <= Date.now()) return null;
  if (!verifySecret(secret, row.secret_hash)) return null;
  return {
    session: mapSession(row),
    principalId: row.principal_id,
    csrfHash: row.csrf_hash,
  };
}

/** Timing-safe synchronizer-token check for cookie-authenticated mutations. */
export function verifyCsrfToken(presented: string, csrfHash: string): boolean {
  const digest = createHash('sha256').update(presented, 'utf8').digest('hex');
  return digest.length === csrfHash.length && digest === csrfHash;
}

export function listSessions(db: DatabaseSync, principalId: string): SessionRow[] {
  const rows = mapRows<SessionSqlRow>(
    db
      .prepare('SELECT * FROM browser_sessions WHERE principal_id = ? ORDER BY created_at, id')
      .all(principalId),
  );
  return rows.map(mapSession);
}

/** Revoke one session owned by principalId; false when unknown or foreign. */
export function revokeSession(db: DatabaseSync, principalId: string, sessionId: string): boolean {
  const result = db
    .prepare(
      'UPDATE browser_sessions SET revoked_at = ? WHERE id = ? AND principal_id = ? AND revoked_at IS NULL',
    )
    .run(Date.now(), sessionId, principalId);
  return result.changes > 0;
}
