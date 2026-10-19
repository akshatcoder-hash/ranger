import type { FastifyRequest } from 'fastify';
import { requireMembership, requirePrincipalId } from '../auth/authorization.js';
import { withTransaction } from '../db/db.js';
import { withIdempotentMutation, requestHash, idempotencyKeyFrom } from './idempotency.js';
import { iso } from './serialize.js';
import { appendProjectEvent } from '../events/store.js';
import { Errors, isAppError } from '../errors.js';
import {
  createCaptureSessionRow,
  endCaptureSessionRow,
  getCaptureSessionRow,
  type CaptureSessionRow,
} from '../capture/store.js';
import {
  clearFrameRateWindow,
  decodeAndAcceptFrame,
  latestFrameCache,
  validateFrameEnvelope,
} from '../capture/frames.js';
import { VISION_MAX_IMAGE_BYTES } from '../capture/vision.js';
import { inspectCaptureFrame } from '../capture/inspection.js';
import type { HandlerContext, OperationHandler } from './handlers.js';

/**
 * Capture family handlers: capture-session lifecycle, latest-frame
 * ingestion and the separate on-demand xAI vision inspection.
 *
 * - Exactly ONE validated latest frame per session is held in memory; raw
 *   bytes never persist and are cleared on capture end.
 * - Ingestion validates identity, format, byte bound, decoded dimensions,
 *   timestamp skew, upload rate and frame order atomically; every drop is
 *   visible as a `capture.frame.dropped` event.
 * - Ending capture invalidates the generation, rejects later frames,
 *   discards in-flight results and clears the in-memory bytes.
 * - Inspection is a SEPARATE paid dial (never the voice channel), budgeted
 *   like every other provider call (reserve → dial → settle once), returns
 *   structured observations with uncertainty and source frame/time, and
 *   never grants machine control. Explicit evidence retention is an
 *   unsupported capability: there are no recordings and no retained media.
 */

function captureSessionPayload(row: CaptureSessionRow): Record<string, unknown> {
  return {
    sessionId: row.id,
    projectId: row.projectId,
    state: row.state,
    generation: row.generation,
    createdAt: iso(row.createdAt),
    endedAt: row.endedAt !== null ? iso(row.endedAt) : null,
  };
}

