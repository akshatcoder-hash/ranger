import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import WebSocket, { type WebSocket as WsSocket } from 'ws';
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { openDatabase, withTransaction } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApiServer } from '../../src/http/app.js';
import { ensureInitialPrincipal, createAdditionalPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { createConversationRow } from '../../src/conversations/store.js';
import { createPlanVersionRow, approvePlanVersionRow } from '../../src/plans/store.js';
import { createTicket } from '../../src/auth/tickets.js';
import { setRealtimeProviderForTests } from '../../src/voice/runtime.js';

/**
 * Real local HTTP/WS relay against a local FAKE realtime provider
 * (deterministic protocol test, not live evidence). Covers ticket
 * authentication with zero provider dials, the audio/text/function relay
 * roundtrip, voice-only interruption (never a run cancel), provider
 * disconnect ending the session terminally, and a fresh ticket starting a
 * fresh session with no replayed tool execution.
 */

const APP_PORT = 3907;
const PROVIDER_PORT = 3921;
const BASE = `http://127.0.0.1:${APP_PORT}`;

interface FakeProviderState {
  connections: number;
  received: string[];
  clients: Set<WsSocket>;
  /** When set, the next inbound client frame triggers these frames back. */
  script: Array<() => string[]> | null;
  /** Artificial provider-open delay (exercises the relay's dial buffering). */
  openDelayMs: number;
}

const fake: FakeProviderState = { connections: 0, received: [], clients: new Set(), script: null, openDelayMs: 0 };
let providerServer: Server | null = null;

async function waitFor<T>(probe: () => T | null, timeoutMs = 5000, stepMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

async function relayConnect(sessionId: string, ticket: string): Promise<{ socket: WsSocket; closeEvent: Promise<{ code: number; reason: string }>; frames: string[] }> {
  const socket = new WebSocket(
    `${BASE.replace('http', 'ws')}/v1/projects/${encodeURIComponent(projectId)}/voice/sessions/${encodeURIComponent(sessionId)}/relay?ticket=${encodeURIComponent(ticket)}`,
    { headers: { origin: BASE } },
  );
  const frames: string[] = [];
  socket.on('message', (data) => {
    frames.push(data.toString());
  });
  const closeEvent = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', (cause) => reject(cause));
    socket.on('unexpected-response', (_req, res) => reject(new Error(`upgrade rejected: ${res.statusCode}`)));
  });
  return { socket, closeEvent, frames };
}

