import type { FastifyRequest } from 'fastify';
import { requireMembership, requirePrincipalId } from '../auth/authorization.js';
import { withTransaction } from '../db/db.js';
import { withIdempotentMutation, requestHash, idempotencyKeyFrom, peekIdempotentResult } from './idempotency.js';
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
import { visionTransportForTests } from '../capture/runtime.js';
import { XaiVisionTransport, VISION_MAX_IMAGE_BYTES, type VisionCallResult } from '../capture/vision.js';
import { reserveXaiSpend, releaseXaiReservation, observeXaiSpend } from '../budget/ledger.js';
import { costFromUsage } from '../agent/pricing.js';
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

const INSPECTION_RESERVE_USD = 0.05;
const INSPECTION_FEATURE = 'lean-voice-latest-frame:inspection';
const DEFAULT_FRESHNESS_MAX_AGE_MS = 30_000;

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
  const { db, config, secrets } = ctx;

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
    const body = (req.body ?? {}) as { prompt?: unknown; freshnessMaxAgeMs?: unknown };
    const prompt = typeof body.prompt === 'string' && body.prompt !== ''
      ? body.prompt.slice(0, 4000)
      : 'Describe the current screen for the engineering conversation.';
    const freshnessMaxAgeMs = typeof body.freshnessMaxAgeMs === 'number' ? body.freshnessMaxAgeMs : DEFAULT_FRESHNESS_MAX_AGE_MS;

    const session = getCaptureSessionRow(db, projectId, params.sessionId);
    if (session === null) throw Errors.notFound('Capture session not found in this project');
    if (session.state !== 'active') {
      throw Errors.conflict('The capture session has ended; inspection is refused', { reason: 'capture_ended' });
    }

    const scope = `requestInspection:${projectId}:${req.principalId ?? 'unauthenticated'}`;
    const hash = requestHash({ params, body });
    const key = idempotencyKeyFrom(req);
    const replayed = peekIdempotentResult<{ inspection: unknown }>(db, { scope, key, requestHash: hash });
    if (replayed !== undefined) return replayed;

    // The latest VALIDATED in-memory frame is the only inspection source.
    const latest = latestFrameCache.get(params.sessionId);
    if (latest === null) {
      return {
        inspection: {
          state: 'fresh-frame-requested',
          observations: [],
          sourceFrameId: null,
          sourceTimestamp: null,
          freshness: 'absent',
        },
      };
    }
    if (Date.now() - latest.captureTimestamp > freshnessMaxAgeMs) {
      // No guessed observation: ask the client for a fresh frame.
      return {
        inspection: {
          state: 'fresh-frame-requested',
          observations: [],
          sourceFrameId: latest.frameId,
          sourceTimestamp: iso(latest.captureTimestamp),
          freshness: 'stale',
        },
      };
    }

    // -- paid dial outside any transaction; never retried -------------------
    const sourceGeneration = latest.generation;
    const sourceFrameId = latest.frameId;
    const sourceTimestampMs = latest.captureTimestamp;
    const imageBase64 = latest.bytes.toString('base64');
    const mimeType = latest.mimeType;
    const injected = visionTransportForTests();
    const inspectInput = { model: config.providers.xaiVisionModel, imageBase64, mimeType, prompt };
    let reservationId: string | null = null;
    let visionResult: VisionCallResult;
    if (injected !== null) {
      // Deterministic fake: no ledger, no real dial.
      visionResult = await injected().inspect(inspectInput);
    } else {
      if (!secrets.isConfigured() || config.liveBudgetFile === null) {
        throw Errors.notConfigured('The vision provider is not configured for this process', { provider: 'xai' });
      }
      const apiKey = secrets.get('XAI_API_KEY');
      const admission = reserveXaiSpend(config.liveBudgetFile, {
        feature: INSPECTION_FEATURE,
        estimateUsd: INSPECTION_RESERVE_USD,
        model: inspectInput.model,
      });
      reservationId = admission.reservationId;
      const release = (): void => {
        if (reservationId === null || config.liveBudgetFile === null) return;
        try {
          releaseXaiReservation(config.liveBudgetFile, reservationId);
        } catch {
          // Idempotent by id.
        }
        reservationId = null;
      };
      const settle = (observedUsd: number, note: string): void => {
        if (reservationId === null || config.liveBudgetFile === null) return;
        observeXaiSpend(config.liveBudgetFile, { reservationId, observedUsd, note });
        reservationId = null;
      };
      let result;
      try {
        result = await new XaiVisionTransport(apiKey).inspect(inspectInput);
      } catch (cause) {
        release();
        throw Errors.conflict('The vision provider call failed; no retry is performed', {
          reason: 'vision_provider_failed',
          detail: String(cause instanceof Error ? cause.message : cause).slice(0, 300),
        });
      }
      if (result.usage === null) {
        settle(INSPECTION_RESERVE_USD, 'vision usage unobserved; settled at the conservative estimate');
        throw Errors.conflict('Vision provider usage could not be observed; paid work stopped', {
          reason: 'usage_unobserved',
        });
      }
      const cost = costFromUsage(inspectInput.model, result.usage);
      if (cost === null) {
        settle(INSPECTION_RESERVE_USD, 'vision model has no documented rate; settled at the conservative estimate');
        throw Errors.conflict('The vision model has no documented rate; paid work stopped', {
          reason: 'usage_rate_unknown',
        });
      }
      settle(cost, 'observed vision usage');
      visionResult = result;
    }

    const result = withIdempotentMutation(db, {
      scope,
      key,
      requestHash: hash,
      execute: () => {
        // Late-result invalidation: the session must still be active with
        // the SAME generation, and the source frame must still be current.
        const current = getCaptureSessionRow(db, projectId, params.sessionId);
        const stillCurrent = latestFrameCache.get(params.sessionId);
        if (current === null || current.state !== 'active' || current.generation !== sourceGeneration) {
          appendProjectEvent(db, {
            projectId,
            sessionId: params.sessionId,
            type: 'capture.inspection.rejected-stale',
            data: { sessionId: params.sessionId, frameId: sourceFrameId, reason: 'capture_ended' },
            requestId: req.id,
          });
          // The rejected marker is stored as this call's idempotent result;
          // the caller converts it to the stable 409 AFTER the commit so the
          // rejection event survives.
          return { rejected: 'capture_ended' as const };
        }
        if (stillCurrent === null || stillCurrent.frameId !== sourceFrameId) {
          appendProjectEvent(db, {
            projectId,
            sessionId: params.sessionId,
            type: 'capture.inspection.rejected-stale',
            data: { sessionId: params.sessionId, frameId: sourceFrameId, reason: 'superseded_frame' },
            requestId: req.id,
          });
          return { rejected: 'superseded_frame' as const };
        }
        const observations = visionResult.observations.map((observation) => ({
          text: observation.text,
          uncertainty: observation.uncertainty,
          sourceFrameId,
          sourceTimestamp: iso(sourceTimestampMs),
        }));
        appendProjectEvent(db, {
          projectId,
          sessionId: params.sessionId,
          type: 'capture.inspection.completed',
          data: { sessionId: params.sessionId, frameId: sourceFrameId, observationCount: observations.length },
          requestId: req.id,
        });
        return {
          rejected: null,
          payload: {
            inspection: {
              state: 'observed',
              observations,
              sourceFrameId,
              sourceTimestamp: iso(sourceTimestampMs),
              freshness: 'current',
            },
          } as { inspection: Record<string, unknown> },
        };
      },
    }).result;
    if (result.rejected !== null) {
      throw Errors.conflict('The inspection result was discarded: the capture state changed while it ran', {
        reason: result.rejected,
      });
    }
    return result.payload;
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
