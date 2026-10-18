import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Errors } from '../errors.js';
import { mapRow, mapRows, withTransaction } from '../db/db.js';
import { getProjectRow, type MembershipRole, type ProjectRow } from '../auth/authorization.js';

/**
 * Project and membership persistence.
 *
 * Projects carry the customer-configurable engineer display name. Creating a
 * project makes the creator the first owner. Membership changes are scoped to
 * the targeted principal only and guard the last owner so a project never
 * becomes unmanageable.
 */

export interface MembershipRecord {
  projectId: string;
  principalId: string;
  role: MembershipRole;
  createdAt: number;
}

interface MembershipSqlRow {
  project_id: string;
  principal_id: string;
  role: string;
  created_at: number;
}

function mapMembership(row: MembershipSqlRow): MembershipRecord {
  return {
    projectId: row.project_id,
    principalId: row.principal_id,
    role: row.role as MembershipRole,
    createdAt: row.created_at,
  };
}

export function createProjectRow(
  db: DatabaseSync,
  input: { name: string; engineerDisplayName: string; principalId: string },
): ProjectRow {
  const now = Date.now();
  const id = `prj_${randomUUID()}`;
  return withTransaction(db, () => {
    db.prepare(
      'INSERT INTO projects (id, name, engineer_display_name, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, input.name, input.engineerDisplayName, input.principalId, now);
    db.prepare(
      'INSERT INTO memberships (project_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, input.principalId, 'owner', now);
    return {
      id,
      name: input.name,
      engineerDisplayName: input.engineerDisplayName,
      createdAt: now,
      createdBy: input.principalId,
    };
  });
}

export function listProjectsForPrincipal(db: DatabaseSync, principalId: string): ProjectRow[] {
  const rows = mapRows<{
    id: string;
    name: string;
    engineer_display_name: string;
    created_by: string;
    created_at: number;
  }>(
    db
      .prepare(
        `SELECT p.id, p.name, p.engineer_display_name, p.created_by, p.created_at
         FROM projects p
         JOIN memberships m ON m.project_id = p.id AND m.principal_id = ?
         ORDER BY p.created_at, p.id`,
      )
      .all(principalId),
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    engineerDisplayName: row.engineer_display_name,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }));
}

export function updateProjectRow(
  db: DatabaseSync,
  projectId: string,
  patch: { name?: string; engineerDisplayName?: string },
): ProjectRow {
  const current = getProjectRow(db, projectId);
  if (current === null) throw Errors.notFound(`Project ${projectId} does not exist`);
  const name = patch.name ?? current.name;
  const engineerDisplayName = patch.engineerDisplayName ?? current.engineerDisplayName;
  db.prepare('UPDATE projects SET name = ?, engineer_display_name = ? WHERE id = ?').run(
    name,
    engineerDisplayName,
    projectId,
  );
  return { ...current, name, engineerDisplayName };
}

export function addMembershipRow(
  db: DatabaseSync,
  projectId: string,
  principalId: string,
  role: MembershipRole,
): MembershipRecord {
  const now = Date.now();
  const existing = mapRow<MembershipSqlRow>(
    db
      .prepare('SELECT role FROM memberships WHERE project_id = ? AND principal_id = ?')
      .get(projectId, principalId),
  );
  if (existing !== undefined) {
    // Re-adding an existing member with the same role is a no-op; a
    // different role is an update scoped to that principal only.
    if (existing.role === role) {
      return { projectId, principalId, role, createdAt: existing.created_at };
    }
    db.prepare('UPDATE memberships SET role = ? WHERE project_id = ? AND principal_id = ?').run(
      role,
      projectId,
      principalId,
    );
    return { projectId, principalId, role, createdAt: existing.created_at };
  }
  db.prepare(
    'INSERT INTO memberships (project_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)',
  ).run(projectId, principalId, role, now);
  return { projectId, principalId, role, createdAt: now };
}

export function listMembershipRows(db: DatabaseSync, projectId: string): MembershipRecord[] {
  const rows = mapRows<MembershipSqlRow>(
    db
      .prepare(
        'SELECT project_id, principal_id, role, created_at FROM memberships WHERE project_id = ? ORDER BY created_at, principal_id',
      )
      .all(projectId),
  );
  return rows.map(mapMembership);
}

export function removeMembershipRow(db: DatabaseSync, projectId: string, principalId: string): void {
  withTransaction(db, () => {
    const role = mapRow<MembershipSqlRow>(
      db
        .prepare('SELECT role FROM memberships WHERE project_id = ? AND principal_id = ?')
        .get(projectId, principalId),
    );
    if (role === undefined) {
      throw Errors.notFound('Membership does not exist');
    }
    if (role.role === 'owner') {
      const owners = mapRow<{ count: number }>(
        db
          .prepare("SELECT COUNT(*) AS count FROM memberships WHERE project_id = ? AND role = 'owner'")
          .get(projectId),
      );
      if (owners !== undefined && owners.count <= 1) {
        throw Errors.conflict('Cannot remove the last owner of a project');
      }
    }
    db.prepare('DELETE FROM memberships WHERE project_id = ? AND principal_id = ?').run(
      projectId,
      principalId,
    );
  });
}
