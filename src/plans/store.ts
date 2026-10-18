import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { mapRow, mapRows } from '../db/db.js';
import { Errors } from '../errors.js';
import { appendProjectEvent } from '../events/store.js';
import { validateScopeEntries } from './scope.js';

/**
 * Immutable plan versions and exact-version sandbox approvals.
 *
 * A plan version is immutable once created. Creating the next version marks
 * prior versions superseded and invalidates their active approvals (the
 * material-change rule: affected work cannot start until the new version is
 * approved). An approval binds ONE plan version, the approving principal and
 * the permitted sandbox scope; the tool layer rechecks it at execution.
 *
 * All functions expect the caller's open transaction so the plan/approval
 * mutation and its events commit atomically.
 */

export interface PlanVersionRow {
  id: string;
  projectId: string;
  version: number;
  items: string[];
  acceptanceCriteria: string[];
  permittedScope: string[];
  repositoryCommit: string | null;
  impactedPaths: string[];
  impactedTests: string[];
  status: 'draft' | 'approved' | 'superseded' | 'invalidated';
  createdAt: number;
}

export interface PlanApprovalRow {
  id: string;
  projectId: string;
  planId: string;
  version: number;
  permittedScope: string[];
  approvedBy: string;
  approvedAt: number;
  status: 'active' | 'invalidated';
  invalidatedAt: number | null;
  invalidationReason: string | null;
}

export interface CreatePlanVersionInput {
  items: string[];
  acceptanceCriteria: string[];
  permittedScope: string[];
  repositoryCommit?: string;
  impactedPaths?: string[];
  impactedTests?: string[];
}

interface PlanSqlRow {
  id: string;
  project_id: string;
  version: number;
  items_json: string;
  acceptance_criteria_json: string;
  permitted_scope_json: string;
  repository_commit: string | null;
  impacted_paths_json: string;
  impacted_tests_json: string;
  status: PlanVersionRow['status'];
  created_at: number;
}

interface ApprovalSqlRow {
  id: string;
  project_id: string;
  plan_id: string;
  version: number;
  permitted_scope_json: string;
  approved_by: string;
  approved_at: number;
  status: PlanApprovalRow['status'];
  invalidated_at: number | null;
  invalidation_reason: string | null;
}

function parseJsonArray(raw: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
}

function mapPlan(row: PlanSqlRow): PlanVersionRow {
  return {
    id: row.id,
    projectId: row.project_id,
    version: row.version,
    items: parseJsonArray(row.items_json),
    acceptanceCriteria: parseJsonArray(row.acceptance_criteria_json),
    permittedScope: parseJsonArray(row.permitted_scope_json),
    repositoryCommit: row.repository_commit,
    impactedPaths: parseJsonArray(row.impacted_paths_json),
    impactedTests: parseJsonArray(row.impacted_tests_json),
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapApproval(row: ApprovalSqlRow): PlanApprovalRow {
  return {
    id: row.id,
    projectId: row.project_id,
    planId: row.plan_id,
    version: row.version,
    permittedScope: parseJsonArray(row.permitted_scope_json),
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    status: row.status,
    invalidatedAt: row.invalidated_at,
    invalidationReason: row.invalidation_reason,
  };
}

function boundedStringList(value: string[] | undefined, field: string): string[] {
  if (value === undefined) return [];
  if (value.length > 50) throw Errors.validation(`${field} exceeds 50 entries`, { reason: 'prohibited_scope' });
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 512) {
      throw Errors.validation(`${field} entries must be non-empty strings`, { reason: 'prohibited_scope' });
    }
    return entry;
  });
}

