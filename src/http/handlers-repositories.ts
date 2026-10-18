import type { FastifyRequest } from 'fastify';
import { Errors } from '../errors.js';
import { requireMembership, requirePrincipalId } from '../auth/authorization.js';
import {
  disconnectRepository,
  getRepositoryRecord,
  prepareRepositoryConnection,
  writeRepositoryRecord,
  type RepositoryRecord,
} from '../repositories/store.js';
import { appendProjectEvent } from '../events/store.js';
import { iso } from './serialize.js';
import { runScopedMutation } from './idempotency.js';
import type { HandlerContext, OperationHandler } from './handlers.js';

/**
 * Handlers for the repositories family: connect, read and disconnect the
 * project repository reference. Connections record the approved URL, ref,
 * checkout path and checkout policy (never credential material) and resolve
 * commit/dirty/content-hash for local repositories.
 */

export function repositoryPayload(record: RepositoryRecord): Record<string, unknown> {
  return {
    projectId: record.projectId,
    url: record.url,
    ref: record.ref,
    commit: record.commit,
    dirty: record.dirty,
    contentHash: record.contentHash,
    checkoutPath: record.checkoutPath,
    checkoutPolicy: record.checkoutPolicy,
    connectedAt: iso(record.connectedAt),
  };
}

interface ConnectRepositoryBody {
  url?: string;
  ref?: string;
  checkoutPath?: string;
  checkoutPolicy?: { shallow?: boolean; submodules?: boolean };
}

export function registerRepositoryHandlers(ctx: HandlerContext, handlers: Map<string, OperationHandler>): void {
  const { db, config } = ctx;

  handlers.set('connectRepository', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string };
    requireMembership(db, params.projectId, principalId);
    const body = (req.body ?? {}) as ConnectRepositoryBody;
    if (typeof body.url !== 'string' || typeof body.ref !== 'string') {
      throw Errors.validation('url and ref are required');
    }
    // Read-only snapshot resolution happens outside the transaction and only
    // under operator-approved snapshot roots; unapproved local paths are
    // refused without any host inspection.
    const prepared = await prepareRepositoryConnection(
      {
        url: body.url,
        ref: body.ref,
        checkoutPath: body.checkoutPath,
        checkoutPolicy: body.checkoutPolicy,
      },
      config.approvedSnapshotRoots,
    );
    const projectId = params.projectId;
    const record = runScopedMutation(db, req, 'connectRepository', projectId, () => {
      const written = writeRepositoryRecord(db, projectId, principalId, prepared);
      // Same transaction as the connect: schema-valid event with the new values.
      appendProjectEvent(db, {
        projectId,
        type: 'repository.connected',
        data: {
          url: written.url,
          ref: written.ref,
          commit: written.commit,
          checkoutPath: written.checkoutPath,
        },
        requestId: req.id,
      });
      return written;
    });
    return { repository: repositoryPayload(record) };
  });

  handlers.set('getRepository', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string };
    requireMembership(db, params.projectId, principalId);
    const record = getRepositoryRecord(db, params.projectId);
    if (record === null) throw Errors.notFound('No repository is connected for this project');
    return { repository: repositoryPayload(record) };
  });

  handlers.set('disconnectRepository', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string };
    requireMembership(db, params.projectId, principalId);
    // Idempotent, and the removal + its event commit atomically: a retry
    // replays with no second event, and the record fields are captured
    // before the delete inside the same transaction.
    runScopedMutation(db, req, 'disconnectRepository', params.projectId, () => {
      const record = getRepositoryRecord(db, params.projectId);
      if (record === null) return {};
      disconnectRepository(db, params.projectId);
      appendProjectEvent(db, {
        projectId: params.projectId,
        type: 'repository.disconnected',
        data: {
          url: record.url,
          ref: record.ref,
          commit: record.commit,
          checkoutPath: record.checkoutPath,
        },
        requestId: req.id,
      });
      return {};
    });
    return {};
  });
}
