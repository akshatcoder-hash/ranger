import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * SQL migration runner.
 *
 * Migrations are plain .sql files in the repo `migrations/` directory, applied
 * in filename order exactly once, recorded in `schema_migrations`. Applying is
 * transactional per migration so a failed migration leaves no partial schema.
 */

export interface AppliedMigration {
  name: string;
  appliedAt: number;
}

const MIGRATIONS_TABLE =
  'CREATE TABLE IF NOT EXISTS schema_migrations (' +
  'name TEXT PRIMARY KEY,' +
  'applied_at INTEGER NOT NULL)';

export function listMigrationFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

/**
 * Apply pending migrations. Safe to run repeatedly (idempotent) and from
 * multiple processes thanks to the IMMEDIATE transaction per migration.
 */
export function runMigrations(db: DatabaseSync, migrationsDir: string): AppliedMigration[] {
  db.exec(MIGRATIONS_TABLE);
  const appliedNow: AppliedMigration[] = [];
  for (const name of listMigrationFiles(migrationsDir)) {
    const already = db
      .prepare('SELECT applied_at FROM schema_migrations WHERE name = ?')
      .get(name) as { applied_at: number } | undefined;
    if (already !== undefined) continue;

    const sql = readFileSync(path.join(migrationsDir, name), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      const appliedAt = Date.now();
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        name,
        appliedAt,
      );
      db.exec('COMMIT');
      appliedNow.push({ name, appliedAt });
    } catch (cause) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // no-op
      }
      throw new Error(`Migration ${name} failed: ${String(cause)}`);
    }
  }
  return appliedNow;
}

export function appliedMigrations(db: DatabaseSync): AppliedMigration[] {
  const rows = db
    .prepare('SELECT name, applied_at FROM schema_migrations ORDER BY name')
    .all() as Array<{ name: string; applied_at: number }>;
  return rows.map((row) => ({ name: row.name, appliedAt: row.applied_at }));
}

/**
 * Resolve the repo migrations directory. npm scripts and documented start
 * commands run from the repository root; walk up from cwd for safety.
 */
export function migrationsDirFromCwd(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, 'migrations');
    if (readdirSync(dir).includes('migrations') && listMigrationFiles(candidate).length > 0) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Migrations directory not found upward from cwd; run from the repository root');
}
