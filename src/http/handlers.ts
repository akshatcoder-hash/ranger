import { existsSync } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { RangerConfig } from '../config.js';
import { buildOpenApiDocument } from '../contracts/openapi.js';
import { eventSchemaBundle } from '../contracts/events.js';
import { declaredEventTypes } from '../contracts/registry.js';
import type { SecretResolver } from '../secrets.js';

/**
 * Operation handlers.
 *
 * The foundation registers the real handlers that exist today (health,
 * capabilities, event schemas, OpenAPI document). Every other declared route
 * falls through to the explicit notConfigured handler: the contract is fully
 * enumerated, but unimplemented providers report a stable capability error
 * instead of pretending success.
 */

export type OperationHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;

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
      detail: 'Trace sibling repository and model cache detected; pin verification and MCP runtime arrive with the Trace milestone',
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

export function buildHandlerMap(context: HandlerContext): Map<string, OperationHandler> {
  const handlers = new Map<string, OperationHandler>();

  handlers.set('getHealth', async () => ({ status: 'ok' }));

  handlers.set('getCapabilities', async () => {
    const present = new Set(context.secrets.presentNames());
    return {
      contractVersion: 'v1',
      providers: {
        xai: {
          configured: present.has('XAI_API_KEY'),
          detail: present.has('XAI_API_KEY')
            ? 'Key selected from the protected file into process memory only'
            : 'No XAI_API_KEY in the configured secret file',
        },
        instabox: {
          configured: present.has('INSTABOX_API_KEY'),
          detail: present.has('INSTABOX_API_KEY')
            ? 'Key selected from the protected file into process memory only'
            : 'No INSTABOX_API_KEY in the configured secret file',
        },
        trace: traceStatus(context.config),
      },
      adapters: {
        instabox: { kind: 'vm', available: false },
        trustedFixture: { kind: 'container', available: false },
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

  return handlers;
}

export { notConfiguredHandler };
