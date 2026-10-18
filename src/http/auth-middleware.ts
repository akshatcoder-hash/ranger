import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { Errors } from '../errors.js';
import { authenticateBearer } from '../auth/principals.js';
import {
  authenticateCookie,
  parseSessionCookieHeader,
  verifyCsrfToken,
} from '../auth/sessions.js';
import type { OperationDef } from '../contracts/registry.js';

/**
 * Central authentication pre-handler for principal-auth routes.
 *
 * Two credential transports:
 * - `Authorization: Bearer <api token or bootstrap credential>`
 * - the revocable browser-session cookie (HttpOnly).
 *
 * Cookie-authenticated MUTATIONS additionally require origin/CSRF
 * protection: a same-origin request (Origin header matching the request
 * host — browsers refuse to forge Origin) or a valid synchronizer CSRF
 * token header for non-browser clients. Bearer authentication is immune to
 * CSRF and skips these checks.
 */

export type AuthPreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

function forbidden(reason: string): Error {
  return Errors.forbidden('Cookie-authenticated mutation rejected', { reason });
}

function assertCookieMutationProtection(req: FastifyRequest, csrfHash: string): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    const host = req.headers.host;
    if (origin.toLowerCase() === 'null' || typeof host !== 'string' || host === '') {
      throw forbidden('origin_mismatch');
    }
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      throw forbidden('origin_mismatch');
    }
    if (originHost !== host.toLowerCase()) {
      throw forbidden('origin_mismatch');
    }
    return;
  }
  // No Origin header (non-browser client): require the synchronizer token.
  const presented = req.headers['x-ranger-csrf'];
  if (typeof presented !== 'string' || !verifyCsrfToken(presented, csrfHash)) {
    throw forbidden('csrf_required');
  }
}

export function createPrincipalAuth(db: DatabaseSync): (op: OperationDef) => AuthPreHandler {
  return (op: OperationDef) => async (req: FastifyRequest) => {
    void op;
    const authorization = req.headers.authorization;
    if (typeof authorization === 'string' && authorization.length > 0) {
      const match = /^Bearer\s+(\S+)$/.exec(authorization);
      if (match === null) {
        throw Errors.unauthorized('Authorization header must be a Bearer credential');
      }
      const auth = authenticateBearer(db, match[1]!);
      if (auth === null) {
        throw Errors.unauthorized('Credential is invalid or has been revoked');
      }
      req.principalId = auth.principalId;
      req.authKind = 'api-token';
      req.credentialId = auth.credentialId;
      return;
    }

    const cookieHeader = req.headers.cookie;
    if (typeof cookieHeader === 'string' && cookieHeader !== '') {
      const cookieValue = parseSessionCookieHeader(cookieHeader);
      if (cookieValue !== null) {
        const session = authenticateCookie(db, cookieValue);
        if (session === null) {
          throw Errors.unauthorized('Browser session is invalid, expired or revoked');
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          assertCookieMutationProtection(req, session.csrfHash);
        }
        req.principalId = session.principalId;
        req.authKind = 'browser-session';
        req.credentialId = session.session.id;
        return;
      }
    }

    throw Errors.unauthorized();
  };
}
