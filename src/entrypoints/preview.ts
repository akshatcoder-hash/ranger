import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket as WsWebSocket } from 'ws';
import { loadConfig, type RangerConfig } from '../config.js';
import { openDatabase } from '../db/db.js';
import { runMigrations, migrationsDirFromCwd } from '../db/migrate.js';
import { Errors, isAppError, redact } from '../errors.js';
import { redactRequestUrl, secretSafeLoggerOptions } from '../http/safe-url.js';
import { consumeTicket } from '../auth/tickets.js';
import { membershipRole } from '../auth/authorization.js';
import { getDesktopSession, getPreviewSession, getWorkspace } from '../workspace/store.js';
import { FIXED_PREVIEW_PORTS, isFixedPreviewPort } from '../workspace/limits.js';
import { desktopStreamFor } from '../workspace/viewing.js';
import { installGracefulShutdown } from './lifecycle.js';

/**
 * Separate-origin preview gateway.
 *
 * Desktop stream and private app preview authenticate with a single-use
 * ticket plus current membership. Provider stream URLs stay server-side.
 * Arbitrary target URLs and non-fixed guest ports are rejected.
 */

const revokedViewers = new Set<string>();

export function markDesktopViewerRevoked(sessionId: string): void {
  revokedViewers.add(sessionId);
}

function sendError(reply: FastifyReply, req: FastifyRequest, status: number, code: string, message: string): void {
  void reply.code(status).send({
    requestId: req.id,
    error: { code, message: redact(message) },
  });
}

function ticketFrom(req: FastifyRequest): string {
  const query = req.query as { ticket?: string };
  if (typeof query.ticket !== 'string' || query.ticket.length === 0) {
    throw Errors.unauthorized('Connection ticket is required', { reason: 'ticket_missing' });
  }
  return query.ticket;
}

