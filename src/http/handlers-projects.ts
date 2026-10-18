import type { FastifyRequest } from 'fastify';
import { Errors } from '../errors.js';
import { getPrincipal } from '../auth/principals.js';
import {
  getProjectRow,
  membershipRole,
  requireMembership,
  requirePrincipalId,
  requireProjectOwner,
  type ProjectRow,
} from '../auth/authorization.js';
import {
  addMembershipRow,
  createProjectRecord,
  listMembershipRows,
  listProjectsForPrincipal,
  removeMembershipRow,
  updateProjectRow,
} from '../projects/store.js';
import { appendProjectEvent } from '../events/store.js';
import { iso } from './serialize.js';
import { runScopedMutation } from './idempotency.js';
import type { HandlerContext, OperationHandler } from './handlers.js';

/**
 * Handlers for the projects-memberships family: project CRUD with the
 * customer-configurable engineer display name and membership management.
 * Every project-scoped handler authorizes through the central
 * requireMembership / requireProjectOwner helpers.
 */

export interface ProjectPayload {
  projectId: string;
  name: string;
  engineerDisplayName: string;
  createdAt: string;
}

export function projectPayload(row: ProjectRow): ProjectPayload {
  return {
    projectId: row.id,
    name: row.name,
    engineerDisplayName: row.engineerDisplayName,
    createdAt: iso(row.createdAt),
  };
}

interface CreateProjectBody {
  name?: string;
  engineerDisplayName?: string;
}

interface UpdateProjectBody {
  name?: string;
  engineerDisplayName?: string;
}

interface AddMembershipBody {
  principalId?: string;
  role?: 'owner' | 'member';
}

export function registerProjectHandlers(ctx: HandlerContext, handlers: Map<string, OperationHandler>): void {
  const { db } = ctx;

  handlers.set('createProject', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const body = (req.body ?? {}) as CreateProjectBody;
    if (typeof body.name !== 'string' || typeof body.engineerDisplayName !== 'string') {
      throw Errors.validation('name and engineerDisplayName are required');
    }
    // Creating a project is scoped to no existing project id; the scope uses
    // a fixed bucket. There is no declared project.created event type, so no
    // event is appended here.
    const row = runScopedMutation(db, req, 'createProject', '-', () =>
      createProjectRecord(db, {
        name: body.name!,
        engineerDisplayName: body.engineerDisplayName!,
        principalId,
      }),
    );
    return { project: projectPayload(row) };
  });

  handlers.set('listProjects', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const rows = listProjectsForPrincipal(db, principalId);
    return {
      projects: rows.map((row) => ({
        projectId: row.id,
        name: row.name,
        engineerDisplayName: row.engineerDisplayName,
      })),
      nextCursor: null,
    };
  });

  handlers.set('getProject', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string };
    requireMembership(db, params.projectId, principalId);
    const row = getProjectRow(db, params.projectId);
    if (row === null) throw Errors.notFound('Project does not exist');
    return { project: projectPayload(row) };
  });

  handlers.set('updateProject', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string };
    requireProjectOwner(db, params.projectId, principalId);
    const body = (req.body ?? {}) as UpdateProjectBody;
    const projectId = params.projectId;
    const row = runScopedMutation(db, req, 'updateProject', projectId, () => {
      const updated = updateProjectRow(db, projectId, {
        name: body.name,
        engineerDisplayName: body.engineerDisplayName,
      });
      // Same transaction as the rename: schema-valid, carries the new values.
      appendProjectEvent(db, {
        projectId,
        type: 'project.updated',
        data: { name: updated.name, engineerDisplayName: updated.engineerDisplayName },
        requestId: req.id,
      });
      return updated;
    });
    return { project: projectPayload(row) };
  });

  handlers.set('addMembership', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string };
    requireProjectOwner(db, params.projectId, principalId);
    const body = (req.body ?? {}) as AddMembershipBody;
    if (typeof body.principalId !== 'string' || (body.role !== 'owner' && body.role !== 'member')) {
      throw Errors.validation('principalId and role (owner|member) are required');
    }
    if (getPrincipal(db, body.principalId) === null) {
      throw Errors.notFound('Principal does not exist');
    }
    const targetPrincipalId: string = body.principalId;
    const role: 'owner' | 'member' = body.role;
    const projectId = params.projectId;
    const record = runScopedMutation(db, req, 'addMembership', projectId, () => {
      const before = membershipRole(db, projectId, targetPrincipalId);
      const added = addMembershipRow(db, projectId, targetPrincipalId, role);
      // Event only when membership state actually changed (add or role
      // change); re-adding an identical membership is a no-op.
      if (before !== role) {
        appendProjectEvent(db, {
          projectId,
          type: 'membership.updated',
          data: { principalId: targetPrincipalId, role },
          requestId: req.id,
        });
      }
      return added;
    });
    return {
      membership: {
        projectId: record.projectId,
        principalId: record.principalId,
        role: record.role,
        createdAt: iso(record.createdAt),
      },
    };
  });

  handlers.set('listMemberships', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string };
    requireMembership(db, params.projectId, principalId);
    const rows = listMembershipRows(db, params.projectId);
    return {
      memberships: rows.map((row) => ({
        projectId: row.projectId,
        principalId: row.principalId,
        role: row.role,
      })),
      nextCursor: null,
    };
  });

  handlers.set('removeMembership', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string; principalId: string };
    requireProjectOwner(db, params.projectId, principalId);
    const projectId = params.projectId;
    runScopedMutation(db, req, 'removeMembership', projectId, () => {
      removeMembershipRow(db, projectId, params.principalId);
      appendProjectEvent(db, {
        projectId,
        type: 'membership.updated',
        data: { principalId: params.principalId, role: null },
        requestId: req.id,
      });
      return {};
    });
    return {};
  });
}
