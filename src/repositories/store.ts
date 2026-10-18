import type { DatabaseSync } from 'node:sqlite';
import { Errors } from '../errors.js';
import { mapRow, withTransaction } from '../db/db.js';
import { resolveLocalSnapshot } from './snapshot.js';

/**
 * Project repository connection records.
 *
 * A connection records the approved URL, ref, checkout path and checkout
 * policy — never any credential material (any https/file userinfo, and any
 * ssh/git password, is rejected outright). When the URL resolves to a local
 * git worktree under an OPERATOR-APPROVED snapshot root, the record also
 * carries the resolved commit, dirty snapshot flag and content hash; remote
 * URLs (and unapproved local paths, which are refused) persist the approved
 * reference and resolve these fields when the workspace checkout exists.
 * One repository per project.
 */

export interface CheckoutPolicy {
  shallow: boolean;
  submodules: boolean;
}

export interface RepositoryRecord {
  projectId: string;
  url: string;
  ref: string;
  commit: string;
  dirty: boolean;
  contentHash: string;
  checkoutPath: string;
  checkoutPolicy: CheckoutPolicy;
  connectedBy: string;
  connectedAt: number;
  updatedAt: number;
}

export interface RepositoryInput {
  url: string;
  ref: string;
  checkoutPath?: string;
  checkoutPolicy?: { shallow?: boolean; submodules?: boolean };
}

interface RepositorySqlRow {
  project_id: string;
  url: string;
  ref: string;
  commit_sha: string;
  dirty: number;
  content_hash: string;
  checkout_path: string;
  checkout_policy: string;
  connected_by: string;
  connected_at: number;
  updated_at: number;
}

const ALLOWED_URL_SCHEMES = new Set(['file', 'https', 'ssh', 'git']);
const DEFAULT_CHECKOUT_PATH = 'workspace';

function validationError(message: string, reason: string): never {
  throw Errors.validation(message, { reason });
}

export function validateRepositoryInput(input: RepositoryInput): {
  url: string;
  ref: string;
  checkoutPath: string;
  checkoutPolicy: CheckoutPolicy;
} {
  const url = validateUrl(input.url);
  const ref = validateRef(input.ref);
  const checkoutPath = validateCheckoutPath(input.checkoutPath ?? DEFAULT_CHECKOUT_PATH);
  const checkoutPolicy: CheckoutPolicy = {
    shallow: input.checkoutPolicy?.shallow === true,
    submodules: input.checkoutPolicy?.submodules === true,
  };
  return { url, ref, checkoutPath, checkoutPolicy };
}

function validateUrl(raw: string): string {
  if (raw.length === 0 || raw.length > 2048) {
    validationError('Repository URL is missing or too long', 'invalid_url');
  }
  // Plain absolute paths are accepted as local repositories.
  if (raw.startsWith('/')) return raw;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    validationError('Repository URL is not a valid absolute URL', 'invalid_url');
  }
  const scheme = parsed.protocol.replace(/:$/, '');
  if (!ALLOWED_URL_SCHEMES.has(scheme)) {
    validationError('Repository URL scheme is not approved (allowed: file, https, ssh, git)', 'scheme_not_approved');
  }
  // Credential material in the URL is never accepted, stored, returned or
  // proxied. HTTPS and file URLs must not carry ANY userinfo: the common
  // token-as-username forms (`https://<token>@host/...`, including
  // percent-encoded variants) are credentials, not usernames, and the URL
  // parser decodes nothing here — any non-empty userinfo is refused. SSH/git
  // keep an ordinary plain username (git@host) but never a password.
  if (parsed.username !== '' || parsed.password !== '') {
    if (scheme === 'https' || scheme === 'file' || parsed.password !== '') {
      validationError('Repository URL must not contain embedded credentials', 'credentials_in_url');
    }
  }
  return raw;
}

function validateRef(raw: string): string {
  if (raw.length === 0 || raw.length > 256) {
    validationError('Repository ref is missing or too long', 'invalid_ref');
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(raw) || raw.startsWith('-') || raw.startsWith('.') || raw.includes('..')) {
    validationError('Repository ref is not a valid branch, tag or commit', 'invalid_ref');
  }
  return raw;
}

function validateCheckoutPath(raw: string): string {
  if (raw.length === 0 || raw.length > 512) {
    validationError('Checkout path is missing or too long', 'invalid_checkout_path');
  }
  if (raw.startsWith('/') || raw.includes('\\')) {
    validationError('Checkout path must be workspace-relative', 'invalid_checkout_path');
  }
  const segments = raw.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      validationError('Checkout path must not traverse outside the workspace', 'invalid_checkout_path');
    }
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(raw)) {
    validationError('Checkout path contains unsupported characters', 'invalid_checkout_path');
  }
  return raw;
}

