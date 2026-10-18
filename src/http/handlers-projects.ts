import type { FastifyRequest } from 'fastify';
import { Errors } from '../errors.js';
import { getPrincipal } from '../auth/principals.js';
import {
  getProjectRow,
  requireMembership,
  requirePrincipalId,
  requireProjectOwner,
  type ProjectRow,
} from '../auth/authorization.js';
import {
  addMembershipRow,
  createProjectRow,
  listMembershipRows,
  listProjectsForPrincipal,
  removeMembershipRow,
  updateProjectRow,
} from '../projects/store.js';
import { iso } from './serialize.js';
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
    const row = createProjectRow(db, {
      name: body.name,
      engineerDisplayName: body.engineerDisplayName,
      principalId,
    });
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
    const row = updateProjectRow(db, params.projectId, {
      name: body.name,
      engineerDisplayName: body.engineerDisplayName,
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
    const record = addMembershipRow(db, params.projectId, body.principalId, body.role);
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
    removeMembershipRow(db, params.projectId, params.principalId);
    return {};
  });
}
