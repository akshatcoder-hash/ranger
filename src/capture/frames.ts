import sharp from 'sharp';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db/db.js';
import { Errors } from '../errors.js';
import {
  getCaptureSessionRow,
  getFrameMetadata,
  insertFrameMetadata,
} from './store.js';

/**
 * Latest-frame ingestion validation (VAL-MEDIA-007/008/009).
 *
 * One validated screenshot per capture session is held IN MEMORY; raw bytes
 * are never persisted and there is no queue, scheduler, perceptual pipeline
 * or retained recording. Validation is ATOMIC (identity, format, size,
 * decoded dimensions, timestamp, rate, order): a rejected frame never
 * replaces the current observation, and an older/out-of-order frame never
 * becomes current. Every drop is observable as a `capture.frame.dropped`
 * event naming the affected frame id.
 */

/** Client-declared dimensions are never trusted over decoded ones. */
export const FRAME_DIMENSION_MIN = 16;
export const FRAME_DIMENSION_MAX = 8192;
/** Documented clock-skew window for the client capture timestamp. */
export const FRAME_TIMESTAMP_SKEW_MS = 120_000;
/** Per-session upload-rate bound (sliding window). */
export const FRAME_RATE_LIMIT = 5;
export const FRAME_RATE_WINDOW_MS = 1_000;
/** Global in-memory bound: at most this many sessions hold one frame each. */
export const MAX_CACHED_SESSIONS = 8;

export type SupportedImageFormat = 'image/jpeg' | 'image/png';

export interface LatestFrame {
  sessionId: string;
  generation: number;
  frameId: string;
  byteSize: number;
  width: number;
  height: number;
  captureTimestamp: number;
  storedAt: number;
  mimeType: SupportedImageFormat;
  /** Raw bytes of the single latest validated frame; cleared on capture end. */
  bytes: Buffer;
}

/** The bounded in-memory latest-frame slot per capture session. */
export class LatestFrameCache {
  private readonly frames = new Map<string, LatestFrame>();

  get(sessionId: string): LatestFrame | null {
    return this.frames.get(sessionId) ?? null;
  }

  has(sessionId: string): boolean {
    return this.frames.has(sessionId);
  }

  set(frame: LatestFrame): void {
    // One frame per session; global FIFO eviction keeps total memory bounded.
    this.frames.delete(frame.sessionId);
    this.frames.set(frame.sessionId, frame);
    while (this.frames.size > MAX_CACHED_SESSIONS) {
      const oldest = this.frames.keys().next().value;
      if (oldest === undefined) break;
      this.frames.delete(oldest);
    }
  }

  clear(sessionId: string): void {
    this.frames.delete(sessionId);
  }
}

/** Process-wide cache: the API process owns the in-memory latest frames. */
export const latestFrameCache = new LatestFrameCache();

/** Per-session upload-rate sliding window (bounded per session). */
const rateWindows = new Map<string, number[]>();

function detectMimeType(bytes: Buffer): SupportedImageFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  return null;
}

export function frameValidationError(
  reason: string,
  message: string,
  extra?: Record<string, unknown>,
): ReturnType<typeof Errors.validation> {
  return Errors.validation(message, { reason, ...extra });
}

/**
 * Pre-decode validation: identity fields, base64, byte bound, magic bytes,
 * timestamp skew and the per-session upload rate. Throws stable errors.
 */
export function validateFrameEnvelope(input: {
  sessionId: string;
  frameId: string;
  imageBase64: string;
  captureTimestampMs: number;
  maxFrameBytes: number;
}): { bytes: Buffer; mimeType: SupportedImageFormat } {
  if (input.frameId.length > 200) {
    throw frameValidationError('frame_id_invalid', 'frameId is limited to 200 characters');
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.imageBase64, 'base64');
    // node:crypto-free validity check: round-trip comparison rejects mixed
    // alphabets and whitespace that a lenient decoder would otherwise accept.
    if (bytes.length === 0 || bytes.toString('base64').replace(/=+$/, '') !== input.imageBase64.replace(/=+$/, '')) {
      throw new Error('invalid base64');
    }
  } catch {
    throw frameValidationError('frame_encoding_invalid', 'imageBase64 must be valid base64');
  }
  if (bytes.length > input.maxFrameBytes) {
    throw frameValidationError('frame_too_large', 'Frame exceeded the documented byte bound', {
      maxFrameBytes: input.maxFrameBytes,
    });
  }
  const mimeType = detectMimeType(bytes);
  if (mimeType === null) {
    throw frameValidationError('unsupported_format', 'Only JPEG and PNG frames are accepted');
  }
  const now = Date.now();
  if (input.captureTimestampMs < now - FRAME_TIMESTAMP_SKEW_MS) {
    throw frameValidationError('stale_timestamp', 'captureTimestamp is older than the documented skew window');
  }
  if (input.captureTimestampMs > now + FRAME_TIMESTAMP_SKEW_MS) {
    throw frameValidationError('future_timestamp', 'captureTimestamp is ahead of the documented skew window');
  }
  const window = rateWindows.get(input.sessionId) ?? [];
  const fresh = window.filter((ts) => ts > now - FRAME_RATE_WINDOW_MS);
  if (fresh.length >= FRAME_RATE_LIMIT) {
    const retryAfterMs = fresh[0]! + FRAME_RATE_WINDOW_MS - now;
    throw Errors.rateLimited('Capture upload rate exceeded; retry after the documented window', {
      reason: 'upload_rate',
      retryAfterMs: Math.max(1, retryAfterMs),
    });
  }
  fresh.push(now);
  rateWindows.set(input.sessionId, fresh.length > FRAME_RATE_LIMIT * 4 ? fresh.slice(-FRAME_RATE_LIMIT * 4) : fresh);
  return { bytes, mimeType };
}

