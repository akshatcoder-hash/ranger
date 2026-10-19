import type { FastifyRequest } from 'fastify';
import type { WebSocket as WsWebSocket } from 'ws';
import { requireMembership, requirePrincipalId } from '../auth/authorization.js';
import { withIdempotentMutation, requestHash, idempotencyKeyFrom } from './idempotency.js';
import { iso } from './serialize.js';
import { appendProjectEvent } from '../events/store.js';
import { Errors } from '../errors.js';
import {
  createVoiceSessionRow,
  endVoiceSessionRow,
  getVoiceSessionRow,
} from '../voice/store.js';
import { handleVoiceRelayUpgrade, interruptVoiceResponse, endVoiceRelayForSession } from '../voice/relay.js';
import type { HandlerContext, OperationHandler, WsOperationHandler } from './handlers.js';
import type { VoiceSessionRow } from '../voice/store.js';

/**
 * Voice family handlers: explicit session start/get/end, the voice-only
 * response interruption, and the authenticated realtime relay WebSocket.
 *
 * Start binds one principal + project + conversation to a new session with
 * the PINNED provider model (an explicit different model is refused, never
 * silently substituted). End is terminal and idempotent: a second end
 * returns the same ended state with no provider effect. Interruption
 * flushes only the in-flight voice response — run cancellation stays the
 * separate runs-family control. The relay consumes a single-use
 * 'voice-relay' connection ticket per upgrade.
 */

function voiceSessionPayload(row: VoiceSessionRow): Record<string, unknown> {
  return {
    sessionId: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    state: row.state,
    model: row.model,
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
  };
}

export function registerVoiceHandlers(
  ctx: HandlerContext,
  handlers: Map<string, OperationHandler>,
  wsHandlers: Map<string, WsOperationHandler>,
): void {
  const { db, config } = ctx;

  const authorize = (req: FastifyRequest, sessionId: string): { projectId: string; principalId: string } => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId?: string };
    if (params.projectId === undefined) throw Errors.validation('projectId is required');
    requireMembership(db, params.projectId, principalId);
    const session = getVoiceSessionRow(db, params.projectId, sessionId);
    if (session === null) throw Errors.notFound('Voice session not found in this project');
    if (session.principalId !== principalId) {
      throw Errors.forbidden('The voice session belongs to another principal');
    }
    return { projectId: params.projectId, principalId };
  };

  handlers.set('startVoiceSession', async (req) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string };
    requireMembership(db, params.projectId, principalId);
    const body = (req.body ?? {}) as { conversationId?: unknown; model?: unknown };
    if (typeof body.conversationId !== 'string') throw Errors.validation('conversationId is required');
    let model = config.providers.xaiVoiceModel;
    if (body.model !== undefined) {
      if (typeof body.model !== 'string') throw Errors.validation('model must be a string');
      if (body.model !== config.providers.xaiVoiceModel) {
        // The persisted model/config id equals the configured value; a
        // different paid model is refused, never silently substituted.
        throw Errors.validation('model must match the configured provider voice model', {
          reason: 'model_not_configured',
          configuredModel: config.providers.xaiVoiceModel,
        });
      }
      model = body.model;
    }
    const session = withIdempotentMutation(db, {
      scope: `startVoiceSession:${params.projectId}:${principalId}`,
      key: idempotencyKeyFrom(req),
      requestHash: requestHash({ params, body }),
      execute: () => {
        const row = createVoiceSessionRow(db, {
          projectId: params.projectId,
          conversationId: body.conversationId as string,
          principalId,
          model,
        });
        appendProjectEvent(db, {
          projectId: params.projectId,
          sessionId: row.id,
          type: 'voice.session.started',
          data: { sessionId: row.id, conversationId: row.conversationId, model: row.model },
          requestId: req.id,
        });
        return row;
      },
    }).result;
    return { session: voiceSessionPayload(session) };
  });

  handlers.set('getVoiceSession', async (req) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string; sessionId: string };
    requireMembership(db, params.projectId, principalId);
    const session = getVoiceSessionRow(db, params.projectId, params.sessionId);
    if (session === null) throw Errors.notFound('Voice session not found in this project');
    return {
      session: voiceSessionPayload(session),
      usage: {
        audioSeconds: Math.round(session.audioSeconds * 1000) / 1000,
        textTokens: session.textTokens,
        toolCalls: session.toolCalls,
      },
    };
  });

  handlers.set('endVoiceSession', async (req) => {
    const { projectId } = authorize(req, (req.params as { sessionId: string }).sessionId);
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const params = req.params;
    const session = withIdempotentMutation(db, {
      scope: `endVoiceSession:${projectId}:${req.principalId ?? 'unauthenticated'}`,
      key: idempotencyKeyFrom(req),
      requestHash: requestHash({ params }),
      execute: () => {
        const before = getVoiceSessionRow(db, projectId, sessionId);
        const after = endVoiceSessionRow(db, projectId, sessionId, 'client_requested');
        if (before !== null && before.state === 'active') {
          appendProjectEvent(db, {
            projectId,
            sessionId,
            type: 'voice.session.ended',
            data: { sessionId, conversationId: after.conversationId, reason: 'client_requested' },
            requestId: req.id,
          });
          appendProjectEvent(db, {
            projectId,
            sessionId,
            type: 'voice.usage.recorded',
            data: {
              sessionId,
              audioSeconds: Math.round(after.audioSeconds * 1000) / 1000,
              textTokens: after.textTokens,
              toolCalls: after.toolCalls,
            },
            requestId: req.id,
          });
        }
        return after;
      },
    }).result;
    // Terminate any live relay for this session NOW: the provider
    // connection closes and the relay's own settlement runs while the
    // database is still open, not at an arbitrary later socket close.
    endVoiceRelayForSession(sessionId);
    return { session: voiceSessionPayload(session) };
  });

  handlers.set('cancelVoiceResponse', async (req) => {
    const { projectId } = authorize(req, (req.params as { sessionId: string }).sessionId);
    const sessionId = (req.params as { sessionId: string }).sessionId;
    // Voice output only: this NEVER cancels an engineering run — the run
    // cancel control is the separate runs-family route.
    const interrupted = interruptVoiceResponse(sessionId);
    void projectId;
    return { ok: true, ...(interrupted ? { interrupted: true } : {}) };
  });

  wsHandlers.set('relayVoiceSession', (socket: WsWebSocket, req: FastifyRequest) => {
    handleVoiceRelayUpgrade(socket, req, ctx);
  });
}
