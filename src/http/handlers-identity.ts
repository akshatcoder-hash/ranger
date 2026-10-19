import type { FastifyRequest } from 'fastify';
import { Errors } from '../errors.js';
import {
  authenticateBearer,
  createCredential,
  createPrincipal,
  getPrincipal,
  listCredentials,
  revokeCredential,
} from '../auth/principals.js';
import {
  createSession,
  listSessions,
  revokeSession,
} from '../auth/sessions.js';
import { createTicket } from '../auth/tickets.js';
import { requireMembership, requirePrincipalId } from '../auth/authorization.js';
import { iso } from './serialize.js';
import type { HandlerContext, OperationHandler } from './handlers.js';

/**
 * Handlers for the credentials-sessions family: principal introspection,
 * hashed API tokens, revocable browser sessions and connection tickets.
 */

interface ApiTokenBody {
  name?: string;
}

interface BrowserSessionBody {
  apiToken?: string;
}

const ANONYMOUS_DISPLAY_NAME = 'Guest';

interface ConnectionTicketBody {
  projectId?: string;
  purpose?: 'events' | 'voice-relay' | 'desktop-stream' | 'app-preview';
  origin?: string;
}

export function registerIdentityHandlers(ctx: HandlerContext, handlers: Map<string, OperationHandler>): void {
  const { db } = ctx;

  handlers.set('getPrincipal', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const principal = getPrincipal(db, principalId);
    if (principal === null) throw Errors.unauthorized('Principal no longer exists');
    return { principalId: principal.id, displayName: principal.displayName };
  });

  handlers.set('createApiToken', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const body = (req.body ?? {}) as ApiTokenBody;
    const { credential, secret } = createCredential(db, principalId, 'api_token', body.name ?? 'api-token');
    // The secret is returned exactly once and stored only as a hash.
    return { tokenId: credential.id, token: secret };
  });

  handlers.set('listApiTokens', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const rows = listCredentials(db, principalId, 'api_token');
    return {
      tokens: rows.map((row) => ({ tokenId: row.id, name: row.name, createdAt: iso(row.createdAt) })),
      nextCursor: null,
    };
  });

  handlers.set('revokeApiToken', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { tokenId: string };
    const revoked = revokeCredential(db, principalId, params.tokenId);
    if (!revoked) throw Errors.notFound('Token not found or already revoked');
    return {};
  });

  handlers.set('createBrowserSession', async (req: FastifyRequest, reply) => {
    const body = (req.body ?? {}) as BrowserSessionBody;
    if (typeof body.apiToken !== 'string' || body.apiToken === '') {
      throw Errors.validation('apiToken is required');
    }
    const auth = authenticateBearer(db, body.apiToken);
    if (auth === null) {
      throw Errors.unauthorized('API credential is invalid or has been revoked');
    }
    const created = createSession(db, auth.principalId);
    void reply.header('set-cookie', created.setCookie);
    return {
      sessionId: created.session.id,
      expiresAt: iso(created.session.expiresAt),
      csrfToken: created.csrfToken,
    };
  });

  handlers.set('createAnonymousSession', async (_req: FastifyRequest, reply) => {
    const principal = createPrincipal(db, ANONYMOUS_DISPLAY_NAME);
    const created = createSession(db, principal.id);
    void reply.header('set-cookie', created.setCookie);
    return {
      sessionId: created.session.id,
      expiresAt: iso(created.session.expiresAt),
      csrfToken: created.csrfToken,
    };
  });

  handlers.set('listBrowserSessions', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const rows = listSessions(db, principalId);
    return {
      sessions: rows.map((row) => ({
        sessionId: row.id,
        createdAt: iso(row.createdAt),
        expiresAt: iso(row.expiresAt),
      })),
      nextCursor: null,
    };
  });

  handlers.set('revokeBrowserSession', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { sessionId: string };
    const revoked = revokeSession(db, principalId, params.sessionId);
    if (!revoked) throw Errors.notFound('Session not found or already revoked');
    return {};
  });

  handlers.set('createConnectionTicket', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const body = (req.body ?? {}) as ConnectionTicketBody;
    if (typeof body.projectId !== 'string' || typeof body.purpose !== 'string') {
      throw Errors.validation('projectId and purpose are required');
    }
    requireMembership(db, body.projectId, principalId);
    const created = createTicket(db, {
      principalId,
      projectId: body.projectId,
      purpose: body.purpose,
      origin: body.origin,
      credentialKind: req.authKind === 'browser-session' ? 'browser_session' : 'api_token',
      credentialId: req.credentialId ?? '',
    });
    return { ticket: created.secret, expiresAt: iso(created.ticket.expiresAt) };
  });
}
