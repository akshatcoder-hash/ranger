import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket as WsWebSocket } from 'ws';
import type { DatabaseSync } from 'node:sqlite';
import type { RangerConfig } from '../config.js';
import { AppError, Errors, isAppError, redact } from '../errors.js';
import { redactRequestUrl, secretSafeLoggerOptions } from './safe-url.js';
import { SecretResolver } from '../secrets.js';
import { getRegistry, type OperationDef } from '../contracts/registry.js';
import { toFastifyPathFor } from '../contracts/openapi.js';
import { mutationHeaders } from '../contracts/schema.js';
import { buildHandlerMaps, notConfiguredHandler, type HandlerContext, type OperationHandler, type WsOperationHandler } from './handlers.js';
import { createPrincipalAuth } from './auth-middleware.js';
import { DIAGNOSTIC_PAGE_HTML } from './diagnostic.js';

/**
 * Fastify API application factory.
 *
 * Central concerns implemented here so every route inherits them:
 * - unique requestId per request (also echoed as the x-request-id header)
 * - success envelope requestId injection (preSerialization)
 * - central error envelope with stable codes
 * - route registration driven entirely by the v1 contract registry
 * - WebSocket routes for declared realtime operations
 */

export interface ApiServerOptions {
  config: RangerConfig;
  db: DatabaseSync;
  /** Overrides for declared operations (used by tests and later features). */
  handlerOverrides?: Map<string, OperationHandler>;
}

function appErrorFromFastify(error: { statusCode?: number; code?: string }): AppError | null {
  switch (error.statusCode) {
    case 400:
      return Errors.validation('Request failed validation');
    case 401:
      return Errors.unauthorized();
    case 402:
      return new AppError('budget_exceeded', 'Payment required');
    case 403:
      return Errors.forbidden();
    case 404:
      return Errors.notFound();
    case 409:
      return Errors.conflict();
    case 410:
      return Errors.cursorExpired('Resource expired');
    case 429:
      return Errors.rateLimited('Rate limited');
    default:
      return null;
  }
}

function sendEnvelope(reply: FastifyReply, req: FastifyRequest, error: AppError): void {
  void reply.code(error.httpStatus).send({
    requestId: req.id,
    error: {
      code: error.code,
      message: redact(error.message),
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  });
}

export async function buildApiServer(opts: ApiServerOptions): Promise<FastifyInstance> {
  const context: HandlerContext = {
    config: opts.config,
    db: opts.db,
    secrets: new SecretResolver(opts.config.secretFile),
  };
  const { http: handlerMap, ws: wsHandlerMap } = buildHandlerMaps(context);
  if (opts.handlerOverrides !== undefined) {
    for (const [id, handler] of opts.handlerOverrides) handlerMap.set(id, handler);
  }

  const app = Fastify({
    genReqId: () => randomUUID(),
    bodyLimit: 9 * 1024 * 1024,
    // Strict contract validation: no type coercion, no silent property removal.
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
        allErrors: true,
      },
    },
    logger: secretSafeLoggerOptions(opts.config.logLevel),
  });

  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  // Echo the requestId header on every response, including errors.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  // Success responses carry the requestId in the body as well.
  app.addHook('preSerialization', async (req, reply, payload) => {
    if (payload === null || typeof payload !== 'object' || Buffer.isBuffer(payload)) return payload;
    const routeConfig = req.routeOptions?.config as { rawDoc?: boolean } | undefined;
    if (routeConfig?.rawDoc === true) return payload;
    if ('requestId' in (payload as Record<string, unknown>)) return payload;
    (payload as Record<string, unknown>).requestId = req.id;
    return payload;
  });

  app.setErrorHandler((error, req, reply) => {
    if (isAppError(error)) {
      sendEnvelope(reply, req, error);
      return;
    }
    const fastifyError = error as NodeJS.ErrnoException & { statusCode?: number; validation?: unknown };
    if (fastifyError.validation !== undefined) {
      sendEnvelope(
        reply,
        req,
        Errors.validation('Request failed schema validation', {
          fieldErrors: fastifyError.validation,
        }),
      );
      return;
    }
    const mapped = appErrorFromFastify(fastifyError);
    if (mapped !== null) {
      sendEnvelope(reply, req, mapped);
      return;
    }
    // Unknown failure: log server-side, return a safe envelope.
    req.log.error({ err: redact(String(error)) }, 'unhandled route error');
    sendEnvelope(reply, req, Errors.internal());
  });

  app.setNotFoundHandler((req, reply) => {
    sendEnvelope(reply, req, Errors.notFound(`No route for ${req.method} ${redactRequestUrl(req.url)}`));
  });

  const registry = getRegistry();
  const principalAuth = createPrincipalAuth(opts.db);
  for (const op of registry) {
    registerOperation(
      app,
      op,
      handlerMap.get(op.id) ?? notConfiguredHandler(op),
      principalAuth,
      wsHandlerMap.get(op.id),
    );
  }

  // Plain test diagnostic client: static, unstyled, secret-free TEST TOOLING
  // (not part of the v1 contract — no auth at this route, and every
  // authenticated action in the page calls the normal contract routes).
  app.get('/diagnostic', async (_req, reply) => {
    reply.type('text/html; charset=utf-8').send(DIAGNOSTIC_PAGE_HTML);
  });

  return app;
}

function registerOperation(
  app: FastifyInstance,
  op: OperationDef,
  handler: OperationHandler,
  principalAuth: (op: OperationDef) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>,
  wsHandler?: WsOperationHandler,
): void {
  const url = toFastifyPathFor(op);
  const schema: Record<string, unknown> = {
    ...(op.params !== undefined ? { params: op.params } : {}),
    ...(op.querystring !== undefined ? { querystring: op.querystring } : {}),
    ...(op.body !== undefined ? { body: op.body } : {}),
    ...(op.mutating === true ? { headers: mutationHeaders() } : {}),
  };

  if (op.ws === true) {
    // @fastify/websocket v11 passes the raw WebSocket as first argument.
    const handle: (socket: WsWebSocket, req: FastifyRequest) => void = wsHandler ?? notConfiguredWs(op);
    app.get(url, { websocket: true, schema }, (socket, req) => {
      handle(socket, req);
      void handler;
    });
    return;
  }
  // Principal-auth routes authenticate centrally (bearer or session cookie,
  // with CSRF/origin protection for cookie mutations). WebSocket routes keep
  // their declared ticket auth wiring for the events/voice/desktop features.
  const preHandler = op.auth === 'principal' ? principalAuth(op) : undefined;
  app.route({
    method: op.method,
    url,
    ...(Object.keys(schema).length > 0 ? { schema } : {}),
    ...(preHandler !== undefined ? { preHandler } : {}),
    ...(op.id === 'getOpenApiDocument' ? { config: { rawDoc: true } } : {}),
    handler: async (req, reply) => handler(req, reply),
  });
}

/** Foundation fallback: declared realtime routes close with a stable code. */
function notConfiguredWs(op: OperationDef): (socket: WsWebSocket, req: FastifyRequest) => void {
  return (socket, req) => {
    req.log.info({ operationId: op.id }, 'websocket route not configured; closing');
    socket.close(4501, 'not_configured');
  };
}
