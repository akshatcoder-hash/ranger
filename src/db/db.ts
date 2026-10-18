import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * SQLite (node:sqlite) access for Ranger.
 *
 * Durability contract: WAL journal, foreign keys ON, busy timeout for
 * API/worker write serialization. The database file lives in RANGER_DATA_DIR
 * and survives process restarts.
 */

export const DATABASE_FILENAME = 'ranger.db';

export interface OpenDatabaseOptions {
  busyTimeoutMs?: number;
}

export function openDatabase(dataDir: string, opts: OpenDatabaseOptions = {}): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, DATABASE_FILENAME);
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`PRAGMA foreign_keys = ON;`);
  db.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? 5000};`);
  db.exec(`PRAGMA synchronous = NORMAL;`);
  return db;
}

/** Run `fn` inside an IMMEDIATE transaction; rolls back on throw. */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (cause) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // rollback of an already-closed transaction is a no-op
    }
    throw cause;
  }
}

/**
 * node:sqlite returns rows as `Record<string, SQLOutputValue>`; feature
 * modules map them onto explicit row interfaces. The cast must pass through
 * `unknown` (a direct cast from the index-signature type fails structural
 * overlap for multi-property rows).
 */
export function mapRow<T>(row: unknown): T | undefined {
  return row as T | undefined;
}

export function mapRows<T>(rows: unknown): T[] {
  return rows as T[];
}
