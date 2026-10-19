import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error the Worker entrypoint is plain JS with no bundled type declarations
import worker from '../../deploy/cloudflare/index.mjs';

const PUBLIC_ORIGIN = 'https://ranger.akshats.xyz';
const BACKEND_ORIGIN = 'https://ranger-backend-akshats.fly.dev';

type FetchCall = { url: string; request: Request };

function env(assetsBody = 'asset') {
  return {
    BACKEND_ORIGIN,
    PUBLIC_ORIGIN,
    ASSETS: {
      fetch: vi.fn(async () => new Response(assetsBody, { status: 200, headers: { 'content-type': 'text/html' } })),
    },
  };
}

function incoming(
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Request {
  return new Request(`https://ranger.akshats.xyz${path}`, init);
}

async function invoke(request: Request, binding = env()) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: Request | string) => {
    if (!(input instanceof Request)) throw new Error('proxy must forward a Request');
    calls.push({ url: input.url, request: input });
    return new Response('upstream', { status: 200, headers: { 'x-upstream': '1' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const response = await worker.fetch(request, binding);
  return { response, calls, fetchMock, binding };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cloudflare API proxy', () => {
  it('forwards method, path, query, body, and cookies to the backend', async () => {
    const { response, calls } = await invoke(
      incoming('/v1/projects/prj_1?cursor=abc', {
        method: 'POST',
        headers: {
          origin: PUBLIC_ORIGIN,
          cookie: 'ranger_session=session-value',
          'content-type': 'application/json',
          'sec-websocket-protocol': 'ranger.v1',
        },
        body: '{"prompt":"hello"}',
      }),
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BACKEND_ORIGIN}/v1/projects/prj_1?cursor=abc`);
    const forwarded = calls[0]?.request;
    expect(forwarded?.method).toBe('POST');
    expect(forwarded?.headers.get('cookie')).toBe('ranger_session=session-value');
    expect(forwarded?.headers.get('content-type')).toBe('application/json');
    expect(forwarded?.headers.get('sec-websocket-protocol')).toBe('ranger.v1');
    expect(await forwarded?.text()).toBe('{"prompt":"hello"}');
  });

  it('translates only the exact public Origin and sets the backend Host', async () => {
    const { calls } = await invoke(incoming('/v1/auth/me', { headers: { origin: PUBLIC_ORIGIN } }));
    const headers = calls[0]?.request.headers;
    expect(headers?.get('origin')).toBe(BACKEND_ORIGIN);
    expect(headers?.get('host')).toBe('ranger-backend-akshats.fly.dev');
  });

  it('rejects a foreign Origin with 403 and does not fetch', async () => {
    const { response, fetchMock } = await invoke(
      incoming('/v1/auth/me', { method: 'POST', headers: { origin: 'https://evil.example' } }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.error).toEqual({
      code: 'forbidden',
      message: 'Origin is not allowed for this API.',
      details: { reason: 'origin_mismatch' },
    });
    expect(body.requestId).toEqual(expect.any(String));
  });

  it('rejects a null Origin string without fetching', async () => {
    const { response, fetchMock } = await invoke(
      incoming('/v1/projects', { method: 'POST', headers: { origin: 'null' } }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
    expect((await response.json()).error.details).toEqual({ reason: 'origin_mismatch' });
  });

  it('forwards a missing Origin unchanged', async () => {
    const { calls } = await invoke(
      incoming('/v1/auth/browser-sessions', {
        method: 'POST',
        headers: { authorization: 'Bearer token-value', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    const headers = calls[0]?.request.headers;
    expect(headers?.has('origin')).toBe(false);
    expect(headers?.get('authorization')).toBe('Bearer token-value');
    expect(headers?.get('host')).toBe('ranger-backend-akshats.fly.dev');
  });

  it('marks normal API responses no-store and does not follow redirects', async () => {
    const { response, calls } = await invoke(incoming('/v1/capabilities', { headers: { origin: PUBLIC_ORIGIN } }));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(calls[0]?.request.redirect).toBe('manual');
  });

  it('returns a WebSocket 101 response unchanged', async () => {
    const socket = { kind: 'websocket' };
    const upgrade = {
      status: 101,
      statusText: 'Switching Protocols',
      webSocket: socket,
      headers: new Headers({ 'sec-websocket-protocol': 'ranger.v1' }),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => upgrade),
    );
    const response = await worker.fetch(
      incoming('/v1/projects/prj_1/voice/sessions/vcs_1/relay?ticket=one-time', {
        headers: {
          origin: PUBLIC_ORIGIN,
          upgrade: 'websocket',
          'sec-websocket-protocol': 'ranger.v1',
        },
      }),
      env(),
    );
    expect(response).toBe(upgrade);
    expect(response.status).toBe(101);
    expect(response.webSocket).toBe(socket);
  });

  it('returns a safe 503 envelope when the backend cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.8:8080');
      }),
    );
    const response = await worker.fetch(incoming('/v1/capabilities', { headers: { origin: PUBLIC_ORIGIN } }), env());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toEqual({ code: 'internal_error', message: 'The Ranger API is unreachable.' });
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(body)).not.toContain('10.0.0.8');
  });

  it('falls through to ASSETS when the worker is invoked outside /v1', async () => {
    const binding = env('<!doctype html>');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const request = incoming('/projects/prj_1', { headers: { 'sec-fetch-mode': 'navigate' } });
    const response = await worker.fetch(request, binding);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(binding.ASSETS.fetch).toHaveBeenCalledWith(request);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<!doctype html>');
  });

  it('does not treat /v1-extra as an API path', async () => {
    const binding = env('spa');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const request = incoming('/v1-extra');
    await worker.fetch(request, binding);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(binding.ASSETS.fetch).toHaveBeenCalledOnce();
  });
});
