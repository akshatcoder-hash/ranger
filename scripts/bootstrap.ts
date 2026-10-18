import { accessSync, constants } from 'node:fs';
import { openDatabase } from '../src/db/db.js';
import { appliedMigrations, migrationsDirFromCwd, runMigrations } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { SecretResolver } from '../src/secrets.js';

/**
 * Self-hosted bootstrap CLI.
 *
 * Foundation scope: prepare the data directory (migrations), verify the
 * environment is sound, and report configuration status — without printing
 * any secret values. The identity milestone extends this CLI to create the
 * initial principal and its secret credential file (mode 0600, outside the
 * repo, never logged).
 */

const config = await loadConfig(process.env);
accessSync(config.dataDir, constants.W_OK);
const db = openDatabase(config.dataDir);
runMigrations(db, migrationsDirFromCwd());
const migrations = appliedMigrations(db);

const secrets = new SecretResolver(config.secretFile);
const secretNames = secrets.presentNames();

process.stdout.write(
  [
    'bootstrap:',
    `  data dir: ${config.dataDir} (writable)`,
    `  migrations applied: ${migrations.length}`,
    `  secret file configured: ${config.secretFile !== null}`,
    `  provider keys present: ${secretNames.length > 0 ? secretNames.join(', ') : 'none'}`,
    `  live budget ledger configured: ${config.liveBudgetFile !== null}`,
    `  contract version: v1`,
    'next: the identity milestone extends this CLI with initial principal creation',
  ].join('\n') + '\n',
);
db.close();
