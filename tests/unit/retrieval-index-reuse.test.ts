import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TraceIndexModule from '../../src/retrieval/trace-index.js';
import type * as TracePinModule from '../../src/retrieval/trace-pin.js';
import type * as TraceMcpModule from '../../src/retrieval/trace-mcp.js';

const fakes = vi.hoisted(() => ({
  builds: 0,
  buildRoots: [] as string[],
  snapshots: new Map<string, string>(),
  failInitialize: false,
  reportedSnapshot: null as string | null,
  spawned: 0,
  closed: 0,
  failSearch: false,
}));

vi.mock('../../src/retrieval/trace-index.js', async (original) => ({
  ...(await original<typeof TraceIndexModule>()),
  indexMirror: async (options: { mirrorRoot: string }) => {
    fakes.builds += 1;
    fakes.buildRoots.push(options.mirrorRoot);
    const snapshotId = `snapshot-${fakes.builds}`;
    fakes.snapshots.set(options.mirrorRoot, snapshotId);
    return {
      snapshotId,
      commit: null,
      branch: 'main',
      dirty: false,
      indexedAt: `2026-01-0${fakes.builds}T00:00:00.000Z`,
      embeddingModel: 'fake-model',
      embeddedChunks: 2,
      filesIndexed: 2,
    };
  },
}));

vi.mock('../../src/retrieval/trace-pin.js', async (original) => ({
  ...(await original<typeof TracePinModule>()),
  verifyTracePin: async () => ({ commit: 'pinned', cliPath: 'cli' }),
}));

vi.mock('../../src/retrieval/trace-mcp.js', async (original) => ({
  ...(await original<typeof TraceMcpModule>()),
  TraceMcpClient: {
    spawn: (options: { mirrorRoot: string }) => {
      fakes.spawned += 1;
      return {
        initialize: async () => {
          if (fakes.failInitialize) throw new Error('no usable index');
        },
        callTool: async () => {
          if (fakes.failSearch) throw new Error('search failed');
          return ({
          isError: false,
          data: {
            revision: { snapshotId: fakes.reportedSnapshot ?? fakes.snapshots.get(options.mirrorRoot) },
            vectorSearch: { available: true },
          },
          });
        },
        close: async () => {
          fakes.closed += 1;
        },
        diagnostics: () => '',
      };
    },
  },
}));

import { loadConfig, type RangerConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPrincipal } from '../../src/auth/principals.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { saveSourceFile } from '../../src/workspace/store.js';
import { mirrorRootFor } from '../../src/retrieval/mirror.js';
import { readIndexState, writeIndexState } from '../../src/retrieval/index-state.js';
import { RetrievalService } from '../../src/retrieval/service.js';

/**
 * Same-project index reuse with the Trace runtime replaced by a recorder:
 * these tests prove WHEN the service skips, rebuilds or refuses, not Trace
 * itself (the real-Trace tier lives in the integration suite).
 */

const directories: string[] = [];
const databases: DatabaseSync[] = [];

