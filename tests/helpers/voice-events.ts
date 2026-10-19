import type WebSocket from 'ws';

const DEFAULT_TIMEOUT_MS = 20_000;

/** Register immediately after constructing the socket, before any events can arrive. */
export function waitForSessionCreated(socket: WebSocket, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const onMessage = (data: WebSocket.RawData): void => {
      let frame: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data.toString());
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        frame = parsed as Record<string, unknown>;
      } catch {
        finish(new Error('Invalid JSON frame before session.created'));
        return;
      }
      if (frame['kind'] === 'error' || frame['type'] === 'error') {
        // Never include raw provider messages, URLs, headers or credentials in evidence.
        const error = frame['error'] as { details?: { category?: unknown; httpStatus?: unknown } } | undefined;
        const category = error?.details?.category;
        const status = error?.details?.httpStatus;
        const safeCategory = typeof category === 'string' && ['http_rejected', 'network_error', 'handshake_timeout', 'transport_error'].includes(category) ? ` (${category})` : '';
        const safeStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? ` HTTP ${status}` : '';
        finish(new Error(`Relay returned an error before session.created${safeCategory}${safeStatus}`));
      } else if (frame['type'] === 'session.created') {
        finish();
      }
    };
    const onError = (): void => finish(new Error('WebSocket transport error before session.created'));
    const onClose = (code: number): void => finish(new Error(`WebSocket closed before session.created (code ${code})`));
    const timer = setTimeout(() => finish(new Error(`No session.created within ${timeoutMs}ms`)), timeoutMs);
    socket.on('message', onMessage);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

/** Register before initiating a close; server refusal is also observed this way. */
export function waitForSocketClose(socket: WebSocket, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<number> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('close', onClose);
      socket.off('error', onError);
    };
    const onClose = (code: number): void => { cleanup(); resolve(code); };
    const onError = (): void => { cleanup(); reject(new Error('WebSocket transport error while waiting for close')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`WebSocket did not close within ${timeoutMs}ms`)); }, timeoutMs);
    socket.on('close', onClose);
    socket.on('error', onError);
  });
}

/** Observe durable plan creation on the real project event stream, never a model's success claim. */
export function waitForNewPlan(events: WebSocket, voice: WebSocket, previousVersion: number, timeoutMs = 60_000): Promise<{ planId: string; version: number }> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      events.off('message', onEvent);
      voice.off('message', onVoice);
      for (const socket of [events, voice]) { socket.off('error', onError); socket.off('close', onClose); }
    };
    const fail = (message: string): void => { cleanup(); reject(new Error(message)); };
    const parse = (data: WebSocket.RawData): Record<string, unknown> | null => {
      try {
        const frame: unknown = JSON.parse(data.toString());
        if (frame !== null && typeof frame === 'object' && !Array.isArray(frame)) return frame as Record<string, unknown>;
      } catch { /* Fail safely below without copying the payload. */ }
      fail('Invalid JSON while waiting for a new plan');
      return null;
    };
    const onEvent = (data: WebSocket.RawData): void => {
      const frame = parse(data);
      if (frame?.['kind'] === 'error') { fail('Project event stream rejected the subscription'); return; }
      if (frame?.['type'] !== 'plan.version.created') return;
      const plan = frame['data'] as { planId?: unknown; version?: unknown } | undefined;
      if (typeof plan?.planId === 'string' && /^pln_[0-9a-f-]+$/i.test(plan.planId) && typeof plan.version === 'number' && plan.version > previousVersion) {
        cleanup(); resolve({ planId: plan.planId, version: plan.version });
      }
    };
    const onVoice = (data: WebSocket.RawData): void => {
      const frame = parse(data);
      if (frame?.['kind'] === 'error' || frame?.['type'] === 'error') fail('Voice provider returned an error while waiting for a new plan');
    };
    const onError = (): void => fail('WebSocket transport failed while waiting for a new plan');
    const onClose = (code: number): void => fail(`WebSocket closed before a new plan was observed (code ${code})`);
    const timer = setTimeout(() => fail(`No new plan.version.created within ${timeoutMs}ms`), timeoutMs);
    events.on('message', onEvent);
    voice.on('message', onVoice);
    for (const socket of [events, voice]) { socket.on('error', onError); socket.on('close', onClose); }
  });
}