async function upgradeRejected(sessionId: string | null, ticket: string | undefined): Promise<{ code: number; firstFrame: Record<string, unknown> | null }> {
  const socket = new WebSocket(
    `${BASE.replace('http', 'ws')}/v1/projects/${encodeURIComponent(projectId)}/voice/sessions/${sessionId ?? 'vcs_missing'}/relay${ticket !== undefined ? `?ticket=${encodeURIComponent(ticket)}` : ''}`,
    { headers: { origin: BASE } },
  );
  let firstFrame: string | null = null;
  socket.on('message', (data) => {
    if (firstFrame === null) firstFrame = data.toString();
  });
  const close = await new Promise<{ code: number; reason: string }>((resolve) => {
    socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  return {
    code: close.code,
    firstFrame: firstFrame !== null ? (JSON.parse(firstFrame) as Record<string, unknown>) : null,
  };
}

const tempDirs: string[] = [];
let app: FastifyInstance;
let db: DatabaseSync;
let dataDir: string;
let bearer: Record<string, string>;
let projectId: string;
let conversationId: string;
let approvalId: string;
let secondBearer: Record<string, string>;
let ownerPrincipalId: string;

async function api(method: 'GET' | 'POST', url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.inject({
    method,
    url,
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    headers: headers ?? bearer,
  });
  return { status: res.statusCode, json: res.json() as Record<string, unknown> };
}

function voiceSessionStart(): Promise<string> {
  return api('POST', `/v1/projects/${projectId}/voice/sessions`, { conversationId }).then((out) => {
    expect(out.status).toBe(200);
    return (out.json.session as { sessionId: string }).sessionId;
  });
}

async function voiceTicket(): Promise<string> {
  const out = await api('POST', '/v1/auth/connection-tickets', { projectId, purpose: 'voice-relay', origin: BASE });
  expect(out.status).toBe(200);
  return out.json.ticket as string;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-voice-relay-'));
  tempDirs.push(dataDir);
  const config = await loadConfig({ RANGER_DATA_DIR: dataDir, RANGER_LOG_LEVEL: 'error' } as NodeJS.ProcessEnv);
  db = openDatabase(dataDir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Relay Owner' });
  const second = createAdditionalPrincipal(db, {
    repoRoot: process.cwd(),
    displayName: 'Relay Second',
    credentialPath: path.join(dataDir, 'second-credential.txt'),
  });
  ownerPrincipalId = owner.principalId;
  bearer = { authorization: `Bearer ${readFileSync(owner.credentialPath, 'utf8').trim().split('=')[1]}` };
  secondBearer = { authorization: `Bearer ${readFileSync(second.credentialPath, 'utf8').trim().split('=')[1]}` };

  projectId = createProjectRecord(db, { name: 'Relay', engineerDisplayName: 'Ranger', principalId: owner.principalId }).id;
  conversationId = createConversationRow(db, projectId, 'Relay conversation').id;
  withTransaction(db, () => {
    const plan = createPlanVersionRow(db, projectId, { items: ['item'], acceptanceCriteria: ['criterion'], permittedScope: ['command'] }, 'req-relay');
    approvalId = approvePlanVersionRow(db, projectId, plan.plan.id, { permittedScope: ['command'], approvedBy: owner.principalId }, 'req-relay').approval.id;
  });

  // Membership for the second principal (project B exists only for the
  // foreign-project rejection; the second principal is NOT a member here).
  app = await buildApiServer({ config, db });
  await app.listen({ host: '127.0.0.1', port: APP_PORT });

  // The FAKE realtime provider: a plain local WS server recording frames.
  const { WebSocketServer } = await import('ws');
  const wsServer = new WebSocketServer({ port: PROVIDER_PORT, host: '127.0.0.1' });
  providerServer = wsServer as unknown as Server;
  wsServer.on('connection', (socket, request) => {
    fake.connections += 1;
    fake.clients.add(socket);
    void request.headers.authorization; // recorded implicitly by the scan test
    socket.on('message', (data) => {
      fake.received.push(data.toString());
      for (const produce of fake.script ?? []) {
        for (const frame of produce()) socket.send(frame);
      }
    });
    socket.on('close', () => fake.clients.delete(socket));
  });

  setRealtimeProviderForTests(({ handlers }) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PROVIDER_PORT}`);
      socket.on('open', () => {
        if (fake.openDelayMs > 0) setTimeout(() => handlers.onOpen(), fake.openDelayMs);
        else handlers.onOpen();
      });
    socket.on('message', (data, isBinary) => {
      if (!isBinary) handlers.onMessage(data.toString());
    });
    socket.on('close', (code, reason) => handlers.onClose(code, reason.toString('utf8')));
    socket.on('error', () => handlers.onError('fake provider socket error'));
    return {
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
      get isOpen() {
        return socket.readyState === WebSocket.OPEN;
      },
    };
  });
});

afterEach(() => {
  fake.script = null;
  for (const client of [...fake.clients]) client.close();
  fake.clients.clear();
});

afterAll(async () => {
  setRealtimeProviderForTests(null);
  providerServer?.close();
  await app.close();
  db.close();
  const dir = tempDirs.pop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
});

describe('relay upgrade authentication (zero provider dials)', () => {
  it('rejects a missing ticket with 4401 before any provider dial', async () => {
    const sessionId = await voiceSessionStart();
    const result = await upgradeRejected(sessionId, undefined);
    expect(result.code).toBe(4401);
    expect(result.firstFrame?.['error']).toMatchObject({ code: 'unauthorized' });
    expect(fake.connections).toBe(0);
  });

  it('rejects an unknown session id with 4404 and no provider dial', async () => {
    // A VALID ticket consumed against a nonexistent (well-formed) session.
    const ticket = await voiceTicket();
    const result = await upgradeRejected('vcs_00000000-0000-4000-8000-000000000000', ticket);
    expect(result.code).toBe(4404);
    expect(fake.connections).toBe(0);
  });

  it('rejects a wrong-purpose ticket (events) with 4401 and no provider dial', async () => {
    const sessionId = await voiceSessionStart();
    const eventsTicket = await api('POST', '/v1/auth/connection-tickets', { projectId, purpose: 'events', origin: BASE }).then((o) => o.json.ticket as string);
    const result = await upgradeRejected(sessionId, eventsTicket);
    expect(result.code).toBe(4401);
    expect(fake.connections).toBe(0);
  });

  it('rejects a foreign-project ticket with 4401 and no provider dial', async () => {
    const sessionId = await voiceSessionStart();
    // A ticket for a DIFFERENT project the same principal owns.
    const foreignProject = createProjectRecord(db, { name: 'Foreign', engineerDisplayName: 'Ranger', principalId: ownerPrincipalId }).id;
    const foreignTicket = await api('POST', '/v1/auth/connection-tickets', { projectId: foreignProject, purpose: 'voice-relay', origin: BASE }).then((o) => o.json.ticket as string);
    const result = await upgradeRejected(sessionId, foreignTicket);
    expect(result.code).toBe(4401);
    expect(fake.connections).toBe(0);
  });

  it('rejects an expired ticket with 4401 and no provider dial', async () => {
    const sessionId = await voiceSessionStart();
    const credential = db.prepare('SELECT id FROM credentials WHERE revoked_at IS NULL LIMIT 1').get() as { id: string };
    const expired = withTransaction(db, () =>
      createTicket(db, {
        principalId: ownerPrincipalId,
        projectId,
        purpose: 'voice-relay',
        origin: BASE,
        credentialKind: 'api_token',
        credentialId: credential.id,
        ttlMs: 1,
      }),
    ).secret;
    await new Promise((resolve) => setTimeout(resolve, 15));
    const result = await upgradeRejected(sessionId, expired);
    expect(result.code).toBe(4401);
    expect(fake.connections).toBe(0);
  });

  it('rejects a reused (already-consumed) ticket with 4401 and no provider dial', async () => {
    const sessionId = await voiceSessionStart();
    const ticket = await voiceTicket();
    // Consume it once through an authorized upgrade, then close.
    const first = await relayConnect(sessionId, ticket);
    first.socket.close();
    await first.closeEvent;
    const second = await upgradeRejected(sessionId, ticket);
    expect(second.code).toBe(4401);
  });

  it('rejects a ticket whose principal does not own the session (second principal) with 4401', async () => {
    const sessionId = await voiceSessionStart();
    const ticket = await app
      .inject({ method: 'POST', url: '/v1/auth/connection-tickets', headers: secondBearer, payload: { projectId, purpose: 'voice-relay', origin: BASE } })
      .then((res) => {
        if (res.statusCode === 200) return (res.json() as { ticket: string }).ticket;
        return null;
      });
    if (ticket === null) {
      expect(ticket).toBeNull(); // the second principal is not a member: refused earlier
      return;
    }
    const result = await upgradeRejected(sessionId, ticket);
    expect(result.code).toBe(4401);
  });
});

describe('authorized relay roundtrip', () => {
  it('relays audio, text and a function call; the run enqueues durably with a prompt runId', async () => {
    fake.received.length = 0;
    const connectionsBefore = fake.connections;
    const sessionId = await voiceSessionStart();
    const ticket = await voiceTicket();
    const relay = await relayConnect(sessionId, ticket);
    await waitFor(() => (fake.connections === connectionsBefore + 1 ? true : null));
    await waitFor(() => (fake.received.some((raw) => raw.includes('session.update')) ? true : null));

    // Audio + text turn to the provider through the relay.
    const audio = Buffer.alloc(4800).toString('base64'); // 0.1s of silence
    for (let i = 0; i < 3; i += 1) {
      relay.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
    }
    relay.socket.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say relay-check' }] },
      }),
    );
    relay.socket.send(JSON.stringify({ type: 'response.create' }));
    await waitFor(() => (fake.received.filter((raw) => raw.includes('input_audio_buffer.append')).length >= 3 ? true : null));

    // Provider emits observed usage and the ONE engineering function call
    // (triggered by the next inbound client frame, as in the real protocol).
    fake.received.length = 0;
    fake.script = [
      () => [JSON.stringify({ type: 'response.done', usage: { input_tokens: 11, output_tokens: 7 } })],
      () => [
        JSON.stringify({
          type: 'response.function_call_arguments.done',
          call_id: 'call_roundtrip_1',
          name: 'request_engineering_run',
          arguments: JSON.stringify({ approvalId }),
        }),
      ],
    ];
    relay.socket.send(JSON.stringify({ type: 'response.create' }));
    const functionOutput = await waitFor(() => {
      const raw = fake.received.find((candidate) => candidate.includes('function_call_output'));
      return raw !== undefined ? (JSON.parse(raw) as { item: { call_id: string; output: string } }) : null;
    });
    expect(functionOutput.item.call_id).toBe('call_roundtrip_1');
    const parsed = JSON.parse(functionOutput.item.output) as { runId?: string };
    expect(parsed.runId).toMatch(/^run_/);
    const run = db.prepare('SELECT state FROM runs WHERE id = ?').get(parsed.runId!) as { state: string };
    expect(run.state).toBe('queued');

    // The client received the observed usage frame back.
    await waitFor(() => (relay.frames.some((raw) => raw.includes('response.done')) ? true : null));

    // Session counters reflect observed usage and the tool call.
    const usage = await api('GET', `/v1/projects/${projectId}/voice/sessions/${sessionId}`).then((o) => o.json.usage as { toolCalls: number; textTokens: number; audioSeconds: number });
    expect(usage.toolCalls).toBe(1);
    expect(usage.textTokens).toBe(18);
    expect(usage.audioSeconds).toBeGreaterThan(0);

    // Zero key material reached the client or the fake provider (boolean scan).
    const clientScan = relay.frames.filter((raw) => /xai-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}/i.test(raw)).length;
    const providerScan = fake.received.filter((raw) => /xai-[A-Za-z0-9_-]{8,}/i.test(raw)).length;
    expect(clientScan).toBe(0);
    expect(providerScan).toBe(0);

    relay.socket.close();
    await relay.closeEvent;
    // Cleanup the queued run so later tests see no active run.
    await api('POST', `/v1/projects/${projectId}/runs/${parsed.runId}/cancel`, {}, { ...bearer, 'idempotency-key': `roundtrip-cancel-${Date.now()}` });
  });

  it('buffers client frames streamed during the provider dial and flushes them after the server-side declaration', async () => {
    fake.received.length = 0;
    fake.script = null;
    const sessionId = await voiceSessionStart();
    const ticket = await voiceTicket();
    fake.openDelayMs = 150;
    try {
      const relay = await relayConnect(sessionId, ticket);
      // The client streams immediately, while the provider dial is still
      // opening: these frames must be buffered, not dropped.
      relay.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(4800).toString('base64') }));
      relay.socket.send(JSON.stringify({ type: 'response.create' }));
      const flushIndex = await waitFor(() => {
        const index = fake.received.findIndex((raw) => raw.includes('response.create'));
        return index > 0 ? index : null;
      });
      // The server-side tool declaration reaches the provider FIRST; the
      // buffered client frames follow in order.
      const declarationIndex = fake.received.findIndex((raw) => raw.includes('request_engineering_run'));
      expect(declarationIndex).toBe(0);
      expect(fake.received[0]?.includes('session.update')).toBe(true);
      expect(fake.received.slice(1, flushIndex).some((raw) => raw.includes('input_audio_buffer.append'))).toBe(true);
      // An interrupt arriving while the dial is still opening must be queued,
      // applied upstream on open, and must drop the stale buffered frames.
      const cancel = await api('POST', `/v1/projects/${projectId}/voice/sessions/${sessionId}/response/cancel`);
      expect(cancel.status).toBe(200);
      await waitFor(() => (relay.frames.some((raw) => raw.includes('response.cancelled')) ? true : null));
      await waitFor(() => (fake.received.some((raw) => raw.includes('response.cancel')) ? true : null));
      const cancelIndex = fake.received.findIndex((raw) => raw.includes('response.cancel'));
      expect(cancelIndex).toBeGreaterThan(flushIndex);
      expect(fake.received.length).toBe(cancelIndex + 1); // no further flushed frames
      relay.socket.close();
      await relay.closeEvent;
    } finally {
      fake.openDelayMs = 0;
    }
  });

  it('interrupting the voice response flushes voice output ONLY and never cancels a run', async () => {
    const sessionId = await voiceSessionStart();
    const ticket = await voiceTicket();
    const relay = await relayConnect(sessionId, ticket);
    await waitFor(() => (fake.received.some((raw) => raw.includes('session.update')) ? true : null));

    const reference = withTransaction(db, () => {
      const plan = createPlanVersionRow(db, projectId, { items: ['i'], acceptanceCriteria: ['c'], permittedScope: ['command'] }, 'req-interrupt');
      return approvePlanVersionRow(db, projectId, plan.plan.id, { permittedScope: ['command'], approvedBy: 'x' }, 'req-interrupt').approval.id;
    });
    const started = await api('POST', `/v1/projects/${projectId}/runs`, { conversationId, approvalId: reference }, { ...bearer, 'idempotency-key': `interrupt-${Date.now()}` });
    expect(started.status).toBe(200);
    const runId = (started.json.run as { runId: string }).runId;

    relay.socket.send(JSON.stringify({ type: 'response.create' }));
    await waitFor(() => (fake.received.some((raw) => raw.includes('response.create')) ? true : null));
    fake.received.length = 0;

    const cancel = await api('POST', `/v1/projects/${projectId}/voice/sessions/${sessionId}/response/cancel`);
    expect(cancel.status).toBe(200);
    await waitFor(() => (fake.received.some((raw) => raw.includes('response.cancel')) ? true : null));
    await waitFor(() => (relay.frames.some((raw) => raw.includes('response.cancelled')) ? true : null));
    const events = await api('GET', `/v1/projects/${projectId}/events?limit=200`).then((o) => o.json.events as Array<{ type: string; data: Record<string, unknown> }>);
    expect(events.some((event) => event.type === 'voice.response.cancelled' && event.data.sessionId === sessionId)).toBe(true);
    // The run is untouched: still queued, never cancelled by the interruption.
    const run = await api('GET', `/v1/projects/${projectId}/runs/${runId}`).then((o) => o.json.run as { state: string; cancelRequested: boolean });
    expect(run.state).toBe('queued');
    expect(run.cancelRequested).toBe(false);
    relay.socket.close();
    await relay.closeEvent;
    // Cleanup the queued run so later tests are not blocked.
    await api('POST', `/v1/projects/${projectId}/runs/${runId}/cancel`, {}, { ...bearer, 'idempotency-key': `interrupt-cancel-${Date.now()}` });
  });

  it('a provider disconnect ends the session terminally; a fresh ticket starts a fresh session with no replayed tools', async () => {
    fake.received.length = 0;
    const connectionsBefore = fake.connections;
    const sessionId = await voiceSessionStart();
    const ticket = await voiceTicket();
    const relay = await relayConnect(sessionId, ticket);
    await waitFor(() => (fake.connections === connectionsBefore + 1 ? true : null));
    await waitFor(() => (fake.received.some((raw) => raw.includes('session.update')) ? true : null));

    // The provider drops the connection.
    for (const client of [...fake.clients]) client.close();
    const close = await relay.closeEvent;
    expect(close.code).toBe(4503);
    expect(close.reason).toBe('provider_disconnected');

    const session = await api('GET', `/v1/projects/${projectId}/voice/sessions/${sessionId}`).then((o) => o.json.session as { state: string });
    expect(session.state).toBe('ended');

    // A reconnect attempt against the ENDED session is an explicit error.
    const replay = await upgradeRejected(sessionId, await voiceTicket());
    expect(replay.code).toBe(4409);

    // A FRESH ticket + FRESH session reconnects cleanly.
    fake.received.length = 0;
    const freshConnectionsBefore = fake.connections;
    const freshSessionId = await voiceSessionStart();
    expect(freshSessionId).not.toBe(sessionId);
    const freshRelay = await relayConnect(freshSessionId, await voiceTicket());
    await waitFor(() => (fake.connections === freshConnectionsBefore + 1 ? true : null));
    await waitFor(() => (fake.received.some((raw) => raw.includes('session.update')) ? true : null));
    // No old tool output is replayed on the fresh session.
    const replayedTools = fake.received.filter((raw) => raw.includes('function_call_output')).length;
    expect(replayedTools).toBe(0);
    freshRelay.socket.close();
    await freshRelay.closeEvent;
  });

  it('ending twice is idempotent and the ended session refuses the relay', async () => {
    const sessionId = await voiceSessionStart();
    // A live relay connected to the session is terminated by the API end:
    // the provider connection closes promptly (the session lifecycle is
    // explicit, not tied to the client socket).
    const ticket = await voiceTicket();
    const connsBefore = fake.connections;
    // The live relay connection itself is the fixture: the API end must
    // terminate it (observed via the provider client count below).
    await relayConnect(sessionId, ticket);
    await waitFor(() => (fake.connections === connsBefore + 1 ? true : null));
    const providersBefore = fake.clients.size;
    const first = await api('POST', `/v1/projects/${projectId}/voice/sessions/${sessionId}/end`);
    expect(first.status).toBe(200);
    expect((first.json.session as { state: string }).state).toBe('ended');
    await waitFor(() => (fake.clients.size < providersBefore ? true : null));
    const second = await api('POST', `/v1/projects/${projectId}/voice/sessions/${sessionId}/end`);
    expect(second.status).toBe(200);
    expect((second.json.session as { state: string }).state).toBe('ended');
    const ended = await upgradeRejected(sessionId, await voiceTicket());
    expect(ended.code).toBe(4409);
  });

  it('records observed usage when the API end lands before the periodic flush', async () => {
    fake.received.length = 0;
    const sessionId = await voiceSessionStart();
    const ticket = await voiceTicket();
    const relay = await relayConnect(sessionId, ticket);
    await waitFor(() => (fake.received.some((raw) => raw.includes('session.update')) ? true : null));

    // 0.1s of synthetic PCM plus one scripted provider completion carrying
    // observed usage; then the API end arrives BEFORE the 10s flush tick.
    // The terminal settlement must land the observed usage, not lose it.
    const audio = Buffer.alloc(4800).toString('base64');
    relay.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
    // Deterministic ordering: the script must see ONLY the response.create,
    // never the earlier append frame.
    await waitFor(() => (fake.received.some((raw) => raw.includes('input_audio_buffer.append')) ? true : null));
    fake.script = [() => [JSON.stringify({ type: 'response.done', usage: { input_tokens: 5, output_tokens: 3 } })]];
    relay.socket.send(JSON.stringify({ type: 'response.create' }));
    await waitFor(() => (relay.frames.some((raw) => raw.includes('response.done')) ? true : null));

    const ended = await api('POST', `/v1/projects/${projectId}/voice/sessions/${sessionId}/end`);
    expect(ended.status).toBe(200);
    const after = await api('GET', `/v1/projects/${projectId}/voice/sessions/${sessionId}`).then((o) => o.json as { usage: { audioSeconds: number; textTokens: number; toolCalls: number } });
    expect(after.usage.textTokens).toBe(8); // 5 input + 3 output from the fake usage frame
    expect(after.usage.audioSeconds).toBeCloseTo(0.1, 2);
    // Exactly one usage event, and it carries the observed values.
    const events = await api('GET', `/v1/projects/${projectId}/events?limit=200`).then((o) => o.json.events as Array<{ type: string; data: Record<string, unknown> }>);
    const recorded = events.filter((event) => event.type === 'voice.usage.recorded' && event.data.sessionId === sessionId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.data.textTokens).toBe(8);
    relay.socket.close();
    await relay.closeEvent;
  });

  it('refuses a different model than the configured pinned provider model', async () => {
    const out = await api('POST', `/v1/projects/${projectId}/voice/sessions`, { conversationId, model: 'some-other-voice-model' });
    expect(out.status).toBe(400);
    expect(out.json.error).toMatchObject({ code: 'validation_failed' });
    const ok = await api('POST', `/v1/projects/${projectId}/voice/sessions`, { conversationId, model: 'grok-voice-3.0' });
    expect(ok.status).toBe(200);
    expect((ok.json.session as { model: string }).model).toBe('grok-voice-3.0');
  });
});
