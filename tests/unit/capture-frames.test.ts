import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';
import {
  clearFrameRateWindow,
  decodeAndAcceptFrame,
  FRAME_DIMENSION_MAX,
  FRAME_DIMENSION_MIN,
  latestFrameCache,
  validateFrameEnvelope,
} from '../../src/capture/frames.js';
import { createCaptureSessionRow, endCaptureSessionRow } from '../../src/capture/store.js';

/**
 * Deterministic latest-frame validation: every rejected class carries a
 * distinct stable reason and never replaces the current observation; a valid
 * frame becomes the single in-memory latest frame; ending capture rejects
 * later frames and clears bytes.
 */

const tempDirs: string[] = [];
let db: DatabaseSync;
let projectId: string;
let sessionId: string;

async function pngBytes(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
}

async function accept(input: { frameId: string; bytes: Buffer; captureTimestampMs?: number; mimeType?: 'image/png' | 'image/jpeg' }) {
  const accepted = await decodeAndAcceptFrame(db, {
    projectId,
    sessionId,
    frameId: input.frameId,
    bytes: input.bytes,
    mimeType: input.mimeType ?? 'image/png',
    captureTimestampMs: input.captureTimestampMs ?? Date.now(),
    requestId: 'req-frame',
    onEvent: () => undefined,
  });
  // The handler installs the accepted frame as the current observation.
  latestFrameCache.set({
    sessionId,
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
  return accepted;
}

/** One valid 1x1 PNG as base64 (envelope fixtures pass the magic check). */
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function rejectReason(run: () => Promise<unknown> | unknown): Promise<string> {
  try {
    await run();
  } catch (cause) {
    return (cause as { details?: { reason?: string } }).details?.reason ?? 'no_reason';
  }
  return 'accepted';
}

beforeEach(async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-frames-'));
  tempDirs.push(dataDir);
  db = openDatabase(dataDir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Frames Owner' });
  projectId = createProjectRecord(db, { name: 'Frames', engineerDisplayName: 'Ranger', principalId: owner.principalId }).id;
  sessionId = createCaptureSessionRow(db, { projectId }).id;
});

afterEach(() => {
  latestFrameCache.clear(sessionId);
  clearFrameRateWindow(sessionId);
  db.close();
  const dir = tempDirs.pop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe('frame envelope validation', () => {
  it('rejects oversize bytes without accepting a current frame', async () => {
    const reason = await rejectReason(() =>
      validateFrameEnvelope({
        sessionId,
        frameId: 'big',
        imageBase64: Buffer.alloc(9 * 1024 * 1024).toString('base64'),
        captureTimestampMs: Date.now(),
        maxFrameBytes: 8 * 1024 * 1024,
      }),
    );
    expect(reason).toBe('frame_too_large');
    expect(latestFrameCache.has(sessionId)).toBe(false);
  });

  it('rejects a wrong format (neither JPEG nor PNG magic)', async () => {
    const reason = await rejectReason(() =>
      validateFrameEnvelope({
        sessionId,
        frameId: 'webp',
        imageBase64: Buffer.from('RIFF-not-an-image-head').toString('base64'),
        captureTimestampMs: Date.now(),
        maxFrameBytes: 8 * 1024 * 1024,
      }),
    );
    expect(reason).toBe('unsupported_format');
  });

  it('rejects a stale timestamp older than the documented skew', async () => {
    const reason = await rejectReason(() =>
      validateFrameEnvelope({
        sessionId,
        frameId: 'old',
        imageBase64: TINY_PNG_BASE64,
        captureTimestampMs: Date.now() - 10 * 60_000,
        maxFrameBytes: 8 * 1024 * 1024,
      }),
    );
    expect(reason).toBe('stale_timestamp');
  });

  it('rejects a future timestamp beyond the documented skew', async () => {
    const reason = await rejectReason(() =>
      validateFrameEnvelope({
        sessionId,
        frameId: 'future',
        imageBase64: TINY_PNG_BASE64,
        captureTimestampMs: Date.now() + 10 * 60_000,
        maxFrameBytes: 8 * 1024 * 1024,
      }),
    );
    expect(reason).toBe('future_timestamp');
  });

  it('enforces the per-session upload rate with a retry hint', () => {
    for (let i = 0; i < 5; i += 1) {
      validateFrameEnvelope({
        sessionId,
        frameId: `rate-${i}`,
        imageBase64: TINY_PNG_BASE64,
        captureTimestampMs: Date.now(),
        maxFrameBytes: 8 * 1024 * 1024,
      });
    }
    let message = '';
    try {
      validateFrameEnvelope({
        sessionId,
        frameId: 'rate-6',
        imageBase64: TINY_PNG_BASE64,
        captureTimestampMs: Date.now(),
        maxFrameBytes: 8 * 1024 * 1024,
      });
    } catch (cause) {
      message = String((cause as { message?: string }).message);
      expect((cause as { details?: { reason?: string } }).details?.reason).toBe('upload_rate');
      expect(typeof (cause as { details?: { retryAfterMs?: number } }).details?.retryAfterMs).toBe('number');
    }
    expect(message).toMatch(/rate/i);
  });
});

describe('decoded frame acceptance', () => {
  it('accepts a valid frame with DECODED dimensions and becomes the single latest frame', async () => {
    const bytes = await pngBytes(64, 48);
    const accepted = await accept({ frameId: 'f1', bytes });
    expect(accepted.width).toBe(64);
    expect(accepted.height).toBe(48);
    const latest = latestFrameCache.get(sessionId)!;
    expect(latest.frameId).toBe('f1');
    expect(latest.width).toBe(64);
    expect(latest.height).toBe(48);
    expect(latest.bytes.length).toBe(bytes.length);
  });

  it('rejects an undecodable payload', async () => {
    const junk = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('garbage-not-a-real-image'),
    ]);
    const reason = await rejectReason(() => accept({ frameId: 'junk', bytes: junk }));
    expect(reason).toBe('undecodable');
    expect(latestFrameCache.has(sessionId)).toBe(false);
  });

  it('rejects decoded dimensions outside the bounds', async () => {
    const tiny = await pngBytes(4, 4);
    expect(await rejectReason(() => accept({ frameId: 'tiny', bytes: tiny }))).toBe('dimension_out_of_range');
    const huge = await pngBytes(FRAME_DIMENSION_MAX + 64, 64);
    expect(await rejectReason(() => accept({ frameId: 'huge', bytes: huge }))).toBe('dimension_out_of_range');
  });

  it('rejects a duplicate frame id', async () => {
    const bytes = await pngBytes(64, 48);
    await accept({ frameId: 'dup', bytes });
    expect(await rejectReason(() => accept({ frameId: 'dup', bytes }))).toBe('duplicate_frame_id');
  });

  it('an older frame never replaces the newer current observation', async () => {
    const bytes = await pngBytes(64, 48);
    await accept({ frameId: 'newer', bytes, captureTimestampMs: Date.now() });
    const reason = await rejectReason(() => accept({ frameId: 'older', bytes, captureTimestampMs: Date.now() - 5_000 }));
    expect(reason).toBe('out_of_order_frame');
    expect(latestFrameCache.get(sessionId)?.frameId).toBe('newer');
  });

  it('ending capture rejects later frames and clears the in-memory bytes', async () => {
    const bytes = await pngBytes(64, 48);
    await accept({ frameId: 'before-end', bytes });
    expect(latestFrameCache.has(sessionId)).toBe(true);
    const ended = endCaptureSessionRow(db, projectId, sessionId);
    expect(ended.state).toBe('ended');
    expect(ended.generation).toBe(2);
    latestFrameCache.clear(sessionId);
    expect(latestFrameCache.has(sessionId)).toBe(false);
    expect(await rejectReason(() => accept({ frameId: 'after-end', bytes }))).toBe('capture_ended');
  });

  it('a minimum-boundary frame at the documented minimum dimension is accepted', async () => {
    const bytes = await pngBytes(FRAME_DIMENSION_MIN, FRAME_DIMENSION_MIN);
    const accepted = await accept({ frameId: 'min-boundary', bytes });
    expect(accepted.width).toBe(FRAME_DIMENSION_MIN);
  });
});
