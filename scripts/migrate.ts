import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/db.js';
import { appliedMigrations, migrationsDirFromCwd, runMigrations } from '../src/db/migrate.js';

/**
 * Apply pending migrations to RANGER_DATA_DIR. Idempotent: running twice
 * changes nothing. Prints applied migration names (never secrets).
 */

const config = await loadConfig(process.env);
const db = openDatabase(config.dataDir);
const migrationsDir = migrationsDirFromCwd();
const appliedNow = runMigrations(db, migrationsDir);
const all = appliedMigrations(db);
process.stdout.write(
  `migrations: applied ${appliedNow.length} (${appliedNow.map((m) => m.name).join(', ') || 'none'}); ` +
    `${all.length} total applied to ${config.dataDir}\n`,
);
db.close();
