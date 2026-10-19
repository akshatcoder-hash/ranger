import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { openDatabase, withTransaction } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApiServer } from '../../src/http/app.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { createConversationRow } from '../../src/conversations/store.js';
import { createPlanVersionRow, approvePlanVersionRow } from '../../src/plans/store.js';
import { readLedger } from '../../src/budget/ledger.js';
import { ENGINEERING_RUN_TOOL } from '../../src/voice/tools.js';

/**
 * LIVE xAI media evidence (opt-in; not part of npm test).
 *
 * Requires RANGER_LIVE_MEDIA=1 plus RANGER_SECRET_FILE and
 * RANGER_LIVE_BUDGET_FILE. ONE short synthetic audio/text/tool voice session
 * and ONE synthetic-image vision inspection against the REAL xAI provider,
 * sharing the mission budget: reserve before dial, settle once, no hidden
 * retry, no fallback model. Evidence records statuses, counts, model ids and
 * usage numbers only — never keys, bearer URLs, tickets or raw audio.
 */

const enabled = process.env['RANGER_LIVE_MEDIA'] === '1';
const describeLive = enabled ? describe : describe.skip;

const API_PORT = 3975;
const BASE = `http://127.0.0.1:${API_PORT}`;

interface FrameSummary {
  type: string;
}

function pcmToneChunks(): string[] {
  const sampleRate = 24000;
  const chunkSamples = 2400; // 100ms
  const chunks: string[] = [];
  for (let start = 0; start < sampleRate * 2; start += chunkSamples) {
    const buf = new ArrayBuffer(chunkSamples * 2);
    const view = new DataView(buf);
    for (let i = 0; i < chunkSamples; i += 1) {
      view.setInt16(i * 2, Math.round(Math.sin(2 * Math.PI * 440 * ((start + i) / sampleRate)) * 8000), true);
    }
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let b = 0; b < bytes.length; b += 1) bin += String.fromCharCode(bytes[b]!);
    chunks.push(Buffer.from(bin, 'binary').toString('base64'));
  }
  return chunks;
}

