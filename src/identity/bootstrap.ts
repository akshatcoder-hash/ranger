import { closeSync, chmodSync, existsSync, fstatSync, openSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { generateSecret } from '../auth/hashing.js';
import { createCredentialFromSecret, createPrincipal, findFirstCredential } from '../auth/principals.js';

/**
 * Self-hosted bootstrap identity.
 *
 * Creates the initial principal plus one bootstrap credential. The secret is
 * written exactly once to a file OUTSIDE the repository, created with mode
 * 0600, and never logged or echoed — the database stores only the hash and
 * the lookup key. Re-running is idempotent: an existing bootstrap credential
 * is reported, not replaced.
 */

export const BOOTSTRAP_CREDENTIAL_FILENAME = 'bootstrap-credential.txt';

export interface BootstrapOutcome {
  principalId: string;
  credentialPath: string;
  /** True when this call created the principal + credential. */
  created: boolean;
}

export function defaultBootstrapCredentialPath(dataDir: string): string {
  return path.join(dataDir, BOOTSTRAP_CREDENTIAL_FILENAME);
}

function assertOutsideRepo(credentialPath: string, repoRoot: string): void {
  const resolved = path.resolve(credentialPath);
  const root = path.resolve(repoRoot);
  const relative = path.relative(root, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('Bootstrap credential file must be created outside the repository tree');
  }
}

function writeCredentialFile(credentialPath: string, secret: string): void {
  // 'wx' fails when the path already exists; mode 0600 (umask-independent via chmod).
  const fd = openSync(credentialPath, 'wx', 0o600);
  try {
    writeSync(fd, `RANGER_BOOTSTRAP_TOKEN=${secret}\n`);
    const stats = fstatSync(fd);
    if ((stats.mode & 0o077) !== 0) {
      chmodSync(credentialPath, 0o600);
    }
  } finally {
    closeSync(fd);
  }
  // Defense in depth for filesystems/umasks that ignore open(2) modes.
  if ((statSync(credentialPath).mode & 0o777) !== 0o600) {
    chmodSync(credentialPath, 0o600);
  }
}

/**
 * Ensure the initial principal + bootstrap credential exist.
 *
 * Guard order matters: the credential path is validated against the
 * repository root BEFORE any existence check, so an unsafe request fails
 * even when a bootstrap credential already exists.
 */
export function ensureInitialPrincipal(
  db: DatabaseSync,
  opts: { dataDir: string; repoRoot: string; displayName: string; credentialPath?: string },
): BootstrapOutcome {
  const credentialPath = opts.credentialPath ?? defaultBootstrapCredentialPath(opts.dataDir);
  assertOutsideRepo(credentialPath, opts.repoRoot);

  const existing = findFirstCredential(db, 'bootstrap');
  if (existing !== null) {
    return { principalId: existing.principalId, credentialPath, created: false };
  }

  const principal = createPrincipal(db, opts.displayName);
  const material = generateSecret('rng');
  createCredentialFromSecret(db, principal.id, 'bootstrap', 'bootstrap', material.secret);
  writeCredentialFile(credentialPath, material.secret);
  return { principalId: principal.id, credentialPath, created: true };
}

/**
 * Create one additional principal with its own credential file (used for
 * multi-principal validation drivers). Always creates; fails when the file
 * already exists or lies inside the repository.
 */
export function createAdditionalPrincipal(
  db: DatabaseSync,
  opts: { repoRoot: string; displayName: string; credentialPath: string },
): BootstrapOutcome {
  assertOutsideRepo(opts.credentialPath, opts.repoRoot);
  if (existsSync(opts.credentialPath)) {
    throw new Error('Credential file already exists; choose a fresh path for an additional principal');
  }
  const principal = createPrincipal(db, opts.displayName);
  const material = generateSecret('rng');
  createCredentialFromSecret(db, principal.id, 'api_token', opts.displayName, material.secret);
  writeCredentialFile(opts.credentialPath, material.secret);
  return { principalId: principal.id, credentialPath: opts.credentialPath, created: true };
}
