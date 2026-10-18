import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, withTransaction } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { PlanningService, type ParsedPlan } from '../../src/planning/service.js';
import { loadConfig, type RangerConfig } from '../../src/config.js';
import { prepareRepositoryConnection, writeRepositoryRecord, getRepositoryRecord } from '../../src/repositories/store.js';
import { createFixtureRepo } from '../helpers/fixture-repo.js';

/**
 * Planning persistence semantics (deterministic, no model):
 * - identical generated content is a NON-material revision: the current plan
 *   version and its approval stay valid (no supersede, no invalidation);
 * - a material change creates the next version and names impacted files and
 *   tests;
 * - the plan version carries the connected repository commit as its
 *   reference.
 */

const tempDirs: string[] = [];
let db: DatabaseSync;
let config: RangerConfig;
let projectId: string;
let ownerPrincipalId: string;
let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-planning-'));
  tempDirs.push(dataDir);
  db = openDatabase(dataDir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  config = await loadConfig({ RANGER_DATA_DIR: dataDir, RANGER_LOG_LEVEL: 'error' } as NodeJS.ProcessEnv);
  const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Planning Owner' });
  projectId = createProjectRecord(db, { name: 'Planning', engineerDisplayName: 'Ranger', principalId: owner.principalId }).id;
  ownerPrincipalId = owner.principalId;
});

afterEach(() => {
  db.close();
  const dir = tempDirs.pop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

const PARSED: ParsedPlan = {
  items: ['Wire the ticket lookup'],
  acceptanceCriteria: ['A lookup hits the order service'],
  permittedScope: ['edit:src/', 'command'],
  decisions: ['Prefer the existing order client'],
  impactedPaths: [],
  impactedTests: [],
};

describe('planning persistence', () => {
  it('reuses the current version when generated content is identical (wording-only change)', () => {
    const service = new PlanningService(db, config);
    const first = withTransaction(db, () => service.persistPlan(projectId, PARSED, 'req-1', null));
    expect(first.plan.version).toBe(1);
    expect(first.invalidatedApprovals).toEqual([]);

    const second = withTransaction(db, () => service.persistPlan(projectId, { ...PARSED, impactedPaths: [] }, 'req-2', null));
    expect(second.plan.id).toBe(first.plan.id);
    expect(second.plan.version).toBe(1);
    expect(second.invalidatedApprovals).toEqual([]);
  });

  it('creates the next version with the repository commit for a material change', async () => {
    // A real local fixture repository resolves a real commit at connect time.
    const fixture = createFixtureRepo(dataDir, 'planning-fixture');
    const prepared = await prepareRepositoryConnection({ url: fixture.fileUrl, ref: 'main' }, [fixture.root]);
    withTransaction(db, () => writeRepositoryRecord(db, projectId, ownerPrincipalId, prepared));
    const connectedCommit = getRepositoryRecord(db, projectId)!.commit;
    expect(connectedCommit).not.toBe('');
    const service = new PlanningService(db, config);
    const first = withTransaction(db, () => service.persistPlan(projectId, PARSED, 'req-1', null));
    expect(first.plan.repositoryCommit).toBe(connectedCommit);

    const revised = withTransaction(db, () =>
      service.persistPlan(
        projectId,
        {
          ...PARSED,
          items: ['Change the reply template'],
          impactedPaths: ['src/reply.ts'],
          impactedTests: ['tests/reply.test.ts'],
        },
        'req-2',
        null,
      ),
    );
    expect(revised.plan.version).toBe(2);
    expect(revised.plan.repositoryCommit).toBe(connectedCommit);
    expect(revised.invalidatedApprovals).toEqual([]);
  });
});
