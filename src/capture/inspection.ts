import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { requireMembership } from '../auth/authorization.js';
import { appendProjectEvent } from '../events/store.js';
import { Errors } from '../errors.js';
import { withIdempotentMutation, requestHash } from '../http/idempotency.js';
import { iso } from '../http/serialize.js';
import type { HandlerContext } from '../http/handlers.js';
import { getCaptureSessionRow } from './store.js';
import { latestFrameCache } from './frames.js';
import { visionTransportForTests } from './runtime.js';
import { XaiVisionTransport, type VisionCallResult } from './vision.js';
import { reserveXaiSpend, releaseXaiReservation, observeXaiSpend } from '../budget/ledger.js';
import { costFromUsage } from '../agent/pricing.js';

const INSPECTION_RESERVE_USD = 0.05;
const INSPECTION_FEATURE = 'lean-voice-latest-frame:inspection';
const DEFAULT_FRESHNESS_MAX_AGE_MS = 30_000;

type InspectionResult =
  | { rejected: 'capture_ended' }
  | { rejected: null; payload: { inspection: Record<string, unknown> } };
const pendingByDatabase = new WeakMap<DatabaseSync, Map<string, { hash: string; result: Promise<InspectionResult> }>>();

/** One budgeted snapshot inspection shared by HTTP and voice, bound to authorized project access. */
export async function inspectCaptureFrame(ctx: HandlerContext, input: {
  projectId: string;
  principalId: string;
  sessionId: string;
  requestId: string;
  prompt?: string;
  freshnessMaxAgeMs?: number;
  idempotencyKey?: string;
}): Promise<{ inspection: Record<string, unknown> }> {
  const { db } = ctx;
  const { projectId, principalId, sessionId } = input;
  requireMembership(db, projectId, principalId);
  const session = getCaptureSessionRow(db, projectId, sessionId);
  if (session === null) throw Errors.notFound('Capture session not found in this project');
  if (session.state !== 'active') throw Errors.conflict('The capture session has ended; inspection is refused', { reason: 'capture_ended' });
  const scope = `requestInspection:${projectId}:${principalId}`;
  const key = input.idempotencyKey;
  const hash = requestHash({ params: { sessionId }, body: { prompt: input.prompt, freshnessMaxAgeMs: input.freshnessMaxAgeMs } });
  const stored = key === undefined ? undefined : db.prepare(
    'SELECT request_hash, response_body FROM idempotency_records WHERE scope = ? AND idempotency_key = ?',
  ).get(scope, key) as { request_hash: string; response_body: string } | undefined;
  let result: InspectionResult;
  if (stored !== undefined) {
    if (stored.request_hash !== hash) throw Errors.conflict('Idempotency key was already used with a different request', { reason: 'idempotency_key_reuse' });
    result = JSON.parse(stored.response_body) as InspectionResult;
  } else {
    let pending = pendingByDatabase.get(db);
    if (pending === undefined) { pending = new Map(); pendingByDatabase.set(db, pending); }
    const pendingKey = key === undefined ? null : `${scope}:${key}`;
    const existing = pendingKey === null ? undefined : pending.get(pendingKey);
    if (existing !== undefined) {
      if (existing.hash !== hash) throw Errors.conflict('Idempotency key is already in flight with a different request', { reason: 'idempotency_key_reuse' });
      result = await existing.result;
    } else {
      if (pending.size >= ctx.config.limits.maxVisionConcurrency) throw Errors.rateLimited('Screen inspection is busy. Try again shortly.', { reason: 'vision_busy' });
      const operationKey = pendingKey ?? randomUUID();
      const operation = performInspection(ctx, input, { scope, key, hash });
      pending.set(operationKey, { hash, result: operation });
      try { result = await operation; } finally { pending.delete(operationKey); }
    }
  }
  if (result.rejected !== null) throw Errors.conflict('The inspection result was discarded: the capture state changed while it ran', { reason: result.rejected });
  return result.payload;
}

async function performInspection(
  ctx: HandlerContext,
  input: Parameters<typeof inspectCaptureFrame>[1],
  idempotency: { scope: string; key: string | undefined; hash: string },
): Promise<InspectionResult> {
  const { db, config, secrets } = ctx;
  const { projectId, sessionId, requestId } = input;
  const { scope, key, hash } = idempotency;
  const prompt = input.prompt?.trim().slice(0, 4000) || 'Describe the current screen for the engineering conversation.';
  const freshnessMaxAgeMs = input.freshnessMaxAgeMs ?? DEFAULT_FRESHNESS_MAX_AGE_MS;
  const session = getCaptureSessionRow(db, projectId, sessionId);
  if (session === null) throw Errors.notFound('Capture session not found in this project');
  if (session.state !== 'active') {
    throw Errors.conflict('The capture session has ended; inspection is refused', { reason: 'capture_ended' });
  }

  // The latest VALIDATED in-memory frame is the only inspection source.
  const latest = latestFrameCache.get(sessionId);
  if (latest === null) {
    return { rejected: null, payload: {
      inspection: {
        state: 'fresh-frame-requested',
        observations: [],
        sourceFrameId: null,
        sourceTimestamp: null,
        freshness: 'absent',
      },
    } };
  }
  if (Date.now() - latest.captureTimestamp > freshnessMaxAgeMs) {
    // No guessed observation: ask the client for a fresh frame.
    return { rejected: null, payload: {
      inspection: {
        state: 'fresh-frame-requested',
        observations: [],
        sourceFrameId: latest.frameId,
        sourceTimestamp: iso(latest.captureTimestamp),
        freshness: 'stale',
      },
    } };
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
    } catch {
      release();
      throw Errors.conflict('The vision provider call failed; no retry is performed', {
        reason: 'vision_provider_failed',
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
    execute: (): InspectionResult => {
      // Late-result invalidation: the session must still be active with
      // the SAME generation. New uploads do not invalidate this timestamped snapshot.
      const current = getCaptureSessionRow(db, projectId, sessionId);
      const stillCurrent = latestFrameCache.get(sessionId);
      if (current === null || current.state !== 'active' || current.generation !== sourceGeneration) {
        appendProjectEvent(db, {
          projectId,
          sessionId,
          type: 'capture.inspection.rejected-stale',
          data: { sessionId, frameId: sourceFrameId, reason: 'capture_ended' },
          requestId,
        });
        // The rejected marker is stored as this call's idempotent result;
        // the caller converts it to the stable 409 AFTER the commit so the
        // rejection event survives.
        return { rejected: 'capture_ended' as const };
      }
      const observations = visionResult.observations.map((observation) => ({
        text: observation.text,
        uncertainty: observation.uncertainty,
        sourceFrameId,
        sourceTimestamp: iso(sourceTimestampMs),
      }));
      appendProjectEvent(db, {
        projectId,
        sessionId,
        type: 'capture.inspection.completed',
        data: { sessionId, frameId: sourceFrameId, observationCount: observations.length },
        requestId,
      });
      return {
        rejected: null,
        payload: {
          inspection: {
            state: 'observed',
            observations,
            sourceFrameId,
            sourceTimestamp: iso(sourceTimestampMs),
            freshness: stillCurrent?.frameId === sourceFrameId && Date.now() - sourceTimestampMs <= freshnessMaxAgeMs ? 'current' : 'stale',
          },
        } as { inspection: Record<string, unknown> },
      };
    },
  }).result;
  return result;
}
