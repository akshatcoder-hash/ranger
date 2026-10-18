import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/db/db.js';
import { appliedMigrations, migrationsDirFromCwd, runMigrations } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { SecretResolver } from '../src/secrets.js';
import { createAdditionalPrincipal, ensureInitialPrincipal } from '../src/identity/bootstrap.js';
import { resolveRepoRoot } from '../src/identity/repo-root.js';

/**
 * Self-hosted bootstrap CLI.
 *
 * Always: prepares the data directory (migrations), verifies the environment
 * and reports configuration status — without printing any secret values.
 *
 * With `--create-principal [displayName]` (default display name "Operator"):
 * creates the initial principal and its bootstrap credential — a mode-0600
 * secret file OUTSIDE the repository containing the bearer token. Only the
 * credential hash and lookup key reach the database, and the secret is never
 * echoed to stdout or logs; the output names the file only. Idempotent.
 *
 * With `--additional-principal <displayName> --credential-file <path>`:
 * creates one further principal with its own 0600 credential file (for
 * multi-principal drivers/validators).
 */

const config = await loadConfig(process.env);
accessSync(config.dataDir, constants.W_OK);
const db = openDatabase(config.dataDir);
runMigrations(db, migrationsDirFromCwd());
const migrations = appliedMigrations(db);

const secrets = new SecretResolver(config.secretFile);
const secretNames = secrets.presentNames();

// Compiled entry lives at dist/scripts; one parent is dist, not the repo.
// Walk to package.json so source (`scripts/`) and built contexts agree.
const repoRoot = resolveRepoRoot(import.meta.dirname);
const credentialFileArg = process.argv.indexOf('--credential-file');
const credentialFile =
  credentialFileArg >= 0 ? process.argv[credentialFileArg + 1] : undefined;

function reportPrincipal(outcome: { principalId: string; credentialPath: string; created: boolean }, displayName: string, label: string): void {
  process.stdout.write(
    [
      'bootstrap:',
      `  principal: ${outcome.principalId} (display name "${displayName}", ${label})`,
      outcome.created
        ? `  credential file: created at ${outcome.credentialPath} (mode 0600; secret not displayed)`
        : `  credential file: already exists at ${outcome.credentialPath} (unchanged)`,
    ].join('\n') + '\n',
  );
}

const createPrincipalArg = process.argv.indexOf('--create-principal');
const additionalPrincipalArg = process.argv.indexOf('--additional-principal');
if (createPrincipalArg >= 0 || additionalPrincipalArg >= 0) {
  const isAdditional = additionalPrincipalArg >= 0;
  const nameArg = (isAdditional ? additionalPrincipalArg : createPrincipalArg) + 1;
  const displayNameArg = process.argv[nameArg];
  const displayName =
    displayNameArg !== undefined && !displayNameArg.startsWith('--') && displayNameArg !== ''
      ? displayNameArg
      : 'Operator';
  if (isAdditional) {
    if (credentialFile === undefined) {
      process.stderr.write('bootstrap: --additional-principal requires --credential-file <path>\n');
      process.exit(1);
    }
    const outcome = createAdditionalPrincipal(db, {
      repoRoot,
      displayName,
      credentialPath: path.resolve(credentialFile),
    });
    reportPrincipal(outcome, displayName, 'additional');
  } else {
    const outcome = ensureInitialPrincipal(db, {
      dataDir: config.dataDir,
      // Credentials must never land inside the repository tree.
      repoRoot,
      displayName,
    });
    reportPrincipal(outcome, displayName, 'initial');
  }
} else {
  process.stdout.write(
    [
      'bootstrap:',
      `  data dir: ${config.dataDir} (writable)`,
      `  migrations applied: ${migrations.length}`,
      `  secret file configured: ${config.secretFile !== null}`,
      `  provider keys present: ${secretNames.length > 0 ? secretNames.join(', ') : 'none'}`,
      `  live budget ledger configured: ${config.liveBudgetFile !== null}`,
      `  contract version: v1`,
      'next: run with --create-principal [displayName] to create the initial principal and credential',
      '      (or --additional-principal <displayName> --credential-file <path> for further principals)',
    ].join('\n') + '\n',
  );
}
db.close();
