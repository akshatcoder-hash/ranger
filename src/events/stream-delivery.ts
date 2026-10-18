import type { DatabaseSync } from 'node:sqlite';
import { assertIssuerAlive, type TicketBinding } from '../auth/tickets.js';
import { membershipRole } from '../auth/authorization.js';
import { Errors, isAppError } from '../errors.js';
import { listProjectEvents, serializeProjectEvent } from './store.js';

/**
 * Event stream delivery: the ordered batch pump behind the public
 * `subscribeProjectEvents` WebSocket.
 *
 * Authorization is re-validated BEFORE EVERY delivered batch (replay page or
 * live tick) — not only at upgrade: the ticket's retained issuing-credential
 * binding must still be alive (token not revoked, session neither revoked
 * nor expired) and the principal must STILL be a project member. A failed
 * check closes the stream 4401 with ONE `kind:"error"` frame and never
 * fetches or delivers a later project payload.
 *
 * Slow-consumer close (4502) is deliberately frame-less: by definition the
 * outbound buffer is already saturated past its bound, so enqueueing more
 * bytes (including an error frame) onto that socket is unsafe and pointless.
 * The close code/reason itself is the documented signal; clients recover by
 * reconnecting with their cursor. This module doubles as the deterministic
 * test seam for both behaviors (tests drive `createEventPump` against fake
 * sockets instead of real TCP overload stress).
 */

/** Maximum events pulled per poll/paging cycle. */
export const EVENTS_PAGE = 200;
/** Outbound backpressure bound: slow consumers are disconnected, never silently dropped. */
export const EVENTS_MAX_BUFFERED_BYTES = 1_000_000;
/** The ws `WebSocket.OPEN` readyState value (kept literal so the seam stays ws-free). */
const READY_STATE_OPEN = 1;

/** The minimal socket surface the delivery loop needs (real ws socket or a test double). */
export interface EventStreamSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
}

export interface EventStreamLog {
  warn(obj: object, message: string): void;
  error(obj: object, message: string): void;
}

/** One `kind:"error"` frame, exactly as documented for rejection closes. */
export function errorFrame(code: string, message: string, requestId: string, details?: Record<string, unknown>): string {
  return JSON.stringify({
    kind: 'error',
    requestId,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  });
}

/**
 * Authorization re-validation before every delivered batch: the issuing
 * credential must be alive and the principal must STILL be a member.
 * Throws `unauthorized` with a stable reason (`issuer_revoked`,
 * `issuer_expired`, `membership_removed`).
 */
export function assertEventStreamAuthorized(db: DatabaseSync, projectId: string, binding: TicketBinding): void {
  assertIssuerAlive(db, binding.credentialKind, binding.credentialId);
  if (membershipRole(db, projectId, binding.principalId) === null) {
    throw Errors.unauthorized('Principal is no longer a member of this project; closing the event stream', {
      reason: 'membership_removed',
    });
  }
}

export interface EventPumpOptions {
  db: DatabaseSync;
  projectId: string;
  /** Binding retained from the consumed connection ticket at upgrade. */
  binding: TicketBinding;
  requestId: string;
  socket: EventStreamSocket;
  /** Sequence to resume strictly after (validated cursor position or 0). */
  initialSequence?: number;
  maxBufferedBytes?: number;
  log?: EventStreamLog;
}

/**
 * Build the delivery pump. The returned function drains pages of persisted
 * events strictly after the last delivered sequence and is invoked once
 * immediately (replay) and then on the caller's poll timer (live follow).
 * It synchronizes itself (single in-flight run), stops permanently after it
 * initiates any close, and leaves ordering and exactly-once delivery to the
 * persisted per-project sequence.
 */
export function createEventPump(options: EventPumpOptions): () => void {
  const { db, projectId, binding, requestId, socket, log } = options;
  const maxBufferedBytes = options.maxBufferedBytes ?? EVENTS_MAX_BUFFERED_BYTES;
  let lastSequence = options.initialSequence ?? 0;
  let terminated = false;
  let pumping = false;

  return function pump(): void {
    if (terminated || pumping || socket.readyState !== READY_STATE_OPEN) return;
    pumping = true;
    try {
      for (;;) {
        if (terminated || socket.readyState !== READY_STATE_OPEN) return;
        if (socket.bufferedAmount > maxBufferedBytes) {
          log?.warn({ projectId }, 'events subscriber exceeded the outbound buffer bound; disconnecting slow consumer');
          // Bounded safe behavior: enqueue NOTHING onto the already
          // saturated socket (no error frame) — the 4502 close code/reason
          // is the documented signal.
          terminated = true;
          socket.close(4502, 'slow_consumer');
          return;
        }
        // Re-validate authorization before every delivered batch so removed
        // members and revoked/expired issuers stop receiving events before
        // any later project payload.
        try {
          assertEventStreamAuthorized(db, projectId, binding);
        } catch (cause) {
          log?.warn({ projectId }, 'events subscriber lost authorization; closing the stream');
          try {
            const details = isAppError(cause) ? cause.details : undefined;
            socket.send(
              errorFrame(
                'unauthorized',
                cause instanceof Error ? cause.message : 'Event stream authorization failed',
                requestId,
                details,
              ),
            );
          } catch {
            // The socket may already be closing; the 4401 close still carries the class.
          }
          terminated = true;
          socket.close(4401, 'unauthorized');
          return;
        }
        const page = listProjectEvents(db, projectId, { afterSequence: lastSequence, limit: EVENTS_PAGE });
        if (page.events.length === 0) return;
        for (const event of page.events) {
          socket.send(JSON.stringify(serializeProjectEvent(event)));
          lastSequence = event.sequence;
        }
        if (!page.hasMore) return;
      }
    } catch (cause) {
      log?.error({ err: cause }, 'events pump failed');
    } finally {
      pumping = false;
    }
  };
}
