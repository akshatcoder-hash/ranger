import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPrincipal } from '../../src/auth/principals.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { saveSourceFile } from '../../src/workspace/store.js';
import { readIndexState } from '../../src/retrieval/index-state.js';
import { RetrievalService } from '../../src/retrieval/service.js';

/**
 * Real pinned Trace: a second service (a new worker process) adopts the
 * project's own on-disk index without indexing, serves cited results from
 * it, and rebuilds once the saved source changes.
 */

const LONG = 300_000;
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function indexDirFor(mirrorRoot: string, traceHome: string): string {
  const label = path.basename(mirrorRoot).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'repo';
  const key = createHash('sha256').update(path.resolve(mirrorRoot)).digest('hex').slice(0, 12);
  return path.join(traceHome, 'indexes', `${label}-${key}`);
}

describe('real Trace same-project index reuse', () => {
  it('adopts the existing index, serves from it, and rebuilds after a source change', { timeout: LONG }, async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-trace-reuse-'));
    dirs.push(dataDir);
    const config = await loadConfig({ RANGER_DATA_DIR: dataDir, RANGER_LOG_LEVEL: 'error' });
    const db = openDatabase(dataDir);
    runMigrations(db, path.join(process.cwd(), 'migrations'));
    const principal = createPrincipal(db, 'Reuse');
    const project = createProjectRecord(db, { name: 'Reuse', engineerDisplayName: 'Ranger', principalId: principal.id });
    dirs.push(indexDirFor(path.join(dataDir, 'retrieval-mirrors', project.id), config.providers.traceHome));
    saveSourceFile(db, project.id, 'src/calculator.ts', Buffer.from('export function addNumbers(a: number, b: number): number {\n  return a + b;\n}\n'));
    saveSourceFile(db, project.id, 'src/formatter.ts', Buffer.from('export class ResultFormatter {\n  format(value: number): string {\n    return `value=${value}`;\n  }\n}\n'));
    const services: RetrievalService[] = [];
    const svc = (): RetrievalService => {
      const created = new RetrievalService({ db, config });
      services.push(created);
      return created;
    };
    try {
      const built = await svc().reindexDetailed(project.id, { provenance: { jobId: 'job_1', machineId: 'vm_1' } });
      const warm = svc();
      const reused = await warm.reindexDetailed(project.id, { provenance: { jobId: 'job_2', machineId: 'vm_2' }, reuseReady: true });
      expect(reused.reused).toBe(true);
      expect(reused.snapshotId).toBe(built.snapshotId);
      expect(reused.indexedAt).toBe(built.indexedAt);
      expect(reused.indexElapsedMs).toBeLessThan(built.indexElapsedMs);
      expect(readIndexState(dataDir, project.id)!.provenance).toEqual({ jobId: 'job_2', machineId: 'vm_2' });
      expect(readIndexState(dataDir, project.id)!.indexElapsedMs).toBe(built.indexElapsedMs);

      const found = await warm.search(project.id, 'addNumbers', 3);
      expect(found.provider).toBe('trace');
      expect(found.results[0]!.filePath).toBe('src/calculator.ts');
      expect(found.results[0]!.verbatim).toBe(true);

      saveSourceFile(db, project.id, 'src/calculator.ts', Buffer.from('export function addNumbers(a: number, b: number): number {\n  return b + a;\n}\n'));
      const rebuilt = await svc().reindexDetailed(project.id, { provenance: { jobId: 'job_3', machineId: 'vm_3' }, reuseReady: true });
      expect(rebuilt.reused).toBeUndefined();
      expect(rebuilt.snapshotId).not.toBe(built.snapshotId);
    } finally {
      for (const service of services) await service.closeAll();
      db.close();
    }
  });
});