/** Create the next immutable plan version; supersedes priors and invalidates their approvals. */
export function createPlanVersionRow(
  db: DatabaseSync,
  projectId: string,
  input: CreatePlanVersionInput,
  requestId: string,
): { plan: PlanVersionRow; invalidatedApprovals: PlanApprovalRow[] } {
  const items = boundedStringList(input.items, 'items');
  const criteria = boundedStringList(input.acceptanceCriteria, 'acceptanceCriteria');
  const scope = validateScopeEntries(input.permittedScope);
  const impactedPaths = boundedStringList(input.impactedPaths, 'impactedPaths');
  const impactedTests = boundedStringList(input.impactedTests, 'impactedTests');
  if (items.length === 0 || criteria.length === 0) {
    throw Errors.validation('A plan version needs concrete items and acceptance criteria', { reason: 'plan_not_concrete' });
  }

  const maxRow = mapRow<{ max_version: number }>(
    db.prepare('SELECT COALESCE(MAX(version), 0) AS max_version FROM plan_versions WHERE project_id = ?').get(projectId),
  );
  const version = (maxRow ?? { max_version: 0 }).max_version + 1;
  const planId = `pln_${randomUUID()}`;
  const now = Date.now();

  db.prepare(
    `INSERT INTO plan_versions (id, project_id, version, items_json, acceptance_criteria_json, permitted_scope_json, repository_commit, impacted_paths_json, impacted_tests_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
  ).run(
    planId,
    projectId,
    version,
    JSON.stringify(items),
    JSON.stringify(criteria),
    JSON.stringify(scope),
    input.repositoryCommit ?? null,
    JSON.stringify(impactedPaths),
    JSON.stringify(impactedTests),
    now,
  );

  // Material change: prior versions are superseded and their active
  // approvals are invalidated, naming the impacted files and tests.
  const invalidatedApprovals: PlanApprovalRow[] = [];
  if (version > 1) {
    db.prepare(
      "UPDATE plan_versions SET status = 'superseded' WHERE project_id = ? AND version < ? AND status IN ('draft', 'approved')",
    ).run(projectId, version);
    const activeRows = mapRows<ApprovalSqlRow>(
      db.prepare("SELECT * FROM plan_approvals WHERE project_id = ? AND status = 'active'").all(projectId),
    );
    for (const row of activeRows) {
      db.prepare(
        "UPDATE plan_approvals SET status = 'invalidated', invalidated_at = ?, invalidation_reason = ? WHERE id = ?",
      ).run(now, `superseded_by_plan_v${version}`, row.id);
      const invalidated = mapApproval({ ...row, status: 'invalidated', invalidated_at: now, invalidation_reason: `superseded_by_plan_v${version}` });
      invalidatedApprovals.push(invalidated);
      appendProjectEvent(db, {
        projectId,
        type: 'plan.approval.invalidated',
        data: {
          approvalId: row.id,
          planId: row.plan_id,
          version: row.version,
          reason: `superseded_by_plan_v${version}`,
          impactedPaths,
          impactedTests,
        },
        requestId,
      });
    }
  }

  const plan = getPlanRow(db, projectId, planId)!;
  appendProjectEvent(db, {
    projectId,
    type: 'plan.version.created',
    data: { planId, version, invalidatedApprovalIds: invalidatedApprovals.map((approval) => approval.id), impactedPaths, impactedTests },
    requestId,
  });
  return { plan, invalidatedApprovals };
}

export function getPlanRow(db: DatabaseSync, projectId: string, planId: string): PlanVersionRow | null {
  const row = mapRow<PlanSqlRow>(
    db.prepare('SELECT * FROM plan_versions WHERE id = ? AND project_id = ?').get(planId, projectId),
  );
  return row === undefined ? null : mapPlan(row);
}

export function latestPlanRow(db: DatabaseSync, projectId: string): PlanVersionRow | null {
  const row = mapRow<PlanSqlRow>(
    db.prepare('SELECT * FROM plan_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(projectId),
  );
  return row === undefined ? null : mapPlan(row);
}

export function listPlanRows(db: DatabaseSync, projectId: string): PlanVersionRow[] {
  return mapRows<PlanSqlRow>(db.prepare('SELECT * FROM plan_versions WHERE project_id = ? ORDER BY version').all(projectId)).map(mapPlan);
}

/**
 * Approve one exact plan version with the permitted sandbox scope.
 * Approving a nonexistent, foreign-project, superseded or invalidated
 * version fails; approval scope must be inside the plan's proposed scope.
 */
export function approvePlanVersionRow(
  db: DatabaseSync,
  projectId: string,
  planId: string,
  input: { permittedScope: string[]; approvedBy: string },
  requestId: string,
): { approval: PlanApprovalRow; plan: PlanVersionRow } {
  const plan = getPlanRow(db, projectId, planId);
  if (plan === null) {
    throw Errors.notFound(`Plan ${planId} does not exist in this project`);
  }
  const latest = latestPlanRow(db, projectId)!;
  if (latest.id !== plan.id) {
    throw Errors.conflict(`Plan version ${plan.version} is superseded by version ${latest.version}`, {
      reason: 'plan_superseded',
      currentVersion: latest.version,
    });
  }
  if (plan.status === 'invalidated') {
    throw Errors.conflict('Plan approval was invalidated by a material change', { reason: 'plan_invalidated' });
  }

  // Idempotent by version: an active approval for this exact plan version is
  // returned as-is; a repeat never creates a second approval.
  const existing = mapRow<ApprovalSqlRow>(
    db.prepare("SELECT * FROM plan_approvals WHERE plan_id = ? AND status = 'active'").get(planId),
  );
  if (existing !== undefined) {
    return { approval: mapApproval(existing), plan };
  }

  const scope = validateScopeEntries(input.permittedScope);
  const proposed = new Set(plan.permittedScope);
  for (const entry of scope) {
    if (!proposed.has(entry)) {
      throw Errors.validation(`Approval scope "${entry}" is not part of the plan's proposed scope`, {
        reason: 'scope_not_in_plan',
      });
    }
  }

  const approvalId = `apr_${randomUUID()}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO plan_approvals (id, project_id, plan_id, version, permitted_scope_json, approved_by, approved_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
  ).run(approvalId, projectId, planId, plan.version, JSON.stringify(scope), input.approvedBy, now);
  db.prepare("UPDATE plan_versions SET status = 'approved' WHERE id = ? AND status = 'draft'").run(planId);

  const approval = getApprovalRow(db, projectId, approvalId)!;
  appendProjectEvent(db, {
    projectId,
    type: 'plan.approval.granted',
    data: { approvalId, planId, version: plan.version, permittedScope: scope, approvedBy: input.approvedBy },
    requestId,
  });
  return { approval, plan };
}

export function getApprovalRow(db: DatabaseSync, projectId: string, approvalId: string): PlanApprovalRow | null {
  const row = mapRow<ApprovalSqlRow>(
    db.prepare('SELECT * FROM plan_approvals WHERE id = ? AND project_id = ?').get(approvalId, projectId),
  );
  return row === undefined ? null : mapApproval(row);
}

export function listApprovalRows(db: DatabaseSync, projectId: string): PlanApprovalRow[] {
  return mapRows<ApprovalSqlRow>(db.prepare('SELECT * FROM plan_approvals WHERE project_id = ? ORDER BY approved_at, id').all(projectId)).map(mapApproval);
}
