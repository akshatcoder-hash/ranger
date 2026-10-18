import type { FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { mapRow } from '../db/db.js';
import { Errors } from '../errors.js';

/**
 * Central resource-to-project authorization.
 *
 * Every tenant resource resolves to its project server-side before
 * authorization; the handlers never infer ownership from client-supplied
 * provider or sandbox identifiers. Project-scoped handlers call
 * requireMembership / requireProjectOwner; principal-scoped handlers check
 * ownership of the exact row they touch.
 */

export type MembershipRole = 'owner' | 'member';

export interface ProjectRow {
  id: string;
  name: string;
  engineerDisplayName: string;
  createdAt: number;
  createdBy: string;
}

interface ProjectSqlRow {
  id: string;
  name: string;
  engineer_display_name: string;
  created_by: string;
  created_at: number;
}

interface MembershipSqlRow {
  role: string;
}

export function mapProjectRow(row: ProjectSqlRow): ProjectRow {
  return {
    id: row.id,
    name: row.name,
    engineerDisplayName: row.engineer_display_name,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

/** The authenticated principal id for a request, or throw the standard unauthorized envelope. */
export function requirePrincipalId(req: FastifyRequest): string {
  const principalId = req.principalId;
  if (principalId === undefined || principalId === '') {
    throw Errors.unauthorized();
  }
  return principalId;
}

export function getProjectRow(db: DatabaseSync, projectId: string): ProjectRow | null {
  const row = mapRow<ProjectSqlRow>(
    db
      .prepare('SELECT id, name, engineer_display_name, created_by, created_at FROM projects WHERE id = ?')
      .get(projectId),
  );
  return row === undefined ? null : mapProjectRow(row);
}

/** Resolve the project row or fail with not_found (no cross-principal existence signal). */
export function requireProjectRow(db: DatabaseSync, projectId: string): ProjectRow {
  const row = getProjectRow(db, projectId);
  if (row === null) throw Errors.notFound(`Project ${projectId} does not exist`);
  return row;
}

export function membershipRole(
  db: DatabaseSync,
  projectId: string,
  principalId: string,
): MembershipRole | null {
  const row = mapRow<MembershipSqlRow>(
    db
      .prepare('SELECT role FROM memberships WHERE project_id = ? AND principal_id = ?')
      .get(projectId, principalId),
  );
  if (row === undefined) return null;
  return row.role as MembershipRole;
}

/**
 * Authorize a project-scoped request: the project must exist and the
 * principal must be a member. Members may read and work; owners manage the
 * project itself (name, engineer display name, memberships).
 */
export function requireMembership(
  db: DatabaseSync,
  projectId: string,
  principalId: string | undefined,
): MembershipRole {
  if (principalId === undefined || principalId === '') throw Errors.unauthorized();
  requireProjectRow(db, projectId);
  const role = membershipRole(db, projectId, principalId);
  if (role === null) {
    throw Errors.forbidden('Principal is not a member of this project', { projectId });
  }
  return role;
}

export function requireProjectOwner(
  db: DatabaseSync,
  projectId: string,
  principalId: string | undefined,
): 'owner' {
  const role = requireMembership(db, projectId, principalId);
  if (role !== 'owner') {
    throw Errors.forbidden('Project management requires the owner role', { projectId });
  }
  return 'owner';
}
