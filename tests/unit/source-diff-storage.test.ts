import { mkdtempSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { workspaceDiff } from '../../src/workspace/diff.js';
import { listAllSourceFiles, listSourceBases, saveSourceFile } from '../../src/workspace/store.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A migrated database with one project row, so source files can be saved. */
function database(): { db: DatabaseSync; projectId: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ranger-source-diff-'));
  dirs.push(dir);
  const db = openDatabase(dir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const projectId = 'prj_11111111-1111-1111-1111-111111111111';
  const principalId = 'prin_11111111-1111-1111-1111-111111111111';
  db.prepare('INSERT INTO principals (id, display_name, created_at) VALUES (?, ?, ?)').run(principalId, 'Tester', Date.now());
  db.prepare('INSERT INTO projects (id, name, engineer_display_name, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(projectId, 'P', 'Ranger', principalId, Date.now());
  return { db, projectId };
}

const diffFor = (db: DatabaseSync, projectId: string) =>
  workspaceDiff(listAllSourceFiles(db, projectId), listSourceBases(db, projectId));

describe('saved source diff', () => {
  it('shows a seeded file as unchanged until it is edited, then as a hunk', () => {
    const { db, projectId } = database();
    saveSourceFile(db, projectId, 'src/a.ts', Buffer.from('one\ntwo\n'), 'initial_checkout');
    expect(diffFor(db, projectId)).toEqual({ diff: '', changedFiles: [] });

    saveSourceFile(db, projectId, 'src/a.ts', Buffer.from('one\nTWO\n'));
    const result = diffFor(db, projectId);
    expect(result.changedFiles).toEqual(['src/a.ts']);
    expect(result.diff).toContain('-two');
    expect(result.diff).toContain('+TWO');
  });

  it('keeps a created file visible as a full addition when it is saved again', () => {
    const { db, projectId } = database();
    saveSourceFile(db, projectId, 'src/new.ts', Buffer.from('export const a = 1;\n'));
    saveSourceFile(db, projectId, 'src/new.ts', Buffer.from('export const a = 2;\n'));

    const result = diffFor(db, projectId);
    expect(result.changedFiles).toEqual(['src/new.ts']);
    expect(result.diff).toContain('+export const a = 2;');
    // The baseline is the empty file, so the content reads as an addition.
    expect(result.diff).toContain('@@ -0,0 +1,1 @@');
  });
});