describeLive('live xAI voice relay and vision (shared budget, one session each)', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-live-media-'));
  let app: FastifyInstance;
  let db: DatabaseSync;
  let bearer: Record<string, string>;
  let projectId = '';
  let conversationId = '';
  let approvalId = '';
  const ledgerBefore = { observedUsd: 0, operations: 0 };

  async function api(method: 'GET' | 'POST', url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      headers: { ...bearer, ...(headers ?? {}) },
    });
    return { status: res.statusCode, json: res.json() as Record<string, unknown> };
  }

  beforeAll(async () => {
    const config = await loadConfig({ ...process.env, RANGER_DATA_DIR: dataDir, RANGER_PORT: String(API_PORT), RANGER_LOG_LEVEL: 'warn' } as NodeJS.ProcessEnv);
    db = openDatabase(dataDir);
    runMigrations(db, path.join(process.cwd(), 'migrations'));
    const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Live Media' });
    bearer = { authorization: `Bearer ${readFileSync(owner.credentialPath, 'utf8').trim().split('=')[1]}` };
    projectId = createProjectRecord(db, { name: 'Live Media', engineerDisplayName: 'Ranger', principalId: owner.principalId }).id;
    conversationId = createConversationRow(db, projectId, 'Live media conversation').id;
    withTransaction(db, () => {
      const plan = createPlanVersionRow(db, projectId, {
        items: ['synthetic live fixture item'],
        acceptanceCriteria: ['synthetic acceptance criterion'],
        permittedScope: ['command'],
      }, 'req-live-media');
      approvalId = approvePlanVersionRow(db, projectId, plan.plan.id, { permittedScope: ['command'], approvedBy: owner.principalId }, 'req-live-media').approval.id;
    });
    const ledger = readLedger(config.liveBudgetFile!);
    ledgerBefore.observedUsd = ledger.xai.observedUsd;
    ledgerBefore.operations = ledger.xai.operations.length;
    app = await buildApiServer({ config, db });
    await app.listen({ host: '127.0.0.1', port: API_PORT });
  });

  afterAll(async () => {
    await app.close();
    // Let relay socket-close handlers finish against the still-open DB.
    await new Promise((resolve) => setTimeout(resolve, 50));
    db.close();
    const config = await loadConfig({ ...process.env, RANGER_DATA_DIR: dataDir } as NodeJS.ProcessEnv);
    const after = readLedger(config.liveBudgetFile!);
    const delta = Math.round((after.xai.observedUsd - ledgerBefore.observedUsd) * 10000) / 10000;
    console.log(`LIVE_MEDIA_EVIDENCE ${JSON.stringify({
      ledger: { observedBeforeUsd: ledgerBefore.observedUsd, observedAfterUsd: after.xai.observedUsd, deltaUsd: delta, model: 'grok-voice-3.0/grok-4.3' },
    })}`);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('relays synthetic audio, a text turn and one engineering function call to the real xAI realtime provider', async () => {
    const started = await api('POST', `/v1/projects/${projectId}/voice/sessions`, { conversationId });
    expect(started.status).toBe(200);
    const session = started.json.session as { sessionId: string; model: string; expiresAt: string };
    expect(session.model).toBe('grok-voice-3.0');

    const ticket = await api('POST', '/v1/auth/connection-tickets', { projectId, purpose: 'voice-relay', origin: BASE });
    expect(ticket.status).toBe(200);

    const clientFrames: FrameSummary[] = [];
    const notablePayloads: string[] = [];
    const socket = new WebSocket(
      `${BASE.replace('http', 'ws')}/v1/projects/${projectId}/voice/sessions/${session.sessionId}/relay?ticket=${encodeURIComponent(ticket.json.ticket as string)}`,
      { headers: { origin: BASE } },
    );
    socket.on('open', () => {
      // Provider-documented session config (client-side): explicit
      // instructions to call the engineering tool, reasoning disabled for
      // latency, server VAD. The relay's own server-side declaration of the
      // one tool is authority; this repeats it because partial session
      // updates may reset omitted fields.
      socket.send(JSON.stringify({
        type: 'session.update',
        session: {
          instructions:
            'You are Ranger, a forward-deployed engineering agent on a live voice call. ' +
            `When the customer asks to start engineering work, call the request_engineering_run tool IMMEDIATELY with the approvalId they provide (${approvalId}). ` +
            'Do not ask questions and do not merely describe the call: make it.',
          reasoning: { effort: 'none' },
          turn_detection: { type: 'server_vad' },
          tools: [ENGINEERING_RUN_TOOL],
          tool_choice: 'required',
        },
      }));
      // Synthetic PCM first (transport evidence), committed manually (the
      // provider session echoes turn_detection null), then the text turn
      // that asks for the one engineering function call.
      for (const audio of pcmToneChunks().slice(0, 10)) {
        socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
      }
      socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      socket.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `Start the approved run now: call request_engineering_run with approvalId ${approvalId}.` }],
        },
      }));
      socket.send(JSON.stringify({ type: 'response.create' }));
    });
    socket.on('message', (data) => {
      const raw = data.toString();
      try {
        const frame = JSON.parse(raw) as Record<string, unknown>;
        const type = String(frame['type'] ?? 'unknown');
        clientFrames.push({ type });
        // Keep bounded payloads of every frame that is not raw audio: these
        // carry the diagnostic story (errors, session config, item shapes).
        if (!type.startsWith('response.audio') && !type.startsWith('response.text')) {
          notablePayloads.push(raw.slice(0, 2000));
        }
      } catch {
        // A non-JSON frame is counted as unknown.
        clientFrames.push({ type: 'unknown' });
      }
    });

    // The relay validates the provider's function call server-side and
    // enqueues the durable run; the run's existence is the observable
    // outcome (the raw function-call frame is handled, not relayed).
    let runId: string | null = null;
    const runDeadline = Date.now() + 90_000;
    try {
      for (;;) {
        if (Date.now() > runDeadline) throw new Error('no engineering run enqueued within 90s');
        const runs = await api('GET', `/v1/projects/${projectId}/runs`);
        const active = (runs.json.runs as Array<{ id?: string; runId?: string; state: string }>)
          .filter((run) => run.state === 'queued' || run.state === 'running' || run.state === 'cancelled')
          .map((run) => run.id ?? run.runId ?? '')
          .filter((id): id is string => id !== '');
        if (active.length > 0) {
          runId = active[0]!;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (cause) {
      for (const payload of notablePayloads) console.log(`LIVE_VOICE_FRAME ${payload}`);
      throw cause;
    }
    expect(runId).toMatch(/^run_/);
    console.log(`LIVE_VOICE_RUN ${runId}`);

    // Frame-kind summary only (no audio content in evidence).
    const kinds: Record<string, number> = {};
    for (const frame of clientFrames) kinds[frame.type] = (kinds[frame.type] ?? 0) + 1;
    console.log(`LIVE_VOICE_FRAMES ${JSON.stringify(kinds)}`);

    // End the session; usage counters persist (observed transport volume).
    const ended = await api('POST', `/v1/projects/${projectId}/voice/sessions/${session.sessionId}/end`);
    expect(ended.status).toBe(200);
    expect((ended.json.session as { state: string }).state).toBe('ended');
    const usage = await api('GET', `/v1/projects/${projectId}/voice/sessions/${session.sessionId}`);
    console.log(`LIVE_VOICE_USAGE ${JSON.stringify(usage.json.usage)}`);
    expect((usage.json.usage as { toolCalls: number }).toolCalls).toBeGreaterThanOrEqual(1);
    // One explicit clean end; a second end returns the same terminal state.
    const again = await api('POST', `/v1/projects/${projectId}/voice/sessions/${session.sessionId}/end`);
    expect(again.status).toBe(200);
    // Cancel the enqueued run so the vision/budget checks start clean.
    if (runId !== null) {
      await api('POST', `/v1/projects/${projectId}/runs/${runId}/cancel`, {}, { ...bearer, 'idempotency-key': `live-voice-cancel-${runId}` });
    }
    socket.close();
  });

  it('inspects one synthetic image through the real separate xAI vision endpoint', async () => {
    const capture = await api('POST', `/v1/projects/${projectId}/capture/sessions`, { conversationId });
    expect(capture.status).toBe(200);
    const captureId = (capture.json.session as { sessionId: string }).sessionId;

    const canvas = sharp({ create: { width: 480, height: 320, channels: 3, background: { r: 20, g: 40, b: 80 } } });
    const image = await canvas
      .composite([{
        input: Buffer.from(
          `<svg width="480" height="320"><rect width="480" height="320" fill="#14283c"/><text x="24" y="150" font-size="28" fill="#ffffff" font-family="monospace">RANGER LIVE VISION CHECK</text><text x="24" y="200" font-size="22" fill="#9fd28f" font-family="monospace">code 7391</text></svg>`,
        ),
        top: 0,
        left: 0,
      }])
      .png()
      .toBuffer();

    const ingested = await api('POST', `/v1/projects/${projectId}/capture/sessions/${captureId}/frames`, {
      frameId: `live-${Date.now()}`,
      imageBase64: image.toString('base64'),
      captureTimestamp: new Date().toISOString(),
      declaredWidth: 1,
      declaredHeight: 1,
    });
    expect(ingested.status).toBe(200);

    const inspected = await api('POST', `/v1/projects/${projectId}/capture/sessions/${captureId}/inspection`, {
      prompt: 'Read the visible text in this synthetic screen image.',
    });
    console.log(`LIVE_VISION_STATUS ${inspected.status}`);
    if (inspected.status === 200) {
      const inspection = inspected.json.inspection as {
        state: string;
        observations: Array<{ text: string; uncertainty: number; sourceFrameId: string; sourceTimestamp: string }>;
        freshness: string;
        sourceFrameId: string | null;
      };
      console.log(`LIVE_VISION_INSPECTION ${JSON.stringify({
        state: inspection.state,
        freshness: inspection.freshness,
        observationCount: inspection.observations.length,
        uncertainties: inspection.observations.map((o) => o.uncertainty),
        sourceFrameId: inspection.sourceFrameId,
      })}`);
      expect(inspection.state).toBe('observed');
      expect(inspection.observations.length).toBeGreaterThan(0);
      expect(inspection.observations[0]?.sourceFrameId).toMatch(/^live-/);
      expect(inspection.observations[0]?.uncertainty).toBeGreaterThanOrEqual(0);
    } else {
      // Honest failure surface: no retry, no fallback. The error is safe.
      console.log(`LIVE_VISION_ERROR ${JSON.stringify(inspected.json.error)}`);
      expect(inspected.status).toBe(200);
    }
    const ended = await api('POST', `/v1/projects/${projectId}/capture/sessions/${captureId}/end`);
    expect(ended.status).toBe(200);
  });

  it('opens a fresh live session after closing the real relay, with no replayed tools', async () => {
    // Session A: connect, then close the relay (client disconnect ends the
    // session terminally).
    const first = await api('POST', `/v1/projects/${projectId}/voice/sessions`, { conversationId });
    expect(first.status).toBe(200);
    const firstSession = (first.json.session as { sessionId: string }).sessionId;
    const firstTicket = await api('POST', '/v1/auth/connection-tickets', { projectId, purpose: 'voice-relay', origin: BASE });
    expect(firstTicket.status).toBe(200);
    const firstSocket = new WebSocket(
      `${BASE.replace('http', 'ws')}/v1/projects/${projectId}/voice/sessions/${firstSession}/relay?ticket=${encodeURIComponent(firstTicket.json.ticket as string)}`,
      { headers: { origin: BASE } },
    );
    await new Promise<void>((resolve, reject) => {
      firstSocket.on('open', () => resolve());
      firstSocket.on('error', reject);
    });
    firstSocket.close();

    // Session B: a FRESH ticket starts a FRESH live session. Nothing
    // reconstructs upstream state and no past tool executes.
    const second = await api('POST', `/v1/projects/${projectId}/voice/sessions`, { conversationId });
    expect(second.status).toBe(200);
    const secondSession = (second.json.session as { sessionId: string }).sessionId;
    expect(secondSession).not.toBe(firstSession);
    const secondTicket = await api('POST', '/v1/auth/connection-tickets', { projectId, purpose: 'voice-relay', origin: BASE });
    expect(secondTicket.status).toBe(200);
    const replayed: string[] = [];
    const secondSocket = new WebSocket(
      `${BASE.replace('http', 'ws')}/v1/projects/${projectId}/voice/sessions/${secondSession}/relay?ticket=${encodeURIComponent(secondTicket.json.ticket as string)}`,
      { headers: { origin: BASE } },
    );
    secondSocket.on('message', (data) => {
      replayed.push(data.toString());
    });
    await new Promise<void>((resolve, reject) => {
      secondSocket.on('open', () => resolve());
      secondSocket.on('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(replayed.some((raw) => raw.includes('session.created'))).toBe(true);
    expect(replayed.some((raw) => raw.includes('function_call_output'))).toBe(false);
    // A reconnect against the ENDED first session is refused (fresh ticket).
    const endedTicket = await api('POST', '/v1/auth/connection-tickets', { projectId, purpose: 'voice-relay', origin: BASE });
    const refused = await new Promise<{ code: number }>((resolve) => {
      const socket = new WebSocket(
        `${BASE.replace('http', 'ws')}/v1/projects/${projectId}/voice/sessions/${firstSession}/relay?ticket=${encodeURIComponent(endedTicket.json.ticket as string)}`,
        { headers: { origin: BASE } },
      );
      socket.on('close', (code) => resolve({ code }));
      socket.on('open', () => {
        socket.close();
      });
    });
    expect(refused.code).toBe(4409);
    secondSocket.close();
    await api('POST', `/v1/projects/${projectId}/voice/sessions/${secondSession}/end`);
  });

  it('stays within the conservative shared-budget increment for standalone media', async () => {
    const config = await loadConfig({ ...process.env, RANGER_DATA_DIR: dataDir } as NodeJS.ProcessEnv);
    const ledger = readLedger(config.liveBudgetFile!);
    const delta = Math.round((ledger.xai.observedUsd - ledgerBefore.observedUsd) * 10000) / 10000;
    expect(delta).toBeLessThanOrEqual(0.5);
    expect(ledger.xai.observedUsd).toBeLessThanOrEqual(ledger.xai.softAdmissionUsd);
  });
});
