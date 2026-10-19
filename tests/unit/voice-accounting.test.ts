import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createCredentialFromSecret, createPrincipal } from '../../src/auth/principals.js';
import { createTicket } from '../../src/auth/tickets.js';
import { readLedger, type BudgetLedgerData } from '../../src/budget/ledger.js';
import * as ledger from '../../src/budget/ledger.js';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { HandlerContext } from '../../src/http/handlers.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { createConversationRow } from '../../src/conversations/store.js';
import { createVoiceSessionRow, getVoiceSessionRow } from '../../src/voice/store.js';
import { endVoiceRelayForSession, handleVoiceRelayUpgrade, interruptVoiceResponse } from '../../src/voice/relay.js';
import { setRealtimeProviderForTests } from '../../src/voice/runtime.js';
import { voiceTextInputCount } from '../../src/voice/accounting.js';
import { xaiRealtimeProviderFactory, type RealtimeProviderHandlers } from '../../src/voice/realtime.js';

// Exercise production accounting with an entirely in-memory transport. No
// real provider, socket, credential source, or mission ledger is accessed.
vi.mock('../../src/voice/realtime.js', async (original) => ({
  ...await original<Record<string, unknown>>(),
  xaiRealtimeProviderFactory: vi.fn(),
}));

const userText = (parts = 1): Record<string, unknown> => ({
  type: 'conversation.item.create',
  item: { type: 'message', role: 'user', content: Array.from({ length: parts }, () => ({ type: 'input_text', text: 'Synthetic text' })) },
});

class FakeClient extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames: string[] = [];
  closeCode = 0;
  closeReason = '';
  send(raw: string): void { this.frames.push(raw); }
  close(code: number, reason: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.emit('close');
  }
  input(frame: Record<string, unknown>): void { this.emit('message', Buffer.from(JSON.stringify(frame)), false); }
}

