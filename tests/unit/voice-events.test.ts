import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForSessionCreated, waitForSocketClose, waitForNewPlan } from '../helpers/voice-events.js';

const socket = (): WebSocket => new EventEmitter() as WebSocket;
afterEach(() => vi.useRealTimers());

describe('live voice event waits (offline)', () => {
  it('waits beyond the old 1.5s sleep for an actual session.created and removes listeners', async () => {
    vi.useFakeTimers();
    const ws = socket();
    const ready = waitForSessionCreated(ws);
    ws.emit('open');
    ws.emit('message', Buffer.from('{"type":"session.updated"}'));
    await vi.advanceTimersByTimeAsync(4_000);
    ws.emit('message', Buffer.from('{"type":"session.created"}'));
    await expect(ready).resolves.toBeUndefined();
    expect(ws.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails immediately on a relay rejection with only allowlisted diagnostic fields', async () => {
    const ws = socket();
    const ready = waitForSessionCreated(ws);
    ws.emit('message', Buffer.from(JSON.stringify({ kind: 'error', error: { message: 'Bearer synthetic-secret', details: { category: 'http_rejected', httpStatus: 403 } } })));
    await expect(ready).rejects.toThrow('Relay returned an error before session.created (http_rejected) HTTP 403');
    expect(ws.eventNames()).toEqual([]);
  });

  it.each(['error', 'close', 'provider-error', 'invalid-json'])('fails immediately on %s', async (event) => {
    const ws = socket();
    const ready = waitForSessionCreated(ws);
    if (event === 'error') ws.emit('error', new Error('secret transport details'));
    else if (event === 'close') ws.emit('close', 4503);
    else ws.emit('message', Buffer.from(event === 'provider-error' ? '{"type":"error"}' : 'invalid'));
    await expect(ready).rejects.toThrow(/before session.created/);
    expect(ws.eventNames()).toEqual([]);
  });

  it('times out without retrying or leaving listeners', async () => {
    vi.useFakeTimers();
    const ws = socket();
    const rejected = expect(waitForSessionCreated(ws)).rejects.toThrow('No session.created within 20000ms');
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(ws.eventNames()).toEqual([]);
  });

  it('waits for the server close code instead of racing it with a client close', async () => {
    const ws = socket();
    const closed = waitForSocketClose(ws);
    ws.emit('open');
    ws.emit('close', 4409);
    await expect(closed).resolves.toBe(4409);
    expect(ws.eventNames()).toEqual([]);
  });

  it('waits for a newer persisted plan event, ignoring old plans and model text claims', async () => {
    const events = socket(), voice = socket();
    const created = waitForNewPlan(events, voice, 2);
    voice.emit('message', Buffer.from('{"type":"response.text.delta","delta":"Plan created!"}'));
    events.emit('message', Buffer.from('{"type":"plan.version.created","data":{"planId":"pln_aa","version":2}}'));
    events.emit('message', Buffer.from('{"type":"plan.version.created","data":{"planId":"pln_bb","version":3}}'));
    await expect(created).resolves.toEqual({ planId: 'pln_bb', version: 3 });
    expect(events.eventNames()).toEqual([]);
    expect(voice.eventNames()).toEqual([]);
  });

  it.each(['error', 'close'])('fails a plan wait promptly on voice %s without leaking payloads', async (kind) => {
    const events = socket(), voice = socket();
    const created = waitForNewPlan(events, voice, 0);
    if (kind === 'close') voice.emit('close', 4503);
    else voice.emit('message', Buffer.from('{"type":"error","message":"Bearer synthetic-secret"}'));
    await expect(created).rejects.toThrow(/before a new plan|while waiting for a new plan/);
    expect(events.eventNames()).toEqual([]);
    expect(voice.eventNames()).toEqual([]);
  });

  it('bounds a plan-event wait without retrying', async () => {
    vi.useFakeTimers();
    const events = socket(), voice = socket();
    const rejected = expect(waitForNewPlan(events, voice, 0)).rejects.toThrow('No new plan.version.created within 60000ms');
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(events.eventNames()).toEqual([]);
    expect(voice.eventNames()).toEqual([]);
  });
});
