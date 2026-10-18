import type { WebSocket as WsWebSocket } from 'ws';
import type { FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { consumeTicket, lookupTicketOrigin } from '../auth/tickets.js';
import { requireMembership, requirePrincipalId } from '../auth/authorization.js';
import {
  assertCursorNotExpired,
  decodeEventCursor,
  encodeEventCursor,
  listProjectEvents,
  projectEventHead,
  serializeProjectEvent,
} from '../events/store.js';
import { Errors } from '../errors.js';
import type { HandlerContext, OperationHandler, WsOperationHandler } from './handlers.js';

/**
 * Handlers for the events family: cursor replay over HTTP plus the
 * authenticated live WebSocket subscription.
 *
 * Subscription authentication happens at upgrade time, BEFORE any delivery:
 * the single-use connection ticket is consumed with its purpose
 * ('events'), the path projectId and the upgrade Origin, and the ticket's
 * principal must STILL be a member of the project. Failures close the
 * socket with stable documented close codes instead of delivering events:
 *
 *   4401 unauthorized   missing/invalid/expired/reused ticket, purpose,
 *                       project or origin mismatch, or current non-membership
 *   4400 invalid_cursor malformed or ahead-of-history cursor
 *   4410 cursor_expired cursor older than the configured replay window
 *   4502 slow_consumer  outbound buffer exceeded the backpressure bound
 *
 * Delivery order is the persisted per-project sequence; each connection
 * resumes strictly after its cursor with no gaps or duplicates. Replay and
 * live pumping only read the event table and send JSON frames — replay
 * never invokes tools and changes no state.
 */

/** Milliseconds between live delivery polls (events also arrive from the worker process). */
const EVENTS_POLL_MS = 100;
/** Outbound backpressure bound: slow consumers are disconnected, never silently dropped. */
const EVENTS_MAX_BUFFERED_BYTES = 1_000_000;
/** Maximum events pulled per poll/paging cycle. */
const EVENTS_PAGE = 200;

function errorFrame(code: string, message: string, requestId: string, details?: Record<string, unknown>): string {
  return JSON.stringify({
    kind: 'error',
    requestId,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  });
}

/**
 * Replay start position for a subscription or replay request: validated
 * cursor sequence or 0 (full history). Throws the explicit cursor errors —
 * never a silent gap.
 */
function resolveReplayStart(db: DatabaseSync, projectId: string, rawCursor: string | undefined, replayWindowMs: number): number {
  if (rawCursor === undefined || rawCursor === '') return 0;
  const cursor = decodeEventCursor(rawCursor);
  assertCursorNotExpired(cursor, replayWindowMs);
  const head = projectEventHead(db, projectId);
  if (cursor.seq > head) {
    throw Errors.invalidCursor('Event cursor is ahead of the project event history; resubscribe without a cursor', {
      reason: 'cursor_ahead_of_head',
      head,
    });
  }
  return cursor.seq;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 100;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw Errors.validation('limit must be a positive integer');
  return Math.max(1, Math.min(500, parsed));
}

export function registerEventHandlers(
  ctx: HandlerContext,
  handlers: Map<string, OperationHandler>,
  wsHandlers: Map<string, WsOperationHandler>,
): void {
  const { db, config } = ctx;
  const replayWindowMs = config.limits.eventReplayWindowMs;

  handlers.set('replayProjectEvents', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string };
    requireMembership(db, params.projectId, principalId);
    const query = req.query as { cursor?: string; limit?: string };
    const limit = parseLimit(query.limit);
    const afterSequence = resolveReplayStart(db, params.projectId, query.cursor, replayWindowMs);
    const page = listProjectEvents(db, params.projectId, { afterSequence, limit });
    const last = page.events.length > 0 ? page.events[page.events.length - 1] : undefined;
    return {
      events: page.events.map(serializeProjectEvent),
      nextCursor:
        last !== undefined
          ? encodeEventCursor(last.sequence, last.timestampMs)
          : query.cursor !== undefined && query.cursor !== ''
            ? query.cursor
            : null,
      hasMore: page.hasMore,
    };
  });

  wsHandlers.set('subscribeProjectEvents', (socket: WsWebSocket, req: FastifyRequest) => {
    const params = req.params as { projectId: string };
    const query = req.query as { ticket?: string; cursor?: string };
    const projectId = params.projectId;
    const requestId = req.id;
    const origin = typeof req.headers.origin === 'string' && req.headers.origin !== '' ? req.headers.origin : undefined;

    const reject = (closeCode: number, code: string, message: string, details?: Record<string, unknown>): void => {
      try {
        socket.send(errorFrame(code, message, requestId, details));
      } catch {
        // The socket may already be closing; the close code still carries the class.
      } finally {
        socket.close(closeCode, code);
      }
    };

    // 1. A single-use connection ticket is required, bound to purpose
    //    ('events'), the path projectId and the upgrade origin.
    if (typeof query.ticket !== 'string' || query.ticket === '') {
      reject(4401, 'unauthorized', 'An events connection ticket is required', { reason: 'ticket_required' });
      return;
    }
    try {
      // Origin pre-check for origin-bound tickets (an upgrade without any
      // Origin header cannot prove the bound origin).
      const bound = lookupTicketOrigin(db, query.ticket);
      if (bound !== null && (origin === undefined || origin.toLowerCase() !== bound.toLowerCase())) {
        throw Errors.unauthorized('Connection ticket is not valid for this use', { reason: 'origin_mismatch' });
      }
      const binding = consumeTicket(db, query.ticket, { purpose: 'events', projectId, origin });
      // 2. Current membership at upgrade time.
      requireMembership(db, projectId, binding.principalId);
    } catch (cause) {
      const code = cause instanceof Error && (cause as { code?: string }).code === 'not_found' ? 'not_found' : 'unauthorized';
      reject(4401, code, cause instanceof Error ? cause.message : 'Connection ticket is not valid for this use');
      return;
    }

    // 3. Cursor validation with explicit errors (4400/4410).
    let afterSequence: number;
    try {
      afterSequence = resolveReplayStart(db, projectId, query.cursor, replayWindowMs);
    } catch (cause) {
      if (cause instanceof Error && (cause as { code?: string }).code === 'cursor_expired') {
        reject(4410, 'cursor_expired', cause.message);
      } else {
        reject(4400, 'invalid_cursor', cause instanceof Error ? cause.message : 'Event cursor is malformed');
      }
      return;
    }

    // 4. Ordered replay then live delivery: one pump drains the history and
    //    follows the head, re-checking backpressure before every send.
    let lastSequence = afterSequence;
    let closed = false;
    let pumping = false;
    const stop = (): void => {
      closed = true;
    };
    socket.on('close', stop);
    const pump = (): void => {
      if (closed || pumping || socket.readyState !== socket.OPEN) return;
      pumping = true;
      try {
        for (;;) {
          if (closed || socket.readyState !== socket.OPEN) return;
          if (socket.bufferedAmount > EVENTS_MAX_BUFFERED_BYTES) {
            req.log.warn({ projectId }, 'events subscriber exceeded the outbound buffer bound; disconnecting slow consumer');
            socket.close(4502, 'slow_consumer');
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
        req.log.error({ err: cause }, 'events pump failed');
      } finally {
        pumping = false;
      }
    };
    pump();
    const timer = setInterval(pump, EVENTS_POLL_MS);
    socket.on('close', () => clearInterval(timer));
  });
}