describe('voice text surcharge accounting (synthetic ledger, no network)', () => {
  let dir: string;
  let ledgerFile: string;
  let db: DatabaseSync;
  let ctx: HandlerContext;
  let projectId: string;
  let principalId: string;
  let credentialId: string;
  let sessionId: string;
  let client: FakeClient;
  let handlers: RealtimeProviderHandlers;
  let providerOpen: boolean;
  let sends: Array<{ frame: Record<string, unknown>; observedUsd: number; reservedUsd: number }>;
  let throwOnTextSend: boolean;

  function writeBudget(observedUsd = 0): void {
    writeFileSync(ledgerFile, JSON.stringify({
      version: 1,
      xai: { limitUsd: 5, softAdmissionUsd: 4, observedUsd, reservedUsd: 0, operations: [] },
      instabox: { maxAdditionalCreations: 0, maxConcurrent: 1, maxLifetimeSeconds: 600, additionalCreations: 0, machines: [] },
    } satisfies BudgetLedgerData));
  }

  function connect(open = true): void {
    const ticket = createTicket(db, { principalId, projectId, purpose: 'voice-relay', credentialKind: 'api_token', credentialId });
    const req = { params: { projectId, sessionId }, query: { ticket: ticket.secret }, headers: {}, id: 'req-budget' } as unknown as FastifyRequest;
    handleVoiceRelayUpgrade(client as unknown as WebSocket, req, ctx);
    if (open && vi.mocked(xaiRealtimeProviderFactory).mock.calls.length > 0) openProvider();
  }

  function openProvider(): void { providerOpen = true; handlers.onOpen(); }
  function textOperations() { return readLedger(ledgerFile).xai.operations.filter((op) => op.feature.endsWith(':voice-text-input')); }
  function textSends() { return sends.filter(({ frame }) => frame['type'] === 'conversation.item.create'); }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ranger-voice-budget-'));
    ledgerFile = path.join(dir, 'synthetic-budget.json');
    writeBudget();
    const config = await loadConfig({ RANGER_DATA_DIR: dir, RANGER_LIVE_BUDGET_FILE: ledgerFile });
    db = openDatabase(dir);
    runMigrations(db, path.join(process.cwd(), 'migrations'));
    principalId = createPrincipal(db, 'Synthetic budget owner').id;
    credentialId = createCredentialFromSecret(db, principalId, 'api_token', 'synthetic', 'synthetic-local-only').id;
    projectId = createProjectRecord(db, { name: 'Budget', engineerDisplayName: 'Ranger', principalId }).id;
    const conversationId = createConversationRow(db, projectId, 'Budget checks').id;
    sessionId = createVoiceSessionRow(db, { projectId, conversationId, principalId, model: 'grok-voice-3.0' }).id;
    ctx = { db, config, secrets: { isConfigured: () => true, get: () => 'synthetic-key-never-sent' } as unknown as HandlerContext['secrets'] };
    client = new FakeClient();
    providerOpen = false;
    throwOnTextSend = false;
    sends = [];
    setRealtimeProviderForTests(null);
    vi.mocked(xaiRealtimeProviderFactory).mockReset().mockImplementation((input) => {
      handlers = input.handlers;
      return {
        send(raw) {
          const frame = JSON.parse(raw) as Record<string, unknown>;
          const budget = readLedger(ledgerFile).xai;
          sends.push({ frame, observedUsd: budget.observedUsd, reservedUsd: budget.reservedUsd });
          if (throwOnTextSend && frame['type'] === 'conversation.item.create') throw new Error('Synthetic send failure');
        },
        close: () => { providerOpen = false; },
        bufferedAmount: 0,
        get isOpen() { return providerOpen; },
      };
    });
  });

  afterEach(() => {
    endVoiceRelayForSession(sessionId);
    setRealtimeProviderForTests(null);
    vi.restoreAllMocks();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('retains full duration headroom and settles each forwarded text part before send exactly once', () => {
    connect();
    expect(readLedger(ledgerFile).xai.reservedUsd).toBe(0.8);
    client.input(userText(2));
    client.input(userText());
    client.input({ type: 'input_audio_buffer.append', audio: 'AAAA' });
    client.input({ type: 'response.create' });
    handlers.onMessage(JSON.stringify({ type: 'response.done', usage: { input_tokens: 50, output_tokens: 10 } }));
    expect(textSends()).toMatchObject([
      { observedUsd: 0.008, reservedUsd: 0.8 },
      { observedUsd: 0.012, reservedUsd: 0.8 },
    ]);
    expect(textOperations().map((op) => op.kind)).toEqual(['reserve', 'observe', 'reserve', 'observe']);
    expect(textOperations().filter((op) => op.kind === 'observe').every((op) => op.note?.includes('unobserved'))).toBe(true);
    endVoiceRelayForSession(sessionId);
    const settled = readLedger(ledgerFile);
    expect(settled.xai.reservedUsd).toBe(0);
    expect(settled.xai.operations.filter((op) => op.kind === 'observe')).toHaveLength(3);
    expect(endVoiceRelayForSession(sessionId)).toBe(false);
    client.emit('close');
    handlers.onClose(1000, 'closed');
    expect(readLedger(ledgerFile)).toEqual(settled);
  });

  it('denies the next text before forwarding when duration plus text reaches the soft stop', () => {
    writeBudget(3.196);
    connect();
    client.input(userText()); // 3.196 + .8 duration + .004 text = 4
    client.input(userText());
    client.input(userText()); // Terminal: no retry or further admission.
    expect(textSends()).toHaveLength(1);
    expect(textOperations().map((op) => op.kind)).toEqual(['reserve', 'observe']);
    expect(client.closeReason).toBe('budget_exceeded');
    expect(client.closeCode).toBe(4503);
    expect(client.frames.map((raw) => JSON.parse(raw))).toContainEqual(expect.objectContaining({ error: expect.objectContaining({ code: 'budget_exceeded' }) }));
    expect(getVoiceSessionRow(db, projectId, sessionId)?.endReason).toBe('budget_exceeded');
    expect(readLedger(ledgerFile).xai.reservedUsd).toBe(0);
  });

  it('still refuses the initial duration reservation before any provider dial', () => {
    writeBudget(3.2001);
    connect();
    expect(xaiRealtimeProviderFactory).not.toHaveBeenCalled();
    expect(readLedger(ledgerFile).xai.operations).toEqual([]);
  });

  it('admits buffered text only as it is forwarded and stops flushing at budget denial', () => {
    writeBudget(3.196);
    connect(false);
    client.input(userText());
    client.input(userText());
    expect(textOperations()).toEqual([]);
    openProvider();
    expect(textSends()).toHaveLength(1);
    expect(textSends()[0]).toMatchObject({ observedUsd: 3.2, reservedUsd: 0.8 });
    expect(client.closeReason).toBe('budget_exceeded');
    expect(textOperations().map((op) => op.kind)).toEqual(['reserve', 'observe']);
  });

  it('does not charge text discarded by an interrupt before the provider opens', () => {
    connect(false);
    client.input(userText());
    expect(interruptVoiceResponse(sessionId)).toBe(true);
    openProvider();
    expect(textSends()).toEqual([]);
    expect(textOperations()).toEqual([]);
    expect(sends.some(({ frame }) => frame['type'] === 'response.cancel')).toBe(true);
  });

  it('releases duration headroom and charges no queued text when the dial fails', () => {
    connect(false);
    client.input(userText());
    handlers.onError('Synthetic dial failure');
    expect(textOperations()).toEqual([]);
    expect(readLedger(ledgerFile).xai).toMatchObject({ observedUsd: 0, reservedUsd: 0 });
    expect(readLedger(ledgerFile).xai.operations.map((op) => op.kind)).toEqual(['reserve', 'release']);
    expect(textSends()).toEqual([]);
  });

  it('fails closed before send and retains the reservation if text settlement cannot be recorded', () => {
    connect();
    vi.spyOn(ledger, 'observeXaiSpend').mockImplementationOnce(() => { throw new Error('Synthetic ledger write failure'); });
    client.input(userText());
    client.input(userText());
    expect(textSends()).toEqual([]);
    expect(client.closeReason).toBe('budget_exceeded');
    expect(textOperations().map((op) => op.kind)).toEqual(['reserve']);
    expect(readLedger(ledgerFile).xai.reservedUsd).toBe(0.004);
  });

  it('conservatively accounts a tool result once even if the function delivery is duplicated', async () => {
    connect();
    const frame = JSON.stringify({ type: 'response.function_call_arguments.done', name: 'get_project_status', call_id: 'status-1', arguments: '{}' });
    handlers.onMessage(frame);
    handlers.onMessage(frame);
    await vi.waitFor(() => expect(textSends()).toHaveLength(1));
    expect(textSends()[0]).toMatchObject({ frame: { item: { type: 'function_call_output', call_id: 'status-1' } }, observedUsd: 0.004 });
    expect(textOperations().map((op) => op.kind)).toEqual(['reserve', 'observe']);
    expect(textOperations()[1]?.note).toContain('tool_output');
  });

  it('denies a tool output and response continuation before forwarding at the soft stop', async () => {
    writeBudget(3.2);
    connect();
    handlers.onMessage(JSON.stringify({ type: 'response.function_call_arguments.done', name: 'get_project_status', call_id: 'status-denied', arguments: '{}' }));
    await vi.waitFor(() => expect(client.closeReason).toBe('budget_exceeded'));
    expect(textSends()).toEqual([]);
    expect(sends.some(({ frame }) => frame['type'] === 'response.create')).toBe(false);
    expect(textOperations()).toEqual([]);
  });

  it('also admits tool-error text before forwarding without creating engineering work', () => {
    connect();
    handlers.onMessage(JSON.stringify({ type: 'response.function_call_arguments.done', name: 'request_engineering_run', call_id: 'invalid-1', arguments: '{}' }));
    expect(textSends()).toHaveLength(1);
    expect(textSends()[0]).toMatchObject({ observedUsd: 0.004 });
    expect(textOperations().map((op) => op.kind)).toEqual(['reserve', 'observe']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toMatchObject({ n: 0 });
  });

  it('keeps a failed send conservatively charged without a hidden retry', () => {
    connect(false);
    client.input(userText());
    throwOnTextSend = true;
    openProvider();
    expect(textSends()).toHaveLength(1);
    expect(textOperations().map((op) => op.kind)).toEqual(['reserve', 'observe']);
    expect(textOperations()[1]?.observedUsd).toBe(0.004);
    handlers.onClose(1006, 'closed');
    expect(textSends()).toHaveLength(1);
  });

  it('keeps the existing injected-provider seam free even with a full configured ledger', () => {
    writeBudget(4);
    let injectedSends = 0;
    setRealtimeProviderForTests(({ handlers: injectedHandlers }) => {
      handlers = injectedHandlers;
      return { send: () => { injectedSends += 1; }, close: () => {}, bufferedAmount: 0, isOpen: true };
    });
    connect(false);
    handlers.onOpen();
    client.input(userText());
    expect(injectedSends).toBe(2);
    expect(xaiRealtimeProviderFactory).not.toHaveBeenCalled();
    expect(readLedger(ledgerFile).xai.operations).toEqual([]);
  });
});

describe('voice text input classification', () => {
  it('counts text parts, tool outputs and unknown shapes conservatively, exempting only known audio-only parts', () => {
    expect(voiceTextInputCount(userText(3))).toBe(3);
    expect(voiceTextInputCount({ type: 'conversation.item.create', item: { type: 'function_call_output', output: '{}' } })).toBe(1);
    expect(voiceTextInputCount({ type: 'session.update', session: { instructions: 'Server settings' } })).toBe(0);
    expect(voiceTextInputCount({ type: 'input_audio_buffer.append', audio: 'AAAA' })).toBe(0);
    expect(voiceTextInputCount({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_audio', audio: 'AAAA' }] } })).toBe(0);
    expect(voiceTextInputCount({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_audio', transcript: 'Text' }] } })).toBe(1);
    expect(voiceTextInputCount({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: 'Text' } })).toBe(1);
    expect(voiceTextInputCount({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [null, { type: 'unknown' }] } })).toBe(2);
  });
});
