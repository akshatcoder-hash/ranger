import type { FastifyRequest } from 'fastify';
import { Errors } from '../errors.js';
import { requireMembership, requirePrincipalId } from '../auth/authorization.js';
import { RetrievalService } from '../retrieval/service.js';
import type { HandlerContext, OperationHandler } from './handlers.js';

/**
 * Project-scoped retrieval routes over the real pinned Trace MCP runtime.
 * Membership is checked on every read/mutation. One service instance exists
 * per API process; closeRetrievalRuntimes stops its MCP children at shutdown.
 */

const servicesByContext = new WeakMap<HandlerContext, RetrievalService>();
const openServices = new Set<RetrievalService>();

/**
 * The one retrieval service of an API context, shared by the retrieval
 * routes and the voice code tools (one Trace runtime per project per API).
 */
export function retrievalServiceFor(ctx: HandlerContext): RetrievalService {
  let service = servicesByContext.get(ctx);
  if (service === undefined) {
    service = new RetrievalService({ db: ctx.db, config: ctx.config });
    servicesByContext.set(ctx, service);
    openServices.add(service);
  }
  return service;
}

/** Close every Trace MCP child process (API shutdown). */
export async function closeRetrievalRuntimes(): Promise<void> {
  const services = [...openServices];
  openServices.clear();
  for (const service of services) await service.closeAll();
}

export function registerRetrievalHandlers(ctx: HandlerContext, handlers: Map<string, OperationHandler>): void {
  const service = retrievalServiceFor(ctx);

  const authorize = (req: FastifyRequest): string => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId?: string };
    if (params.projectId === undefined) throw Errors.validation('projectId is required');
    requireMembership(ctx.db, params.projectId, principalId);
    return params.projectId;
  };

  handlers.set('retrievalSearch', async (req) => {
    const projectId = authorize(req);
    const body = (req.body ?? {}) as { query?: string; limit?: number };
    if (typeof body.query !== 'string' || body.query.trim().length === 0) {
      throw Errors.validation('query is required');
    }
    return service.search(projectId, body.query, body.limit ?? 10);
  });

  handlers.set('retrievalStatus', async (req) => {
    const projectId = authorize(req);
    return { retrieval: service.status(projectId) };
  });

  handlers.set('reindexRetrieval', async (req) => {
    const projectId = authorize(req);
    const status = await service.reindex(projectId);
    return { retrieval: status };
  });
}