export function registerCaptureHandlers(ctx: HandlerContext, handlers: Map<string, OperationHandler>): void {
  const { db, config } = ctx;

  const authorize = (req: FastifyRequest): string => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId?: string };
    if (params.projectId === undefined) throw Errors.validation('projectId is required');
    requireMembership(db, params.projectId, principalId);
    return params.projectId;
  };

  handlers.set('startCaptureSession', async (req) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string };
    requireMembership(db, params.projectId, principalId);
    const body = (req.body ?? {}) as { conversationId?: unknown };
    const session = withIdempotentMutation(db, {
      scope: `startCaptureSession:${params.projectId}:${principalId}`,
      key: idempotencyKeyFrom(req),
      requestHash: requestHash({ params, body }),
      execute: () => {
        const row = createCaptureSessionRow(db, {
          projectId: params.projectId,
          conversationId: typeof body.conversationId === 'string' ? body.conversationId : undefined,
        });
        appendProjectEvent(db, {
          projectId: params.projectId,
          sessionId: row.id,
          type: 'capture.session.started',
          data: { sessionId: row.id, ...(row.conversationId !== null ? { conversationId: row.conversationId } : {}) },
          requestId: req.id,
        });
        return row;
      },
    }).result;
    return { session: captureSessionPayload(session) };
  });

  handlers.set('getCaptureSession', async (req) => {
    const projectId = authorize(req);
    const params = req.params as { sessionId: string };
    const session = getCaptureSessionRow(db, projectId, params.sessionId);
    if (session === null) throw Errors.notFound('Capture session not found in this project');
    return { session: captureSessionPayload(session) };
  });

  handlers.set('endCaptureSession', async (req) => {
    const projectId = authorize(req);
    const params = req.params as { sessionId: string };
    const session = withIdempotentMutation(db, {
      scope: `endCaptureSession:${projectId}:${req.principalId ?? 'unauthenticated'}`,
      key: idempotencyKeyFrom(req),
      requestHash: requestHash({ params }),
      execute: () => {
        const before = getCaptureSessionRow(db, projectId, params.sessionId);
        const after = endCaptureSessionRow(db, projectId, params.sessionId);
        if (before !== null && before.state === 'active') {
          appendProjectEvent(db, {
            projectId,
            sessionId: after.id,
            type: 'capture.session.ended',
            data: { sessionId: after.id, generation: after.generation, reason: 'client_requested' },
            requestId: req.id,
          });
        }
        return after;
      },
    }).result;
    // Clear the in-memory latest frame bytes and the rate window AFTER the
    // durable end commits. Late frames are rejected by the ended state and
    // late inspection results by the advanced generation.
    latestFrameCache.clear(params.sessionId);
    clearFrameRateWindow(params.sessionId);
    return { session: captureSessionPayload(session) };
  });

  handlers.set('ingestCaptureFrame', async (req) => {
    const projectId = authorize(req);
    const params = req.params as { sessionId: string };
    const body = (req.body ?? {}) as {
      frameId?: unknown;
      imageBase64?: unknown;
      captureTimestamp?: unknown;
      declaredWidth?: unknown;
      declaredHeight?: unknown;
    };
    if (typeof body.frameId !== 'string' || body.frameId === '') throw Errors.validation('frameId is required');
    if (typeof body.imageBase64 !== 'string') throw Errors.validation('imageBase64 is required');
    if (typeof body.captureTimestamp !== 'string') throw Errors.validation('captureTimestamp is required');
    const captureTimestampMs = Date.parse(body.captureTimestamp);
    if (!Number.isFinite(captureTimestampMs)) throw Errors.validation('captureTimestamp must be an ISO timestamp');
    // Client-declared dimensions are never trusted over decoded ones; they
    // are accepted (schema-validated) and then ignored.
    void body.declaredWidth;
    void body.declaredHeight;

    const session = getCaptureSessionRow(db, projectId, params.sessionId);
    if (session === null) throw Errors.notFound('Capture session not found in this project');
    if (session.state !== 'active') {
      throw Errors.conflict('The capture session has ended; later frames are rejected', { reason: 'capture_ended' });
    }

    const envelope = validateFrameEnvelope({
      sessionId: params.sessionId,
      frameId: body.frameId,
      imageBase64: body.imageBase64,
      captureTimestampMs,
      maxFrameBytes: Math.min(config.limits.maxFrameBytes, VISION_MAX_IMAGE_BYTES),
    });
    let accepted;
    try {
      accepted = await decodeAndAcceptFrame(db, {
        projectId,
        sessionId: params.sessionId,
        frameId: body.frameId,
        bytes: envelope.bytes,
        mimeType: envelope.mimeType,
        captureTimestampMs,
        requestId: req.id,
        onEvent: (type, data) => {
          appendProjectEvent(db, {
            projectId,
            sessionId: params.sessionId,
            type,
            data,
            requestId: req.id,
          });
        },
      });
    } catch (cause) {
      // A dropped frame stays observable even though its accept transaction
      // rolled back: append the drop event separately, then rethrow.
      if (isAppError(cause) && cause.details?.['reason'] === 'out_of_order_frame') {
        withTransaction(db, () => {
          appendProjectEvent(db, {
            projectId,
            sessionId: params.sessionId,
            type: 'capture.frame.dropped',
            data: {
              sessionId: params.sessionId,
              frameId: body.frameId as string,
              reason: 'out_of_order_frame',
              currentFrameId: (cause.details?.['currentFrameId'] as string | null) ?? null,
            },
            requestId: req.id,
          });
        });
      }
      throw cause;
    }
    // Only NOW does the validated frame become the current observation.
    latestFrameCache.set({
      sessionId: params.sessionId,
      generation: accepted.generation,
      frameId: accepted.frameId,
      byteSize: accepted.byteSize,
      width: accepted.width,
      height: accepted.height,
      captureTimestamp: accepted.captureTimestamp,
      storedAt: Date.now(),
      mimeType: accepted.mimeType,
      bytes: accepted.bytes,
    });
    return {
      frame: {
        frameId: accepted.frameId,
        sessionId: params.sessionId,
        generation: accepted.generation,
        byteSize: accepted.byteSize,
        width: accepted.width,
        height: accepted.height,
        captureTimestamp: iso(accepted.captureTimestamp),
        stored: true,
      },
    };
  });

  handlers.set('requestInspection', async (req) => {
    const projectId = authorize(req);
    const params = req.params as { sessionId: string };
    const body = (req.body ?? {}) as { prompt?: string; freshnessMaxAgeMs?: number };
    return inspectCaptureFrame(ctx, {
      projectId,
      principalId: requirePrincipalId(req),
      sessionId: params.sessionId,
      requestId: req.id,
      prompt: body.prompt,
      freshnessMaxAgeMs: body.freshnessMaxAgeMs,
      idempotencyKey: idempotencyKeyFrom(req),
    });
  });

  handlers.set('listRetainedEvidence', async (req) => {
    authorize(req);
    // No recordings and no retained media exist; the list is honestly empty.
    return { evidence: [], nextCursor: null };
  });

  handlers.set('retainEvidence', async (req) => {
    authorize(req);
    throw Errors.unsupported(
      'Retained media evidence is not a supported capability: raw audio and frames are never recorded',
      { reason: 'retained_media_unsupported' },
    );
  });
}

// isAppError is referenced by callers of the family tests; keep the import
// honest by using it in the error-mapping helper below.
export function inspectionErrorCode(cause: unknown): string {
  return isAppError(cause) ? cause.code : 'internal_error';
}
