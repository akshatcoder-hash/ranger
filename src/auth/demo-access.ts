import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db/db.js';
import { getProjectRow, membershipRole } from './authorization.js';
import { addMembershipRow } from '../projects/store.js';
import { getRepositoryRecord } from '../repositories/store.js';

/**
 * Opt-in shared demo access (RANGER_DEMO_PROJECT_ID).
 *
 * While the flag names a project, every anonymous browser session is a
 * 'member' of exactly that project: the grant is recorded in
 * demo_access_grants so revocation can tell it apart from memberships an
 * owner created. Nothing here ever touches an owner row or any other project.
 *
 * Revocation semantics: reconcileDemoAccess runs when the API process starts.
 * Removing the flag (or pointing it at another project) and restarting the API
 * deletes every grant-created 'member' row for the old project. A principal
 * that was already a member before the grant is never recorded, so it is never
 * revoked; an owner who later promotes a grantee to 'owner' keeps that role.
 */

export const ANONYMOUS_DISPLAY_NAME = 'Guest';

export interface DemoProjectTarget {
  projectId: string;
  repositoryUrl: string;
  ref: string;
}

/** Grant demo membership to one principal. Returns true when a membership row was created. */
export function grantDemoAccess(db: DatabaseSync, demoProjectId: string | null, principalId: string): boolean {
  if (demoProjectId === null || getProjectRow(db, demoProjectId) === null) return false;
  return withTransaction(db, () => {
    if (membershipRole(db, demoProjectId, principalId) !== null) return false;
    addMembershipRow(db, demoProjectId, principalId, 'member');
    db.prepare('INSERT OR IGNORE INTO demo_access_grants (project_id, principal_id) VALUES (?, ?)').run(
      demoProjectId,
      principalId,
    );
    return true;
  });
}

/** Delete grant-created memberships for every project other than the current demo project. */
export function reconcileDemoAccess(db: DatabaseSync, demoProjectId: string | null): number {
  return withTransaction(db, () => {
    db.prepare(
      `DELETE FROM memberships WHERE role = 'member' AND (project_id, principal_id) IN (
         SELECT project_id, principal_id FROM demo_access_grants WHERE project_id IS NOT ?)`,
    ).run(demoProjectId);
    return Number(db.prepare('DELETE FROM demo_access_grants WHERE project_id IS NOT ?').run(demoProjectId).changes);
  });
}

/**
 * The demo target for an authenticated principal, only after membership proof.
 * Returns null when the flag is off, the project has no connected repository,
 * or the principal is not a member.
 */
export function demoTargetFor(
  db: DatabaseSync,
  demoProjectId: string | null,
  principalId: string,
): DemoProjectTarget | null {
  if (demoProjectId === null || membershipRole(db, demoProjectId, principalId) === null) return null;
  const repository = getRepositoryRecord(db, demoProjectId);
  if (repository === null) return null;
  return { projectId: demoProjectId, repositoryUrl: repository.url, ref: repository.ref };
}
