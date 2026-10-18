import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, withTransaction } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  approvePlanVersionRow,
  createPlanVersionRow,
  getApprovalRow,
  getPlanRow,
  latestPlanRow,
  listApprovalRows,
  listPlanRows,
} from '../../src/plans/store.js';
import { isProhibitedCommand, scopeCoversEdit, validateScopeEntries } from '../../src/plans/scope.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';

/**
 * Deterministic store tests for immutable plan versions, exact-version
 * approvals and the sandbox scope grammar. No provider, no model: this is
 * Ranger's own persistence and policy logic.
 */

const tempDirs: string[] = [];
let db: DatabaseSync;
let projectId: string;
let otherProjectId: string;

beforeEach(() => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-plans-'));
  tempDirs.push(dataDir);
  db = openDatabase(dataDir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Plans Owner' });
  projectId = createProjectRecord(db, { name: 'Plans', engineerDisplayName: 'Ranger', principalId: owner.principalId }).id;
  otherProjectId = createProjectRecord(db, { name: 'Other', engineerDisplayName: 'Ranger', principalId: owner.principalId }).id;
});

afterEach(() => {
  db.close();
  const dir = tempDirs.pop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

const BASE_INPUT = {
  items: ['Wire the order lookup to the inbox'],
  acceptanceCriteria: ['A ticket lookup hits the order service'],
  permittedScope: ['edit:src/', 'command', 'launch', 'evidence'],
};

describe('plan scope grammar', () => {
  it('accepts edit prefixes and the fixed sandbox categories', () => {
    expect(validateScopeEntries(['edit:src/', 'command', 'launch', 'evidence'])).toEqual([
      'edit:src/',
      'command',
      'launch',
      'evidence',
    ]);
  });

  it('refuses prohibited categories outright so no approval route can enable them', () => {
    for (const entry of ['deploy:production', 'purchase', 'external-communication', 'expand-access', 'destructive']) {
      expect(() => validateScopeEntries([entry]), entry).toThrowError(/prohibited/);
    }
  });

  it('refuses malformed edit prefixes and unknown categories', () => {
    expect(() => validateScopeEntries(['edit:'])).toThrowError(/prohibited/);
    expect(() => validateScopeEntries(['edit:/absolute/'])).toThrowError(/prohibited/);
    expect(() => validateScopeEntries(['edit:../escape/'])).toThrowError(/prohibited/);
    expect(() => validateScopeEntries(['random'])).toThrowError(/prohibited/);
  });

  it('matches edit paths only under the approved prefix', () => {
    const scope = ['edit:src/'];
    expect(scopeCoversEdit(scope, 'src/index.ts')).toBe(true);
    expect(scopeCoversEdit(scope, 'src/deep/nested/file.ts')).toBe(true);
    expect(scopeCoversEdit(scope, 'srcx/index.ts')).toBe(false);
    expect(scopeCoversEdit(scope, 'tests/index.test.ts')).toBe(false);
    expect(scopeCoversEdit(['edit:src/index.ts'], 'src/index.ts')).toBe(true);
    expect(scopeCoversEdit(['edit:src/index.ts'], 'src/index.other.ts')).toBe(false);
  });

  it('flags prohibited and metadata-targeting commands', () => {
    expect(isProhibitedCommand(['kubectl', 'apply', '-f', 'prod.yaml']).prohibited).toBe(true);
    expect(isProhibitedCommand(['bash', '-c', 'curl https://example.internal']).prohibited).toBe(true);
    expect(isProhibitedCommand(['node', 'script.js', '169.254.169.254']).prohibited).toBe(true);
    expect(isProhibitedCommand(['node', 'server.js']).prohibited).toBe(false);
    expect(isProhibitedCommand(['npm', 'test']).prohibited).toBe(false);
  });
});

describe('plan versions', () => {
  it('creates version 1 as draft and appends immutable later versions', () => {
    const first = withTransaction(db, () => createPlanVersionRow(db, projectId, BASE_INPUT, 'req-t1'));
    expect(first.plan.version).toBe(1);
    expect(first.plan.status).toBe('draft');
    expect(first.invalidatedApprovals).toEqual([]);

    const second = withTransaction(db, () =>
      createPlanVersionRow(
        db,
        projectId,
        { ...BASE_INPUT, items: ['Changed requirement item'], impactedPaths: ['src/index.ts'], impactedTests: ['tests/index.test.ts'] },
        'req-t2',
      ),
    );
    expect(second.plan.version).toBe(2);
    expect(second.plan.impactedPaths).toEqual(['src/index.ts']);
    expect(second.plan.impactedTests).toEqual(['tests/index.test.ts']);
    expect(getPlanRow(db, projectId, first.plan.id)!.status).toBe('superseded');
    expect(listPlanRows(db, projectId).map((plan) => plan.version)).toEqual([1, 2]);
  });

  it('keeps plans project-scoped', () => {
    const plan = withTransaction(db, () => createPlanVersionRow(db, projectId, BASE_INPUT, 'req-t3'));
    expect(getPlanRow(db, otherProjectId, plan.plan.id)).toBeNull();
    expect(latestPlanRow(db, otherProjectId)).toBeNull();
  });
});

describe('exact-version approvals', () => {
  it('approves the latest version, records principal and scope, and never authorizes another version', () => {
    const v1 = withTransaction(db, () => createPlanVersionRow(db, projectId, BASE_INPUT, 'req-t4'));
    const approval = withTransaction(db, () =>
      approvePlanVersionRow(db, projectId, v1.plan.id, {
        permittedScope: ['edit:src/', 'command'],
        approvedBy: 'prin_owner',
      }, 'req-t5'),
    );
    expect(approval.approval.status).toBe('active');
    expect(approval.approval.version).toBe(1);
    expect(getPlanRow(db, projectId, v1.plan.id)!.status).toBe('approved');

    // v2 supersedes v1: the old approval is invalidated and v1 can no longer
    // be approved.
    withTransaction(db, () => createPlanVersionRow(db, projectId, { ...BASE_INPUT, items: ['New item'] }, 'req-t6'));
    expect(getApprovalRow(db, projectId, approval.approval.id)!.status).toBe('invalidated');
    expect(() =>
      withTransaction(db, () =>
        approvePlanVersionRow(db, projectId, v1.plan.id, { permittedScope: ['command'], approvedBy: 'prin_owner' }, 'req-t7'),
      ),
    ).toThrowError(/superseded/);
  });

  it('refuses approvals for unknown or foreign plans', () => {
    expect(() =>
      withTransaction(db, () =>
        approvePlanVersionRow(db, projectId, 'pln_missing', { permittedScope: ['command'], approvedBy: 'x' }, 'req-t8'),
      ),
    ).toThrowError(/not exist/i);
    const foreign = withTransaction(db, () => createPlanVersionRow(db, otherProjectId, BASE_INPUT, 'req-t9'));
    expect(() =>
      withTransaction(db, () =>
        approvePlanVersionRow(db, projectId, foreign.plan.id, { permittedScope: ['command'], approvedBy: 'x' }, 'req-t10'),
      ),
    ).toThrowError(/not exist/i);
  });

  it('rejects approval scope outside the plan proposal or the safe grammar', () => {
    const plan = withTransaction(db, () => createPlanVersionRow(db, projectId, { ...BASE_INPUT, permittedScope: ['edit:src/'] }, 'req-t11'));
    expect(() =>
      withTransaction(db, () =>
        approvePlanVersionRow(db, projectId, plan.plan.id, { permittedScope: ['command'], approvedBy: 'x' }, 'req-t12'),
      ),
    ).toThrowError(/not part of the plan/);
    expect(() =>
      withTransaction(db, () =>
        approvePlanVersionRow(db, projectId, plan.plan.id, { permittedScope: ['deploy:prod'], approvedBy: 'x' }, 'req-t13'),
      ),
    ).toThrowError(/prohibited/);
  });

  it('is idempotent for repeat approvals of the same version and lists approvals', () => {
    const plan = withTransaction(db, () => createPlanVersionRow(db, projectId, BASE_INPUT, 'req-t14'));
    const first = withTransaction(db, () =>
      approvePlanVersionRow(db, projectId, plan.plan.id, { permittedScope: ['command'], approvedBy: 'x' }, 'req-t15'),
    );
    const second = withTransaction(db, () =>
      approvePlanVersionRow(db, projectId, plan.plan.id, { permittedScope: ['command'], approvedBy: 'x' }, 'req-t16'),
    );
    expect(second.approval.id).toBe(first.approval.id);
    expect(listApprovalRows(db, projectId)).toHaveLength(1);
  });
});
