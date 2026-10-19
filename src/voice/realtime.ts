import WebSocket from 'ws';
import { Agent } from 'node:https';
import type { ProxyEnv } from 'node:http';

/**
 * The one provider seam for the voice relay: the server-side connection to
 * the upstream xAI realtime service.
 *
 * The permanent provider key stays in server memory ONLY: it is read from
 * the protected secret file when the relay dials and passed as the
 * Authorization header of the upstream request. It never reaches a client
 * frame, event, log, artifact or guest. Ranger — never the browser — opens
 * this connection. No retry: a failed or dropped upstream connection ends
 * the voice session honestly (a fresh ticket starts a fresh session).
 */

export const XAI_REALTIME_URL = 'wss://api.x.ai/v1/realtime';

/** Outbound buffer bound toward the upstream provider (backpressure). */
export const PROVIDER_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export interface RealtimeProviderConnection {
  /** Send one JSON text frame upstream. */
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount: number;
  readonly isOpen: boolean;
}

export interface RealtimeProviderHandlers {
  onMessage(data: string): void;
  onClose(code: number, reason: string): void;
  onError(message: string, failure?: RealtimeProviderFailure): void;
  onOpen(): void;
}

/** Public failure diagnostics are intentionally restricted to labels, status and known network codes. */
export interface RealtimeProviderFailure {
  category: 'http_rejected' | 'network_error' | 'handshake_timeout' | 'transport_error';
  httpStatus?: number;
  networkCode?: string;
  proxyConfigured?: boolean;
}

export function realtimeProxyEnvironment(env: NodeJS.ProcessEnv): ProxyEnv {
  return {
    HTTPS_PROXY: env['wss_proxy'] ?? env['WSS_PROXY'] ?? env['https_proxy'] ?? env['HTTPS_PROXY'],
    NO_PROXY: env['no_proxy'] ?? env['NO_PROXY'],
  };
}

export function realtimeFailure(cause: unknown): RealtimeProviderFailure {
  const error = cause !== null && typeof cause === 'object' ? cause as { message?: unknown; code?: unknown } : {};
  const message = typeof error.message === 'string' ? error.message : '';
  const status = /^Unexpected server response: (\d{3})$/.exec(message);
  if (status !== null) return { category: 'http_rejected', httpStatus: Number(status[1]) };
  if (message === 'Opening handshake has timed out') return { category: 'handshake_timeout' };
  const codes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EPROTO', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT']);
  if (typeof error.code === 'string' && codes.has(error.code)) return { category: 'network_error', networkCode: error.code };
  return { category: 'transport_error' };
}

/** Factory shape: dial one upstream connection for one relay session. */
export type RealtimeProviderFactory = (input: {
  model: string;
  apiKey: string;
  handlers: RealtimeProviderHandlers;
}) => RealtimeProviderConnection;

/**
 * Real xAI realtime dial: `wss://api.x.ai/v1/realtime?model=<pinned>` with
 * the key in the Authorization header. The explicit HTTPS agent honors the
 * deployment proxy and bypass settings; ws otherwise bypasses Node’s global
 * agent via its own createConnection. No fallback URL, TLS bypass or retry.
 */
export const xaiRealtimeProviderFactory: RealtimeProviderFactory = ({ model, apiKey, handlers }) => {
  const proxyEnv = realtimeProxyEnvironment(process.env);
  const agent = new Agent({ proxyEnv });
  const socket = new WebSocket(`${XAI_REALTIME_URL}?model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    agent,
    maxPayload: 8 * 1024 * 1024,
    handshakeTimeout: 15_000,
  });
  const connection: RealtimeProviderConnection = {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    get isOpen() {
      return socket.readyState === WebSocket.OPEN;
    },
  };
  socket.on('open', () => handlers.onOpen());
  socket.on('message', (data, isBinary) => {
    if (isBinary) return; // The documented protocol is JSON text frames only.
    handlers.onMessage(data.toString('utf8'));
  });
  socket.on('close', (code, reason) => {
    agent.destroy();
    handlers.onClose(code, reason.toString('utf8'));
  });
  socket.on('error', (cause) => handlers.onError('The realtime provider connection failed', {
    ...realtimeFailure(cause),
    proxyConfigured: Boolean(proxyEnv.HTTPS_PROXY),
  }));
  return connection;
};
