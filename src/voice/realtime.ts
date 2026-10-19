import WebSocket from 'ws';

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
  onError(message: string): void;
  onOpen(): void;
}

/** Factory shape: dial one upstream connection for one relay session. */
export type RealtimeProviderFactory = (input: {
  model: string;
  apiKey: string;
  handlers: RealtimeProviderHandlers;
}) => RealtimeProviderConnection;

/**
 * Real xAI realtime dial: `wss://api.x.ai/v1/realtime?model=<pinned>` with
 * the key in the Authorization header. Bounded upstream payload; no proxies,
 * no fallback URL, no retry.
 */
export const xaiRealtimeProviderFactory: RealtimeProviderFactory = ({ model, apiKey, handlers }) => {
  const socket = new WebSocket(`${XAI_REALTIME_URL}?model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
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
  socket.on('close', (code, reason) => handlers.onClose(code, reason.toString('utf8')));
  socket.on('error', (cause) => handlers.onError(String(cause)));
  return connection;
};