function mapRepositoryRow(row: RepositorySqlRow): RepositoryRecord {
  let policy: CheckoutPolicy = { shallow: false, submodules: false };
  try {
    const parsed = JSON.parse(row.checkout_policy) as Partial<CheckoutPolicy>;
    policy = { shallow: parsed.shallow === true, submodules: parsed.submodules === true };
  } catch {
    // Unparseable stored policy falls back to the documented default.
  }
  return {
    projectId: row.project_id,
    url: row.url,
    ref: row.ref,
    commit: row.commit_sha,
    dirty: row.dirty === 1,
    contentHash: row.content_hash,
    checkoutPath: row.checkout_path,
    checkoutPolicy: policy,
    connectedBy: row.connected_by,
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
  };
}

/** Connect or replace the project repository, resolving local state when available. */
export async function connectRepository(
  db: DatabaseSync,
  projectId: string,
  principalId: string,
  input: RepositoryInput,
  approvedSnapshotRoots: string[],
): Promise<RepositoryRecord> {
  const prepared = await prepareRepositoryConnection(input, approvedSnapshotRoots);
  return withTransaction(db, () => writeRepositoryRecord(db, projectId, principalId, prepared));
}

/**
 * Validate the input and resolve the local snapshot (read-only git access
 * under an operator-approved snapshot root). Runs OUTSIDE any transaction so
 * handlers can wrap the write with events and idempotency records
 * afterwards.
 */
export async function prepareRepositoryConnection(
  input: RepositoryInput,
  approvedSnapshotRoots: string[],
): Promise<{
  validated: { url: string; ref: string; checkoutPath: string; checkoutPolicy: CheckoutPolicy };
  snapshot: LocalSnapshot | null;
}> {
  // Validation (including credential rejection) runs before anything else,
  // so rejected URLs never reach snapshot resolution, persistence, events
  // or error envelopes.
  const validated = validateRepositoryInput(input);
  const snapshot = await resolveLocalSnapshot(validated.url, validated.ref, approvedSnapshotRoots);
  return { validated, snapshot };
}

/** The resolved local snapshot for a prepared connection (exported type alias). */
export type LocalSnapshot = Awaited<ReturnType<typeof resolveLocalSnapshot>>;

/**
 * Write the connection row inside the caller's transaction. Returns the
 * freshly read record.
 */
export function writeRepositoryRecord(
  db: DatabaseSync,
  projectId: string,
  principalId: string,
  prepared: {
    validated: { url: string; ref: string; checkoutPath: string; checkoutPolicy: CheckoutPolicy };
    snapshot: LocalSnapshot | null;
  },
): RepositoryRecord {
  const { validated, snapshot } = prepared;
  const now = Date.now();
  db.prepare(
    `INSERT INTO project_repositories
       (project_id, url, ref, commit_sha, dirty, content_hash, checkout_path, checkout_policy, connected_by, connected_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       url = excluded.url,
       ref = excluded.ref,
       commit_sha = excluded.commit_sha,
       dirty = excluded.dirty,
       content_hash = excluded.content_hash,
       checkout_path = excluded.checkout_path,
       checkout_policy = excluded.checkout_policy,
       connected_by = excluded.connected_by,
       connected_at = excluded.connected_at,
       updated_at = excluded.updated_at`,
  ).run(
    projectId,
    validated.url,
    validated.ref,
    snapshot?.commit ?? '',
    snapshot?.dirty === true ? 1 : 0,
    snapshot?.contentHash ?? '',
    validated.checkoutPath,
    JSON.stringify(validated.checkoutPolicy),
    principalId,
    now,
    now,
  );
  const row = mapRow<RepositorySqlRow>(
    db.prepare('SELECT * FROM project_repositories WHERE project_id = ?').get(projectId),
  );
  if (row === undefined) throw Errors.internal('Repository record disappeared during write');
  return mapRepositoryRow(row);
}

export function getRepositoryRecord(db: DatabaseSync, projectId: string): RepositoryRecord | null {
  const row = mapRow<RepositorySqlRow>(
    db.prepare('SELECT * FROM project_repositories WHERE project_id = ?').get(projectId),
  );
  return row === undefined ? null : mapRepositoryRow(row);
}

export function disconnectRepository(db: DatabaseSync, projectId: string): void {
  db.prepare('DELETE FROM project_repositories WHERE project_id = ?').run(projectId);
}