/** Drop the rate window when a capture session ends. */
export function clearFrameRateWindow(sessionId: string): void {
  rateWindows.delete(sessionId);
}

export interface AcceptedFrame extends Omit<LatestFrame, 'bytes' | 'sessionId' | 'storedAt'> {
  bytes: Buffer;
  replacedFrameId: string | null;
}

/**
 * Decode the frame with sharp (real dimensions, real decodability) and run
 * the transactional accept: generation, duplicate and order checks against
 * the CURRENT capture state, so a racing end or a newer frame can never be
 * overwritten by a late arrival. On success the caller must set the cache.
 */
export async function decodeAndAcceptFrame(
  db: DatabaseSync,
  input: {
    projectId: string;
    sessionId: string;
    frameId: string;
    bytes: Buffer;
    mimeType: SupportedImageFormat;
    captureTimestampMs: number;
    requestId: string;
    onEvent: (type: string, data: Record<string, unknown>) => void;
  },
): Promise<AcceptedFrame> {
  let width: number | undefined;
  let height: number | undefined;
  let format: string | undefined;
  try {
    const pipeline = sharp(input.bytes);
    const metadata = await pipeline.metadata();
    width = metadata.width;
    height = metadata.height;
    format = metadata.format;
    // Force a full decode: header-only parsing would accept truncated data.
    await sharp(input.bytes).stats();
  } catch {
    throw frameValidationError('undecodable', 'The frame could not be decoded');
  }
  if (format !== undefined && format !== 'jpeg' && format !== 'png') {
    throw frameValidationError('unsupported_format', 'Only JPEG and PNG frames are accepted');
  }
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    width < FRAME_DIMENSION_MIN ||
    height < FRAME_DIMENSION_MIN ||
    width > FRAME_DIMENSION_MAX ||
    height > FRAME_DIMENSION_MAX
  ) {
    throw frameValidationError('dimension_out_of_range', 'Decoded frame dimensions are outside the documented bounds', {
      minWidth: FRAME_DIMENSION_MIN,
      maxWidth: FRAME_DIMENSION_MAX,
    });
  }

  // Transactional accept: all identity/order checks against CURRENT state.
  return withTransaction(db, () => {
    const session = getCaptureSessionRow(db, input.projectId, input.sessionId);
    if (session === null) throw Errors.notFound('Capture session not found in this project');
    if (session.state !== 'active') {
      throw Errors.conflict('The capture session has ended; later frames are rejected', { reason: 'capture_ended' });
    }
    if (getFrameMetadata(db, input.sessionId, input.frameId) !== null) {
      throw Errors.conflict('The frame id was already ingested for this session', { reason: 'duplicate_frame_id' });
    }
    const current = latestFrameCache.get(input.sessionId);
    if (current !== null && input.captureTimestampMs <= current.captureTimestamp) {
      // An older/out-of-order frame NEVER replaces the newer current frame.
      // The drop event is appended by the CALLER after this transaction
      // rolls back (an event inside a rolled-back transaction is lost).
      throw Errors.conflict('An older or out-of-order frame cannot replace the current observation', {
        reason: 'out_of_order_frame',
        currentFrameId: current.frameId,
      });
    }
    insertFrameMetadata(db, {
      id: `cfm_${randomFrameId()}`,
      sessionId: input.sessionId,
      generation: session.generation,
      frameId: input.frameId,
      byteSize: input.bytes.length,
      width,
      height,
      captureTimestamp: input.captureTimestampMs,
      createdAt: Date.now(),
    });
    input.onEvent('capture.frame.ingested', {
      sessionId: input.sessionId,
      generation: session.generation,
      frameId: input.frameId,
      byteSize: input.bytes.length,
      width,
      height,
      captureTimestamp: new Date(input.captureTimestampMs).toISOString(),
      replacedFrameId: current?.frameId ?? null,
    });
    return {
      frameId: input.frameId,
      generation: session.generation,
      byteSize: input.bytes.length,
      width,
      height,
      captureTimestamp: input.captureTimestampMs,
      mimeType: input.mimeType,
      bytes: input.bytes,
      replacedFrameId: current?.frameId ?? null,
    };
  });
}


function randomFrameId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
