import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPrincipal } from '../../src/auth/principals.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { saveSourceFile } from '../../src/workspace/store.js';
import { ProjectMirror, mirrorRootFor } from '../../src/retrieval/mirror.js';
import { writeIndexState } from '../../src/retrieval/index-state.js';
import { RetrievalService } from '../../src/retrieval/service.js';

/** Readiness-cache regressions only: synthetic index metadata, no model or provider calls. */
const directories: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-trace-readiness-'));
  directories.push(dataDir);
  const config = await loadConfig({ RANGER_DATA_DIR: dataDir, RANGER_LOG_LEVEL: 'error' });
  const db = openDatabase(dataDir);
  databases.push(db);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const principal = createPrincipal(db, 'Readiness fixture');
  const project = createProjectRecord(db, { name: 'Readiness', engineerDisplayName: 'Ranger', principalId: principal.id });
  saveSourceFile(db, project.id, 'src/earlier.ts', Buffer.from('export const value = 1;\n'));
  saveSourceFile(db, project.id, 'src/latest.ts', Buffer.from('export const other = 2;\n'));
  db.prepare("UPDATE workspace_source_files SET updated_at = CASE relative_path WHEN 'src/earlier.ts' THEN 100 ELSE 200 END WHERE project_id = ?").run(project.id);
  const mirror = new ProjectMirror(mirrorRootFor(dataDir, project.id));
  const synced = await mirror.sync(db, project.id);
  writeIndexState(dataDir, {
    version: 1, projectId: project.id, snapshotId: 'synthetic-index-snapshot',
    commit: synced.headCommit, branch: 'main', dirty: false,
    indexedAt: new Date().toISOString(), embeddingModel: 'synthetic-readiness-only',
    embeddedChunks: 0, filesIndexed: synced.fileCount, mirrorHead: synced.headCommit,
    sourceFingerprint: synced.sourceFingerprint, fileCount: synced.fileCount,
    byteCount: synced.byteCount, indexElapsedMs: 0, provenance: {},
  });
  return { dataDir, db, projectId: project.id, mirror, service: new RetrievalService({ db, config }) };
}

function changeEarlierFile(db: DatabaseSync, projectId: string): void {
  // Same byte length; updating this row still leaves MAX(updated_at) at 200.
  db.prepare("UPDATE workspace_source_files SET content = ?, updated_at = updated_at + 1 WHERE project_id = ? AND relative_path = 'src/earlier.ts'")
    .run(Buffer.from('export const value = 9;\n'), projectId);
}

describe('Trace readiness cache invalidation', () => {
  it('rejects same-length edits to an older row on its own database connection', async () => {
    const f = await fixture();
    expect(f.service.readiness(f.projectId).ready).toBe(true);
    changeEarlierFile(f.db, f.projectId);
    expect(f.service.readiness(f.projectId)).toMatchObject({ ready: false, reason: 'stale' });
  });

  it('rejects edits from another database connection even when aggregate source metadata is unchanged', async () => {
    const f = await fixture();
    expect(f.service.readiness(f.projectId).ready).toBe(true);
    const other = openDatabase(f.dataDir);
    databases.push(other);
    changeEarlierFile(other, f.projectId);
    expect(f.service.readiness(f.projectId)).toMatchObject({ ready: false, reason: 'stale' });
  });

  it('rejects a moved mirror HEAD even when saved source and cached metadata are unchanged', async () => {
    const f = await fixture();
    expect(f.service.readiness(f.projectId).ready).toBe(true);
    execFileSync('git', ['-c', 'user.name=Readiness', '-c', 'user.email=readiness@example.invalid',
      'commit', '--no-verify', '--allow-empty', '-m', 'Move mirror head'], {
      cwd: f.mirror.root, stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    expect(f.service.readiness(f.projectId)).toMatchObject({ ready: false, reason: 'mirror_mismatch' });
  });
});
