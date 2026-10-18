import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/db.js';
import { appliedMigrations, migrationsDirFromCwd, runMigrations } from '../../src/db/migrate.js';

function repoMigrationsDir(): string {
  // Tests run with cwd at the repository root.
  return path.join(process.cwd(), 'migrations');
}

describe('migration runner', () => {
  it('applies migrations to a fresh data directory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-migrate-'));
    const db = openDatabase(dir);
    const applied = runMigrations(db, repoMigrationsDir());
    expect(applied.length).toBeGreaterThanOrEqual(1);
    expect(appliedMigrations(db).map((m) => m.name)).toContain('0001_foundation.sql');
    // Jobs table exists after the foundation migration.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('jobs');
    expect(tables.map((t) => t.name)).toContain('schema_migrations');
    db.close();
  });

  it('is idempotent: rerunning applies nothing new', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-migrate-'));
    const db = openDatabase(dir);
    const first = runMigrations(db, repoMigrationsDir());
    const second = runMigrations(db, repoMigrationsDir());
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(second).toHaveLength(0);
    db.close();
  });

  it('preserves data across restart (fresh process opens the same file)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-migrate-'));
    const first = openDatabase(dir);
    runMigrations(first, repoMigrationsDir());
    first
      .prepare(
        "INSERT INTO jobs (id, type, payload, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
      )
      .run('job_restart_check', 'probe', Date.now(), Date.now());
    first.close();

    // "Restart": a brand-new DatabaseSync on the same file (simulated by a new
    // open in this process; the entrypoint integration test covers a real
    // process restart).
    const second = openDatabase(dir);
    const row = second
      .prepare('SELECT id, type FROM jobs WHERE id = ?')
      .get('job_restart_check') as { id: string; type: string } | undefined;
    expect(row).toEqual({ id: 'job_restart_check', type: 'probe' });
    second.close();
  });

  it('runs in WAL mode with foreign keys enforced', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-migrate-'));
    const db = openDatabase(dir);
    const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode.toLowerCase()).toBe('wal');
    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
    db.close();
  });

  it('resolves the repo migrations directory from cwd', () => {
    expect(migrationsDirFromCwd()).toBe(path.resolve(process.cwd(), 'migrations'));
  });
});