beforeEach(() => {
  fakes.builds = 0;
  fakes.buildRoots.length = 0;
  fakes.snapshots.clear();
  fakes.failInitialize = false;
  fakes.reportedSnapshot = null;
  fakes.spawned = 0;
  fakes.closed = 0;
  fakes.failSearch = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-index-reuse-'));
  directories.push(dataDir);
  const config: RangerConfig = await loadConfig({ RANGER_DATA_DIR: dataDir, RANGER_LOG_LEVEL: 'error' });
  const db = openDatabase(dataDir);
  databases.push(db);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const principal = createPrincipal(db, 'Reuse fixture');
  const project = createProjectRecord(db, { name: 'Reuse', engineerDisplayName: 'Ranger', principalId: principal.id });
  const other = createProjectRecord(db, { name: 'Other', engineerDisplayName: 'Ranger', principalId: principal.id });
  for (const id of [project.id, other.id]) {
    saveSourceFile(db, id, 'src/a.ts', Buffer.from('export const a = 1;\n'));
    saveSourceFile(db, id, 'src/b.ts', Buffer.from('export const b = 2;\n'));
  }
  return {
    config,
    db,
    dataDir,
    projectId: project.id,
    otherProjectId: other.id,
    service: () => new RetrievalService({ db, config }),
  };
}

describe('same-project index reuse', () => {
  it('records actual search duration and zero matches without storing the query', async () => {
    const f = await fixture();
    const service = f.service();
    await service.reindex(f.projectId);
    vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(118.4);
    const response = await service.search(f.projectId, 'private customer question', 5);
    expect(response.results).toEqual([]);
    const rows = f.db.prepare("SELECT data FROM project_events WHERE project_id = ? AND type = 'retrieval.search.completed'").all(f.projectId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]!.data))).toEqual({ provider: 'trace', durationMs: 18.4, resultCount: 0 });
    expect(JSON.stringify(rows)).not.toContain('private customer question');
  });

  it('labels fallback measurements and emits no successful measurement on failure', async () => {
    const f = await fixture();
    saveSourceFile(f.db, f.projectId, 'notes.md', Buffer.from('specialneedle customer notes\n'));
    const service = f.service();
    await service.reindex(f.projectId);
    const response = await service.search(f.projectId, 'specialneedle', 5);
    expect(response.provider).toBe('file-search-fallback');
    const row = f.db.prepare("SELECT data FROM project_events WHERE project_id = ? AND type = 'retrieval.search.completed'").get(f.projectId);
    expect(JSON.parse(String(row!.data))).toMatchObject({ provider: 'file-search-fallback', resultCount: 1 });
    fakes.failSearch = true;
    await expect(service.search(f.projectId, 'specialneedle', 5)).rejects.toThrow();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE project_id = ? AND type = 'retrieval.search.completed'").get(f.projectId)?.n).toBe(1);
  });

  it('does not fail a completed search when the measurement cannot be persisted', async () => {
    const f = await fixture();
    const service = f.service();
    await service.reindex(f.projectId);
    f.db.exec(`CREATE TRIGGER fail_search_metric BEFORE INSERT ON project_events
      WHEN NEW.type = 'retrieval.search.completed' BEGIN SELECT RAISE(ABORT, 'metric unavailable'); END;`);
    await expect(service.search(f.projectId, 'a question', 5)).resolves.toMatchObject({ provider: 'trace', results: [] });
    expect(f.db.isTransaction).toBe(false);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE type = 'retrieval.search.completed'").get()?.n).toBe(0);
  });

  it('rebuilds by default and records the indexer that built the index', async () => {
    const f = await fixture();
    const first = await f.service().reindexDetailed(f.projectId, { provenance: { jobId: 'job_1' } });
    const second = await f.service().reindexDetailed(f.projectId, { provenance: { jobId: 'job_2' } });
    expect(fakes.builds).toBe(2);
    expect(first.indexerVersion).toBe(f.config.providers.tracePinnedCommit);
    expect(second.reused).toBeUndefined();
    expect(second.snapshotId).toBe('snapshot-2');
  });

  it('skips indexing for unchanged source, opens the real index, and rebinds provenance only', async () => {
    const f = await fixture();
    await f.service().reindexDetailed(f.projectId, { provenance: { repositoryCommit: 'c1', jobId: 'job_1', machineId: 'vm_old' } });
    const built = readIndexState(f.dataDir, f.projectId)!;
    // A recorded build time far from any real load time proves the returned value is the current one.
    writeIndexState(f.dataDir, { ...built, indexElapsedMs: 987_654 });
    const spawnedBefore = fakes.spawned;

    // A fresh service stands in for the worker process after a restart or a new VM.
    const reused = await f.service().reindexDetailed(f.projectId, {
      provenance: { repositoryCommit: 'c1', jobId: 'job_2', machineId: 'vm_new' },
      reuseReady: true,
    });

    expect(fakes.builds).toBe(1);
    expect(fakes.spawned).toBe(spawnedBefore + 1);
    expect(reused.reused).toBe(true);
    expect(reused.indexElapsedMs).toBeLessThan(60_000);
    expect(reused.snapshotId).toBe(built.snapshotId);
    expect(reused.indexedAt).toBe(built.indexedAt);
    expect(reused.provenance).toEqual({ repositoryCommit: 'c1', jobId: 'job_2', machineId: 'vm_new' });

    const persisted = readIndexState(f.dataDir, f.projectId)!;
    expect(persisted).toMatchObject({
      snapshotId: built.snapshotId,
      indexedAt: built.indexedAt,
      indexElapsedMs: 987_654,
      sourceFingerprint: built.sourceFingerprint,
      mirrorHead: built.mirrorHead,
    });
    expect(persisted.provenance).toEqual({ repositoryCommit: 'c1', jobId: 'job_2', machineId: 'vm_new' });
    expect(f.service().readiness(f.projectId).ready).toBe(true);
  });

  it('rebuilds when the saved source changed', async () => {
    const f = await fixture();
    await f.service().reindexDetailed(f.projectId, { provenance: { jobId: 'job_1' } });
    saveSourceFile(f.db, f.projectId, 'src/a.ts', Buffer.from('export const a = 99;\n'));
    const result = await f.service().reindexDetailed(f.projectId, { provenance: { jobId: 'job_2' }, reuseReady: true });
    expect(fakes.builds).toBe(2);
    expect(result.reused).toBeUndefined();
    expect(result.snapshotId).toBe('snapshot-2');
    expect(result.provenance).toEqual({ jobId: 'job_2' });
  });

  it('rebuilds when the recorded indexer is missing or differs from the pinned one', async () => {
    const f = await fixture();
    await f.service().reindexDetailed(f.projectId, { provenance: { jobId: 'job_1' } });
    const built = readIndexState(f.dataDir, f.projectId)!;

    writeIndexState(f.dataDir, { ...built, indexerVersion: 'some-other-trace-commit' });
    await f.service().reindexDetailed(f.projectId, { reuseReady: true });
    expect(fakes.builds).toBe(2);

    const { indexerVersion: _omitted, ...legacy } = readIndexState(f.dataDir, f.projectId)!;
    void _omitted;
    writeIndexState(f.dataDir, legacy);
    await f.service().reindexDetailed(f.projectId, { reuseReady: true });
    expect(fakes.builds).toBe(3);
    expect(readIndexState(f.dataDir, f.projectId)!.indexerVersion).toBe(f.config.providers.tracePinnedCommit);
  });

  it('rebuilds when Trace cannot open the index or reports a different snapshot', async () => {
    const f = await fixture();
    await f.service().reindexDetailed(f.projectId, { provenance: { jobId: 'job_1' } });

    fakes.failInitialize = true;
    const closedBefore = fakes.closed;
    // The rebuild's own runtime also fails to start, so the failure is surfaced, not hidden.
    await expect(f.service().reindexDetailed(f.projectId, { reuseReady: true })).rejects.toThrow('no usable index');
    expect(fakes.closed).toBeGreaterThan(closedBefore);
    expect(fakes.builds).toBe(2);
    fakes.failInitialize = false;

    fakes.reportedSnapshot = 'someone-elses-snapshot';
    const result = await f.service().reindexDetailed(f.projectId, { reuseReady: true });
    expect(fakes.builds).toBe(3);
    expect(result.reused).toBeUndefined();
  });

  it('rebuilds when the index is absent from the Trace store', async () => {
    const f = await fixture();
    await f.service().reindexDetailed(f.projectId, { provenance: { jobId: 'job_1' } });
    fakes.snapshots.clear();
    const result = await f.service().reindexDetailed(f.projectId, { reuseReady: true });
    expect(fakes.builds).toBe(2);
    expect(result.reused).toBeUndefined();
  });

  it('rebuilds when the mirror drifted from the recorded head', async () => {
    const f = await fixture();
    await f.service().reindexDetailed(f.projectId, { provenance: { jobId: 'job_1' } });
    const built = readIndexState(f.dataDir, f.projectId)!;
    writeIndexState(f.dataDir, { ...built, mirrorHead: '0'.repeat(40) });
    await f.service().reindexDetailed(f.projectId, { reuseReady: true });
    expect(fakes.builds).toBe(2);
  });

  it('never reuses another project index', async () => {
    const f = await fixture();
    await f.service().reindexDetailed(f.projectId, { provenance: { jobId: 'job_1' } });
    const result = await f.service().reindexDetailed(f.otherProjectId, { provenance: { jobId: 'job_2' }, reuseReady: true });
    expect(result.reused).toBeUndefined();
    expect(fakes.builds).toBe(2);
    expect(fakes.buildRoots).toEqual([
      mirrorRootFor(f.dataDir, f.projectId),
      mirrorRootFor(f.dataDir, f.otherProjectId),
    ]);
    expect(readIndexState(f.dataDir, f.projectId)!.provenance).toEqual({ jobId: 'job_1' });
  });
});
