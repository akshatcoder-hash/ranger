import { existsSync } from 'node:fs';
import type { WebSocket as WsWebSocket } from 'ws';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { RangerConfig } from '../config.js';
import { buildOpenApiDocument } from '../contracts/openapi.js';
import { eventSchemaBundle } from '../contracts/events.js';
import { declaredEventTypes } from '../contracts/registry.js';
import type { SecretResolver } from '../secrets.js';
import { registerIdentityHandlers } from './handlers-identity.js';
import { registerProjectHandlers } from './handlers-projects.js';
import { registerRepositoryHandlers } from './handlers-repositories.js';
import { registerConversationHandlers } from './handlers-conversations.js';
import { registerEventHandlers } from './handlers-events.js';
import { registerVoiceHandlers } from './handlers-voice.js';
import { registerCaptureHandlers } from './handlers-capture.js';
import { registerWorkspaceHandlers } from './handlers-workspace.js';
import { registerRetrievalHandlers } from './handlers-retrieval.js';
import { registerPlansHandlers } from './handlers-plans.js';
import { registerRunsHandlers } from './handlers-runs.js';

/**
 * Operation handlers.
 *
 * Implemented families register their real handlers here (credentials,
 * projects, repositories, conversations and events plus the foundation
 * health/capabilities/doc routes). Every other declared route falls through
 * to the explicit notConfigured handler: the contract is fully enumerated,
 * but unimplemented providers report a stable capability error instead of
 * pretending success.
 */

export type OperationHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;

/** Handler for a declared WebSocket route: receives the upgraded raw socket. */
export type WsOperationHandler = (socket: WsWebSocket, req: FastifyRequest) => void;

export interface HandlerContext {
  config: RangerConfig;
  db: DatabaseSync;
  secrets: SecretResolver;
}

function traceStatus(config: RangerConfig): { configured: boolean; detail: string } {
  const repoPresent = existsSync(config.providers.traceRoot);
  const homePresent = existsSync(config.providers.traceHome);
  if (repoPresent && homePresent) {
    return {
      configured: true,
      detail: 'Trace sibling repository and model cache detected; retrieval routes index project mirrors over the pinned MCP runtime',
    };
  }
  return {
    configured: false,
    detail: repoPresent ? 'Trace model cache not initialized' : 'Trace sibling repository not bootstrapped',
  };
}

function notConfiguredHandler(op: { id: string; family: string }): OperationHandler {
  return async () => {
    // Imported lazily to avoid a cycle with errors.ts at module init.
    const { Errors } = await import('../errors.js');
    throw Errors.notConfigured(
      `Operation ${op.id} is declared by the v1 contract but its provider is not implemented yet`,
      { operationId: op.id, family: op.family },
    );
  };
}

export interface HandlerMaps {
  /** HTTP operation handlers keyed by operationId. */
  http: Map<string, OperationHandler>;
  /** Handlers for declared WebSocket routes keyed by operationId. */
  ws: Map<string, WsOperationHandler>;
}

/**
 * All operation handlers. A ws operation without an entry in `ws` still
 * closes 4501 not_configured (foundation fallback).
 */
export function buildHandlerMaps(context: HandlerContext): HandlerMaps {
  const handlers = new Map<string, OperationHandler>();
  const wsHandlers = new Map<string, WsOperationHandler>();

  handlers.set('getHealth', async () => ({ status: 'ok' }));

  handlers.set('getCapabilities', async () => {
    const present = new Set(context.secrets.presentNames());
    return {
      contractVersion: 'v1',
      providers: {
        xai: {
          configured: present.has('XAI_API_KEY'),
          detail: present.has('XAI_API_KEY')
            ? 'Key selected from the configured source into process memory only'
            : 'No XAI_API_KEY in the configured secret source',
        },
        instabox: {
          configured: present.has('INSTABOX_API_KEY'),
          detail: present.has('INSTABOX_API_KEY')
            ? 'Key selected from the configured source into process memory only'
            : 'No INSTABOX_API_KEY in the configured secret source',
        },
        trace: traceStatus(context.config),
      },
      adapters: {
        instabox: {
          kind: 'vm',
          available: present.has('INSTABOX_API_KEY') && context.config.liveBudgetFile !== null,
        },
      },
      grounding: {
        atomOrbit: {
          enabled: context.config.grounding.atomOrbitEndpoint !== null,
          detail: 'Optional Atom/Orbit grounding interface is disabled until real endpoints and artifacts exist',
        },
      },
      limits: {
        maxConcurrentRuns: context.config.limits.maxConcurrentRuns,
        maxWorkerJobs: context.config.limits.maxWorkerJobs,
        maxFrameBytes: context.config.limits.maxFrameBytes,
        maxCaptureQueue: context.config.limits.maxCaptureQueue,
        maxVisionConcurrency: context.config.limits.maxVisionConcurrency,
      },
      eventTypes: declaredEventTypes(),
    };
  });

  handlers.set('getEventSchemas', async () => eventSchemaBundle());

  handlers.set('getOpenApiDocument', async () => buildOpenApiDocument());

  // Implemented route families (identity, projects, repositories,
  // conversations, events, voice relay, capture/inspection, workspace,
  // retrieval, plans/approvals, runs).
  registerIdentityHandlers(context, handlers);
  registerProjectHandlers(context, handlers);
  registerRepositoryHandlers(context, handlers);
  registerConversationHandlers(context, handlers);
  registerEventHandlers(context, handlers, wsHandlers);
  registerVoiceHandlers(context, handlers, wsHandlers);
  registerCaptureHandlers(context, handlers);
  registerWorkspaceHandlers(context, handlers);
  registerRetrievalHandlers(context, handlers);
  registerPlansHandlers(context, handlers);
  registerRunsHandlers(context, handlers);

  return { http: handlers, ws: wsHandlers };
}

export { notConfiguredHandler };
