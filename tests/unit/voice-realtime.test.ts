import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Agent } from 'node:https';

const { sockets } = vi.hoisted(() => ({ sockets: [] as Array<{
  url: string;
  options: { agent: Agent; headers: Record<string, string>; handshakeTimeout: number };
  emit(event: string, ...args: unknown[]): boolean;
}> }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    constructor(readonly url: string, readonly options: { agent: Agent; headers: Record<string, string>; handshakeTimeout: number }) {
      super(); sockets.push(this);
    }
    send() {}
    close() {}
  } };
});
import { realtimeFailure, realtimeProxyEnvironment, xaiRealtimeProviderFactory } from '../../src/voice/realtime.js';

afterEach(() => { for (const socket of sockets.splice(0)) socket.options.agent.destroy(); vi.unstubAllEnvs(); });

describe('realtime cloud proxy and safe diagnostics (no network)', () => {
  it('selects the deployment WSS proxy and preserves NO_PROXY without copying unrelated environment secrets', () => {
    expect(realtimeProxyEnvironment({ WSS_PROXY: 'http://proxy.test:8080', HTTPS_PROXY: 'http://other.test:8080', NO_PROXY: 'localhost,127.0.0.1', SECRET: 'not-copied' })).toEqual({ HTTPS_PROXY: 'http://proxy.test:8080', NO_PROXY: 'localhost,127.0.0.1' });
    expect(realtimeProxyEnvironment({ https_proxy: 'http://lowercase.test:8080', HTTPS_PROXY: 'http://uppercase.test:8080', no_proxy: '.internal.test' })).toEqual({ HTTPS_PROXY: 'http://lowercase.test:8080', NO_PROXY: '.internal.test' });
  });

  it('supplies an explicit proxy-aware HTTPS agent so ws cannot bypass the global environment agent', () => {
    vi.stubEnv('wss_proxy', 'http://proxy.test:8080');
    const handlers = { onOpen: vi.fn(), onMessage: vi.fn(), onClose: vi.fn(), onError: vi.fn() };
    xaiRealtimeProviderFactory({ model: 'grok-voice-3.0', apiKey: 'synthetic-key', handlers });
    const socket = sockets[0]!;
    expect(socket.url).toBe('wss://api.x.ai/v1/realtime?model=grok-voice-3.0');
    expect(socket.options.agent.options.proxyEnv).toMatchObject({ HTTPS_PROXY: 'http://proxy.test:8080' });
    expect(socket.options.handshakeTimeout).toBe(15000);
    socket.emit('error', Object.assign(new Error('secret transport text Bearer synthetic-secret'), { code: 'ECONNREFUSED' }));
    expect(handlers.onError).toHaveBeenCalledWith('The realtime provider connection failed', { category: 'network_error', networkCode: 'ECONNREFUSED', proxyConfigured: true });
    expect(JSON.stringify(handlers.onError.mock.calls)).not.toContain('synthetic-secret');
    const destroy = vi.spyOn(socket.options.agent, 'destroy');
    socket.emit('close', 1006, Buffer.from('closed'));
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('classifies HTTP rejection, timeout and known network errors without returning provider text', () => {
    expect(realtimeFailure(new Error('Unexpected server response: 401'))).toEqual({ category: 'http_rejected', httpStatus: 401 });
    expect(realtimeFailure(new Error('Opening handshake has timed out'))).toEqual({ category: 'handshake_timeout' });
    expect(realtimeFailure({ code: 'ENOTFOUND', message: 'secret hostname' })).toEqual({ category: 'network_error', networkCode: 'ENOTFOUND' });
    expect(realtimeFailure({ code: 'unknown-secret', message: 'Bearer private-key' })).toEqual({ category: 'transport_error' });
  });
});
