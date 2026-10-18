import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mapRow, withTransaction } from '../db/db.js';
import { Errors, type AppError } from '../errors.js';
import { generateSecret, lookupForSecret, verifySecret } from './hashing.js';

/**
 * Short-lived single-use connection tickets.
 *
 * A ticket binds one principal, one project, one purpose (events / voice
 * relay / desktop stream / app preview) and optionally one origin. It is
 * created through an authenticated request and can be consumed exactly once
 * (WebSocket upgrades and similar connection flows pass it as a query
 * parameter — short-lived by design, never a permanent key in a URL).
 *
 * Revocation propagates: a ticket stops working when its issuing credential
 * (API token or browser session) is revoked, when the ticket itself is
 * expired/used/revoked, or when the bound purpose/project/origin mismatch.
 */

export const CONNECTION_TICKET_PURPOSES = ['events', 'voice-relay', 'desktop-stream', 'app-preview'] as const;
export type TicketPurpose = (typeof CONNECTION_TICKET_PURPOSES)[number];

/** Short-lived by contract: 60 seconds from creation. */
export const DEFAULT_TICKET_TTL_MS = 60_000;

export type TicketIssuingCredentialKind = 'api_token' | 'browser_session';

export interface TicketRow {
  id: string;
  principalId: string;
  projectId: string;
  purpose: TicketPurpose;
  origin: string | null;
  credentialKind: TicketIssuingCredentialKind;
  credentialId: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
}

export interface TicketBinding {
  ticketId: string;
  principalId: string;
  projectId: string;
  purpose: string;
}

/**
 * The origin a ticket is bound to, or null when unbound or unknown.
 * Callers pass this through to the upgrade-time origin check before
 * consuming the ticket.
 */
export function lookupTicketOrigin(db: DatabaseSync, secret: string): string | null {
  const row = mapRow<{ origin: string | null }>(
    db.prepare('SELECT origin FROM connection_tickets WHERE secret_lookup = ?').get(lookupForSecret(secret)),
  );
  return row?.origin ?? null;
}

export interface CreateTicketInput {
  principalId: string;
  projectId: string;
  purpose: TicketPurpose;
  origin?: string;
  credentialKind: TicketIssuingCredentialKind;
  credentialId: string;
  ttlMs?: number;
}

interface TicketSqlRow {
  id: string;
  principal_id: string;
  project_id: string;
  purpose: string;
  origin: string | null;
  credential_kind: string;
  credential_id: string;
  secret_hash: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
}

function ticketError(reason: string): AppError {
  return Errors.unauthorized('Connection ticket is not valid for this use', { reason });
}

export function createTicket(
  db: DatabaseSync,
  input: CreateTicketInput,
): { ticket: TicketRow; secret: string } {
  const material = generateSecret('tkt');
  const id = `tkt_${randomUUID()}`;
  const now = Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_TICKET_TTL_MS;
  db.prepare(
    `INSERT INTO connection_tickets
       (id, principal_id, project_id, purpose, origin, credential_kind, credential_id,
        secret_lookup, secret_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.principalId,
    input.projectId,
    input.purpose,
    input.origin ?? null,
    input.credentialKind,
    input.credentialId,
    material.lookup,
    material.hash,
    now,
    now + ttlMs,
  );
  return {
    ticket: {
      id,
      principalId: input.principalId,
      projectId: input.projectId,
      purpose: input.purpose,
      origin: input.origin ?? null,
      credentialKind: input.credentialKind,
      credentialId: input.credentialId,
      createdAt: now,
      expiresAt: now + ttlMs,
      usedAt: null,
      revokedAt: null,
    },
    secret: material.secret,
  };
}

/**
 * Consume a presented ticket for one purpose. Atomically marks it used:
 * concurrent consumers get exactly one success. Throws `unauthorized` with a
 * stable reason in details for every failure class.
 */
export function consumeTicket(
  db: DatabaseSync,
  secret: string,
  check: { purpose: string; projectId?: string; origin?: string },
): TicketBinding {
  const row = mapRow<TicketSqlRow>(
    db
      .prepare('SELECT * FROM connection_tickets WHERE secret_lookup = ?')
      .get(lookupForSecret(secret)),
  );
  if (row === undefined) throw ticketError('ticket_unknown');
  if (row.revoked_at !== null) throw ticketError('ticket_revoked');
  if (row.used_at !== null) throw ticketError('ticket_used');
  if (row.expires_at <= Date.now()) throw ticketError('ticket_expired');
  if (row.purpose !== check.purpose) throw ticketError('purpose_mismatch');
  if (check.projectId !== undefined && row.project_id !== check.projectId) {
    throw ticketError('project_mismatch');
  }
  if (row.origin !== null && check.origin !== undefined && row.origin !== check.origin) {
    throw ticketError('origin_mismatch');
  }
  if (!verifySecret(secret, row.secret_hash)) throw ticketError('ticket_unknown');

  // The issuing credential must still be alive: revoking an API token or a
  // browser session immediately invalidates its outstanding tickets.
  const now = Date.now();
  if (row.credential_kind === 'api_token') {
    const cred = mapRow<{ revoked_at: number | null }>(
      db.prepare('SELECT revoked_at FROM credentials WHERE id = ?').get(row.credential_id),
    );
    if (cred === undefined || cred.revoked_at !== null) throw ticketError('issuer_revoked');
  } else {
    const ses = mapRow<{ revoked_at: number | null; expires_at: number }>(
      db
        .prepare('SELECT revoked_at, expires_at FROM browser_sessions WHERE id = ?')
        .get(row.credential_id),
    );
    if (ses === undefined || ses.revoked_at !== null || ses.expires_at <= now) {
      throw ticketError('issuer_revoked');
    }
  }

  return withTransaction(db, () => {
    const result = db
      .prepare('UPDATE connection_tickets SET used_at = ? WHERE id = ? AND used_at IS NULL')
      .run(now, row.id);
    if (result.changes !== 1) throw ticketError('ticket_used');
    return {
      ticketId: row.id,
      principalId: row.principal_id,
      projectId: row.project_id,
      purpose: row.purpose,
    };
  });
}