export async function buildPreviewApp(config: RangerConfig) {
  const db = openDatabase(config.dataDir);
  runMigrations(db, migrationsDirFromCwd());
  const app = Fastify({
    genReqId: () => randomUUID(),
    logger: secretSafeLoggerOptions(config.logLevel),
  });
  await app.register(websocket);

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/v1/projects/:projectId/desktop/sessions/:sessionId/view', async (req, reply) => {
    const params = req.params as { projectId: string; sessionId: string };
    const binding = consumeTicket(db, ticketFrom(req), {
      purpose: 'desktop-stream',
      projectId: params.projectId,
    });
    if (membershipRole(db, params.projectId, binding.principalId) === null) {
      throw Errors.forbidden('Not a member of this project');
    }
    const session = getDesktopSession(db, params.projectId, params.sessionId);
    if (session === null || session.state !== 'active' || session.revokedAt !== null || session.expiresAt < Date.now() || revokedViewers.has(params.sessionId)) {
      throw Errors.unauthorized('Desktop session is not active', { reason: 'desktop_inactive' });
    }
    const stream = desktopStreamFor(params.sessionId);
    if (stream === null || stream.expiresAtMs <= Date.now()) {
      throw Errors.unauthorized('Desktop stream is not available', { reason: 'desktop_stream_missing' });
    }
    const upstream = await fetch(stream.url);
    const raw = await upstream.text();
    const socketPath = `/v1/projects/${params.projectId}/desktop/sessions/${params.sessionId}/stream`;
    const body = raw
      .replaceAll(stream.url, socketPath)
      .replace(/https:\/\/dashboard\.instabox\.sh\/[^"'<\s]+/g, socketPath);
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    return reply.code(upstream.status).send(body);
  });

  app.get('/v1/projects/:projectId/desktop/sessions/:sessionId/stream', { websocket: true }, (socket: WsWebSocket, req: FastifyRequest) => {
    const params = req.params as { projectId: string; sessionId: string };
    try {
      const binding = consumeTicket(db, ticketFrom(req), {
        purpose: 'desktop-stream',
        projectId: params.projectId,
      });
      if (membershipRole(db, params.projectId, binding.principalId) === null) {
        socket.close(4401, 'unauthorized');
        return;
      }
      const session = getDesktopSession(db, params.projectId, params.sessionId);
      if (session === null || session.state !== 'active' || session.revokedAt !== null || session.expiresAt < Date.now()) {
        socket.close(4401, 'unauthorized');
        return;
      }
      if (revokedViewers.has(params.sessionId)) {
        socket.close(4401, 'unauthorized');
        return;
      }
      const workspace = getWorkspace(db, params.projectId);
      if (workspace === null || workspace.machineId === null || workspace.observedState !== 'running') {
        socket.close(4401, 'unauthorized');
        return;
      }
      const stream = desktopStreamFor(params.sessionId);
      if (stream === null || stream.expiresAtMs <= Date.now()) {
        socket.close(4401, 'unauthorized');
        return;
      }
      const upstream = new WebSocket(stream.url);
      const closeBoth = (code: number): void => {
        clearInterval(timer);
        try { upstream.close(); } catch { /* already closed */ }
        try { socket.close(code); } catch { /* already closed */ }
      };
      upstream.addEventListener('message', (event) => {
        if (socket.readyState === socket.OPEN) socket.send(event.data);
      });
      upstream.addEventListener('close', () => closeBoth(1000));
      socket.on('message', (data) => {
        if (upstream.readyState !== WebSocket.OPEN) return;
        const payload = Array.isArray(data) ? Buffer.concat(data) : data;
        upstream.send(payload);
      });
      const timer = setInterval(() => {
        const current = getDesktopSession(db, params.projectId, params.sessionId);
        const member = membershipRole(db, params.projectId, binding.principalId);
        if (current === null || current.state !== 'active' || current.revokedAt !== null || revokedViewers.has(params.sessionId) || member === null) {
          closeBoth(4401);
        }
      }, 1000);
      socket.on('close', () => closeBoth(1000));
    } catch {
      socket.close(4401, 'unauthorized');
    }
  });

  app.get('/v1/projects/:projectId/preview/sessions/:sessionId/app', async (req, reply) => {
    const params = req.params as { projectId: string; sessionId: string };
    const target = (req.query as { target?: string; url?: string }).target ?? (req.query as { url?: string }).url;
    if (target !== undefined) {
      throw Errors.validation('Arbitrary preview targets are rejected', { reason: 'preview_target_rejected' });
    }
    const binding = consumeTicket(db, ticketFrom(req), {
      purpose: 'app-preview',
      projectId: params.projectId,
    });
    if (membershipRole(db, params.projectId, binding.principalId) === null) {
      throw Errors.forbidden('Not a member of this project');
    }
    const session = getPreviewSession(db, params.projectId, params.sessionId);
    if (session === null || session.state !== 'active' || session.expiresAt < Date.now()) {
      throw Errors.unauthorized('Preview session is not active', { reason: 'preview_inactive' });
    }
    if (!isFixedPreviewPort(session.guestPort) || session.localPort === null) {
      throw Errors.validation('Preview port is not an authorized fixed target', {
        reason: 'preview_target_rejected',
        allowed: [...FIXED_PREVIEW_PORTS],
      });
    }
    const upstream = await fetch(`http://127.0.0.1:${session.localPort}/`);
    const body = Buffer.from(await upstream.arrayBuffer());
    reply.header('content-type', upstream.headers.get('content-type') ?? 'text/html');
    return reply.code(upstream.status).send(body);
  });

  app.all('*', async (req) => {
    throw Errors.notFound(`No preview route for ${redactRequestUrl(req.url)}`);
  });

  app.setErrorHandler((error, req, reply) => {
    if (isAppError(error)) {
      sendError(reply, req, error.httpStatus, error.code, error.message);
      return;
    }
    sendError(reply, req, 500, 'internal_error', 'Internal error');
  });

  return { app, db };
}

export async function main(): Promise<void> {
  const config = await loadConfig(process.env);
  const { app, db } = await buildPreviewApp(config);
  installGracefulShutdown('ranger preview', async () => {
    await app.close();
    db.close();
  });
  await app.listen({ host: config.host, port: config.previewPort });
  process.stdout.write(
    `{"msg":"ranger preview gateway listening","host":"${config.host}","port":${config.previewPort}}\n`,
  );
}

const entryArg = process.argv[1] ?? '';
const isDirect = entryArg.endsWith('/preview.js') || entryArg.endsWith('/preview.ts');
if (isDirect) {
  main().catch((cause) => {
    process.stderr.write(`{"msg":"ranger preview failed to start","err":${JSON.stringify(String(cause))}}\n`);
    process.exit(1);
  });
}
