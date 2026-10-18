import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mapRow, mapRows } from '../db/db.js';
import { generateSecret, lookupForSecret, materialForSecret, verifySecret } from './hashing.js';

/**
 * Principals and hashed bearer credentials.
 *
 * A credential is either the self-hosted bootstrap credential (kind
 * 'bootstrap', created once by the bootstrap CLI) or a normal API token
 * (kind 'api_token', created through the API with its secret shown exactly
 * once). Both authenticate as `Authorization: Bearer <secret>` and are
 * revoked without deleting the row so revocation is durable and auditable.
 */

export type CredentialKind = 'bootstrap' | 'api_token';

export interface PrincipalRow {
  id: string;
  displayName: string;
  createdAt: number;
}

export interface CredentialRow {
  id: string;
  principalId: string;
  kind: CredentialKind;
  name: string;
  createdAt: number;
  revokedAt: number | null;
}

export interface BearerAuthentication {
  principalId: string;
  credentialId: string;
  kind: CredentialKind;
}

interface PrincipalSqlRow {
  id: string;
  display_name: string;
  created_at: number;
}

interface CredentialSqlRow {
  id: string;
  principal_id: string;
  kind: string;
  name: string;
  secret_lookup: string;
  secret_hash: string;
  created_at: number;
  revoked_at: number | null;
}

function mapPrincipal(row: PrincipalSqlRow): PrincipalRow {
  return { id: row.id, displayName: row.display_name, createdAt: row.created_at };
}

function mapCredential(row: CredentialSqlRow): CredentialRow {
  return {
    id: row.id,
    principalId: row.principal_id,
    kind: row.kind as CredentialKind,
    name: row.name,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export function createPrincipal(db: DatabaseSync, displayName: string): PrincipalRow {
  const row: PrincipalRow = {
    id: `prin_${randomUUID()}`,
    displayName,
    createdAt: Date.now(),
  };
  db.prepare('INSERT INTO principals (id, display_name, created_at) VALUES (?, ?, ?)').run(
    row.id,
    row.displayName,
    row.createdAt,
  );
  return row;
}

export function getPrincipal(db: DatabaseSync, principalId: string): PrincipalRow | null {
  const row = mapRow<PrincipalSqlRow>(
    db.prepare('SELECT id, display_name, created_at FROM principals WHERE id = ?').get(principalId),
  );
  return row === undefined ? null : mapPrincipal(row);
}

/** Create a credential and return its secret — shown exactly once, never stored. */
export function createCredential(
  db: DatabaseSync,
  principalId: string,
  kind: CredentialKind,
  name: string,
): { credential: CredentialRow; secret: string } {
  const material = generateSecret('rng');
  const credential = createCredentialFromSecret(db, principalId, kind, name, material.secret);
  return { credential, secret: material.secret };
}

/** Create a credential for a caller-chosen secret (bootstrap CLI path). */
export function createCredentialFromSecret(
  db: DatabaseSync,
  principalId: string,
  kind: CredentialKind,
  name: string,
  secret: string,
): CredentialRow {
  const material = materialForSecret(secret);
  // The contract pins visible id prefixes per resource kind: API tokens are
  // tok_…; the bootstrap credential has no public route of its own.
  const id = kind === 'api_token' ? `tok_${randomUUID()}` : `cred_${randomUUID()}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO credentials (id, principal_id, kind, name, secret_lookup, secret_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, principalId, kind, name, material.lookup, material.hash, now);
  return {
    id,
    principalId,
    kind,
    name,
    createdAt: now,
    revokedAt: null,
  };
}

export function listCredentials(db: DatabaseSync, principalId: string, kind?: CredentialKind): CredentialRow[] {
  const rows = mapRows<CredentialSqlRow>(
    kind === undefined
      ? db
          .prepare('SELECT * FROM credentials WHERE principal_id = ? ORDER BY created_at, id')
          .all(principalId)
      : db
          .prepare('SELECT * FROM credentials WHERE principal_id = ? AND kind = ? ORDER BY created_at, id')
          .all(principalId, kind),
  );
  return rows.map(mapCredential);
}

export function getCredential(db: DatabaseSync, credentialId: string): CredentialRow | null {
  const row = mapRow<CredentialSqlRow>(db.prepare('SELECT * FROM credentials WHERE id = ?').get(credentialId));
  return row === undefined ? null : mapCredential(row);
}

/** First credential of a kind, ordered by creation (the bootstrap credential). */
export function findFirstCredential(db: DatabaseSync, kind: CredentialKind): CredentialRow | null {
  const row = mapRow<CredentialSqlRow>(
    db.prepare('SELECT * FROM credentials WHERE kind = ? ORDER BY created_at, id LIMIT 1').get(kind),
  );
  return row === undefined ? null : mapCredential(row);
}

/**
 * Revoke one credential owned by principalId. Returns false when the
 * credential does not exist or belongs to another principal (no existence
 * leak across principals).
 */
export function revokeCredential(db: DatabaseSync, principalId: string, credentialId: string): boolean {
  const result = db
    .prepare(
      'UPDATE credentials SET revoked_at = ? WHERE id = ? AND principal_id = ? AND revoked_at IS NULL',
    )
    .run(Date.now(), credentialId, principalId);
  return result.changes > 0;
}

/** Authenticate a presented bearer secret. Returns null when unknown/revoked. */
export function authenticateBearer(db: DatabaseSync, secret: string): BearerAuthentication | null {
  const lookup = lookupForSecret(secret);
  const row = mapRow<CredentialSqlRow>(
    db.prepare('SELECT * FROM credentials WHERE secret_lookup = ?').get(lookup),
  );
  if (row === undefined || row.revoked_at !== null) return null;
  if (!verifySecret(secret, row.secret_hash)) return null;
  return { principalId: row.principal_id, credentialId: row.id, kind: row.kind as CredentialKind };
}
