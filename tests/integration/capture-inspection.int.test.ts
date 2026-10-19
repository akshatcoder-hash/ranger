import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApiServer } from '../../src/http/app.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { latestFrameCache } from '../../src/capture/frames.js';
import { setVisionTransportForTests } from '../../src/capture/runtime.js';
import type { VisionTransport } from '../../src/capture/vision.js';

/**
 * Real HTTP capture/inspection against a FAKE vision transport
 * (deterministic; the live paid dial is a separate budgeted check). Covers
 * atomic frame validation, decoded-over-declared dimensions, freshness,
 * late-result rejection after capture end, foreign-project isolation and
 * the unsupported retained-media capability.
 */

const APP_PORT = 3908;

const tempDirs: string[] = [];
let app: FastifyInstance;
let db: DatabaseSync;
let dataDir: string;
let bearer: Record<string, string>;
let projectId: string;
let otherProjectId: string;

/** Fake vision transport: records calls, scripted observations/delays. */
const visionCalls: Array<{ model: string; prompt: string; imageBytes: number }> = [];
let visionScript: Array<{ delayMs?: number; observations: Array<{ text: string; uncertainty: number }> }> = [];

const fakeVision: VisionTransport = {
  async inspect(input) {
    visionCalls.push({ model: input.model, prompt: input.prompt, imageBytes: Buffer.byteLength(input.imageBase64, 'base64') });
    const step = visionScript.shift() ?? { observations: [{ text: 'synthetic screen observed', uncertainty: 0.2 }] };
    if (step.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    return { observations: step.observations, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
  },
};

async function api(method: 'GET' | 'POST', url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.inject({
    method,
    url,
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    headers: headers ?? bearer,
  });
  return { status: res.statusCode, json: res.json() as Record<string, unknown> };
}

async function pngBase64(width: number, height: number): Promise<string> {
  return (await sharp({ create: { width, height, channels: 3, background: { r: 30, g: 60, b: 90 } } }).png().toBuffer()).toString('base64');
}

let captureId: string;
async function startCapture(): Promise<string> {
  const out = await api('POST', `/v1/projects/${projectId}/capture/sessions`, {});
  expect(out.status).toBe(200);
  return (out.json.session as { sessionId: string }).sessionId;
}

async function ingest(sessionId: string, input: { frameId: string; imageBase64: string; captureTimestamp?: string; declaredWidth?: number; declaredHeight?: number }): Promise<{ status: number; json: Record<string, unknown> }> {
  return api('POST', `/v1/projects/${projectId}/capture/sessions/${sessionId}/frames`, {
    captureTimestamp: new Date().toISOString(),
    declaredWidth: 123,
    declaredHeight: 456,
    ...input,
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-capture-'));
  tempDirs.push(dataDir);
  const config = await loadConfig({ RANGER_DATA_DIR: dataDir, RANGER_LOG_LEVEL: 'error' } as NodeJS.ProcessEnv);
  db = openDatabase(dataDir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Capture Owner' });
  bearer = { authorization: `Bearer ${readFileSync(owner.credentialPath, 'utf8').trim().split('=')[1]}` };
  projectId = createProjectRecord(db, { name: 'Capture', engineerDisplayName: 'Ranger', principalId: owner.principalId }).id;
  otherProjectId = createProjectRecord(db, { name: 'Capture Other', engineerDisplayName: 'Ranger', principalId: owner.principalId }).id;
  app = await buildApiServer({ config, db });
  await app.listen({ host: '127.0.0.1', port: APP_PORT });
  setVisionTransportForTests(() => fakeVision);
});

afterEach(() => {
  visionScript = [];
  visionCalls.length = 0;
  if (captureId !== undefined) {
    latestFrameCache.clear(captureId);
    captureId = '';
  }
});

afterAll(async () => {
  setVisionTransportForTests(null);
  await app.close();
  db.close();
  const dir = tempDirs.pop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe('frame ingestion validation', () => {
  it('accepts a valid frame and trusts DECODED dimensions over client declarations', async () => {
    captureId = await startCapture();
    const out = await ingest(captureId, { frameId: 'good-1', imageBase64: await pngBase64(200, 120) });
    expect(out.status).toBe(200);
    const frame = out.json.frame as { frameId: string; width: number; height: number; generation: number; stored: boolean };
    expect(frame.frameId).toBe('good-1');
    expect(frame.width).toBe(200);
    expect(frame.height).toBe(120);
    expect(frame.stored).toBe(true);
  });

  it('rejects oversize, wrong-format, undecodable and out-of-dimension frames with distinct reasons', async () => {
    captureId = await startCapture();
    const oversize = await ingest(captureId, { frameId: 'big', imageBase64: Buffer.alloc(6.5 * 1024 * 1024).toString('base64') });
    expect(oversize.status).toBe(400);
    expect((oversize.json.error as { details: { reason: string } }).details.reason).toBe('frame_too_large');

    const wrongFormat = await ingest(captureId, { frameId: 'webp', imageBase64: Buffer.from('RIFF-not-an-image').toString('base64') });
    expect((wrongFormat.json.error as { details: { reason: string } }).details.reason).toBe('unsupported_format');

    const junk = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    junk.writeUInt32LE(0xdeadbeef, 16);
    const undecodable = await ingest(captureId, { frameId: 'junk', imageBase64: junk.toString('base64') });
    expect((undecodable.json.error as { details: { reason: string } }).details.reason).toBe('undecodable');

    const tiny = await ingest(captureId, { frameId: 'tiny', imageBase64: await pngBase64(4, 4) });
    expect((tiny.json.error as { details: { reason: string } }).details.reason).toBe('dimension_out_of_range');
    expect(latestFrameCache.get(captureId)).toBeNull();
  });

  it('rejects duplicate frame ids, stale and future timestamps with distinct reasons', async () => {
    captureId = await startCapture();
    const first = await ingest(captureId, { frameId: 'dup-target', imageBase64: await pngBase64(64, 64) });
    expect(first.status).toBe(200);
    const duplicate = await ingest(captureId, { frameId: 'dup-target', imageBase64: await pngBase64(64, 64) });
    expect((duplicate.json.error as { details: { reason: string } }).details.reason).toBe('duplicate_frame_id');
    const stale = await ingest(captureId, { frameId: 'stale', imageBase64: await pngBase64(64, 64), captureTimestamp: new Date(Date.now() - 10 * 60_000).toISOString() });
    expect((stale.json.error as { details: { reason: string } }).details.reason).toBe('stale_timestamp');
    const future = await ingest(captureId, { frameId: 'future', imageBase64: await pngBase64(64, 64), captureTimestamp: new Date(Date.now() + 10 * 60_000).toISOString() });
    expect((future.json.error as { details: { reason: string } }).details.reason).toBe('future_timestamp');
  });

  it('an out-of-order frame never replaces the newer current observation and the drop is observable', async () => {
    captureId = await startCapture();
    await ingest(captureId, { frameId: 'newer', imageBase64: await pngBase64(64, 64) });
    const older = await ingest(captureId, { frameId: 'older', imageBase64: await pngBase64(64, 64), captureTimestamp: new Date(Date.now() - 5_000).toISOString() });
    expect(older.status).toBe(409);
    expect((older.json.error as { details: { reason: string } }).details.reason).toBe('out_of_order_frame');
    expect(latestFrameCache.get(captureId)?.frameId).toBe('newer');
    const events = await api('GET', `/v1/projects/${projectId}/events?limit=200`).then((o) => o.json.events as Array<{ type: string; data: Record<string, unknown> }>);
    const drop = events.find((event) => event.type === 'capture.frame.dropped' && event.data.frameId === 'older');
    expect(drop).toBeDefined();
  });

  it('a foreign-project session id is not found even for the same principal', async () => {
    captureId = await startCapture();
    const foreign = await api('POST', `/v1/projects/${otherProjectId}/capture/sessions/${captureId}/frames`, {
      frameId: 'foreign',
      imageBase64: await pngBase64(64, 64),
      captureTimestamp: new Date().toISOString(),
    });
    expect(foreign.status).toBe(404);
  });
});

describe('on-demand inspection', () => {
  it('with no frame it requests a fresh frame and performs NO provider dial', async () => {
    captureId = await startCapture();
    const out = await api('POST', `/v1/projects/${projectId}/capture/sessions/${captureId}/inspection`, {});
    expect(out.status).toBe(200);
    expect(out.json.inspection).toMatchObject({ state: 'fresh-frame-requested', freshness: 'absent', sourceFrameId: null });
    expect(visionCalls.length).toBe(0);
  });

  it('with a fresh frame it returns structured observations with source frame and time', async () => {
    captureId = await startCapture();
    await ingest(captureId, { frameId: 'inspect-me', imageBase64: await pngBase64(160, 90) });
    const callsBefore = visionCalls.length;
    const out = await api('POST', `/v1/projects/${projectId}/capture/sessions/${captureId}/inspection`, { prompt: 'find the build error' });
    expect(out.status).toBe(200);
    const inspection = out.json.inspection as {
      state: string;
      observations: Array<{ text: string; uncertainty: number; sourceFrameId: string; sourceTimestamp: string }>;
      sourceFrameId: string;
      freshness: string;
    };
    expect(inspection.state).toBe('observed');
    expect(inspection.freshness).toBe('current');
    expect(inspection.sourceFrameId).toBe('inspect-me');
    expect(inspection.observations.length).toBeGreaterThan(0);
    expect(inspection.observations[0]?.uncertainty).toBeGreaterThanOrEqual(0);
    expect(inspection.observations[0]?.uncertainty).toBeLessThanOrEqual(1);
    expect(inspection.observations[0]?.sourceFrameId).toBe('inspect-me');
    // The fake transport saw the configured vision model and the image.
    expect(visionCalls.length).toBe(callsBefore + 1);
    expect(visionCalls[visionCalls.length - 1]?.model).toBe('grok-4.3');
    expect(visionCalls[visionCalls.length - 1]?.imageBytes).toBeGreaterThan(0);
    const events = await api('GET', `/v1/projects/${projectId}/events?limit=200`).then((o) => o.json.events as Array<{ type: string }>);
    expect(events.some((event) => event.type === 'capture.inspection.completed')).toBe(true);
  });

  it('a stale frame requests a fresh frame instead of a guessed observation', async () => {
    captureId = await startCapture();
    await ingest(captureId, { frameId: 'stale-frame', imageBase64: await pngBase64(64, 64), captureTimestamp: new Date(Date.now() - 60_000).toISOString() });
    const out = await api('POST', `/v1/projects/${projectId}/capture/sessions/${captureId}/inspection`, { freshnessMaxAgeMs: 5000 });
    expect(out.status).toBe(200);
    expect(out.json.inspection).toMatchObject({ state: 'fresh-frame-requested', freshness: 'stale', sourceFrameId: 'stale-frame' });
    expect(visionCalls.length).toBe(0);
  });

  it('ending capture discards an in-flight result: no observation is applied', async () => {
    captureId = await startCapture();
    await ingest(captureId, { frameId: 'in-flight', imageBase64: await pngBase64(64, 64) });
    visionScript = [{ delayMs: 300, observations: [{ text: 'late observation', uncertainty: 0.1 }] }];
    const pending = api('POST', `/v1/projects/${projectId}/capture/sessions/${captureId}/inspection`, {});
    // The dial must be IN FLIGHT (started) before the capture ends.
    const deadline = Date.now() + 5000;
    while (visionCalls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const end = await api('POST', `/v1/projects/${projectId}/capture/sessions/${captureId}/end`);
    expect(end.status).toBe(200);
    expect((end.json.session as { state: string }).state).toBe('ended');
    const out = await pending;
    expect(out.status).toBe(409);
    expect((out.json.error as { details: { reason: string } }).details.reason).toBe('capture_ended');
    const events = await api('GET', `/v1/projects/${projectId}/events?limit=200`).then((o) => o.json.events as Array<{ type: string; data: Record<string, unknown> }>);
    expect(events.some((event) => event.type === 'capture.inspection.rejected-stale' && event.data.reason === 'capture_ended')).toBe(true);
    // The in-memory bytes are cleared with the capture end.
    expect(latestFrameCache.get(captureId)).toBeNull();
  });

  it('a post-end upload is rejected and retained media is explicitly unsupported', async () => {
    captureId = await startCapture();
    await ingest(captureId, { frameId: 'before-end', imageBase64: await pngBase64(64, 64) });
    const end = await api('POST', `/v1/projects/${projectId}/capture/sessions/${captureId}/end`);
    expect(end.status).toBe(200);
    const late = await ingest(captureId, { frameId: 'after-end', imageBase64: await pngBase64(64, 64) });
    expect(late.status).toBe(409);
    expect((late.json.error as { details: { reason: string } }).details.reason).toBe('capture_ended');
    const retain = await api('POST', `/v1/projects/${projectId}/capture/retained-evidence`, { sessionId: captureId, kind: 'frames', expiryMs: 60_000 });
    expect(retain.status).toBe(501);
    expect(retain.json.error).toMatchObject({ code: 'unsupported_operation' });
    const list = await api('GET', `/v1/projects/${projectId}/capture/retained-evidence`);
    expect(list.status).toBe(200);
    expect(list.json.evidence).toEqual([]);
  });

  it('metadata persists without raw bytes (no recording)', async () => {
    captureId = await startCapture();
    await ingest(captureId, { frameId: 'meta-only', imageBase64: await pngBase64(64, 64) });
    const row = db.prepare('SELECT frame_id, width, height FROM capture_frame_metadata WHERE frame_id = ?').get('meta-only') as { frame_id: string; width: number; height: number };
    expect(row.frame_id).toBe('meta-only');
    expect(row.width).toBe(64);
    // The metadata table has no byte column: raw frames cannot persist there.
    const columns = (db.prepare("PRAGMA table_info('capture_frame_metadata')").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns.some((name) => name.includes('bytes') || name.includes('blob') || name.includes('data'))).toBe(false);
  });
});
