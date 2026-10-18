import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { openDatabase, withTransaction } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { appendProjectEvent } from '../../src/events/store.js';
import {
  EVENTS_MAX_BUFFERED_BYTES,
  assertEventStreamAuthorized,
  createEventPump,
} from '../../src/events/stream-delivery.js';
import { isAppError } from '../../src/errors.js';
import { createCredential, createPrincipal, revokeCredential } from '../../src/auth/principals.js';
import { createSession } from '../../src/auth/sessions.js';
import { consumeTicket, createTicket } from '../../src/auth/tickets.js';
import { addMembershipRow, createProjectRow, removeMembershipRow } from '../../src/projects/store.js';
import type { TicketBinding } from '../../src/auth/tickets.js';

/**
 * Deterministic seam for the events stream delivery pump (no real TCP
 * overload stress): fake sockets with controllable bufferedAmount/readyState
 * over a real SQLite event history prove the exact wire behavior for
 * midstream authorization loss (4401 + one error frame, no later payloads)
 * and the slow-consumer close (4502, NO error frame on the saturated socket).
 */

function makeDb(): DatabaseSync {
  const dir = mkdtempSync(path.join(tmpdir(), 'ranger-stream-unit-'));
  const db = openDatabase(dir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  return db;
}

interface SentFrame {
  kind: 'event' | 'error';
  raw: string;
  parsed: Record<string, unknown>;
}

class FakeSocket {
  readonly frames: SentFrame[] = [];
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;

  send(data: string): void {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    this.frames.push({ kind: parsed['kind'] === 'error' ? 'error' : 'event', raw: data, parsed });
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = WebSocket.CLOSING;
  }

  events(): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f.kind === 'event').map((f) => f.parsed);
  }

  errorFrames(): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f.kind === 'error').map((f) => f.parsed);
  }
}

function appendEvent(db: DatabaseSync, projectId: string, requestId: string, name: string): void {
  withTransaction(db, () => {
    appendProjectEvent(db, {
      projectId,
      type: 'project.updated',
      data: { name: 'P', engineerDisplayName: name },
      requestId,
    });
  });
}

interface Harness {
  db: DatabaseSync;
  projectId: string;
  binding: TicketBinding;
  ticketSecret: string;
}

/** Project + member + issuing api-token credential; ticket consumed once for the retained binding. */
function makeHarness(): Harness {
  const db = makeDb();
  const principal = createPrincipal(db, 'Subscriber');
  const project = createProjectRow(db, { name: 'P', engineerDisplayName: 'Ranger', principalId: principal.id });
  const credential = createCredential(db, principal.id, 'api_token', 'issuer');
  addMembershipRow(db, project.id, principal.id, 'member');
  const ticket = createTicket(db, {
    principalId: principal.id,
    projectId: project.id,
    purpose: 'events',
    credentialKind: 'api_token',
    credentialId: credential.credential.id,
  });
  const binding = consumeTicket(db, ticket.secret, { purpose: 'events', projectId: project.id });
  return { db, projectId: project.id, binding, ticketSecret: ticket.secret };
}

function makePump(harness: Harness, socket: FakeSocket) {
  return createEventPump({
    db: harness.db,
    projectId: harness.projectId,
    binding: harness.binding,
    requestId: 'req-test',
    socket,
  });
}

describe('events stream delivery (deterministic pump seam)', () => {
  it('delivers ordered batches across pumps while authorized, and the ticket stays single-use', () => {
    const harness = makeHarness();
    appendEvent(harness.db, harness.projectId, 'req-1', 'one');
    const socket = new FakeSocket();
    const pump = makePump(harness, socket);

    pump();
    expect(socket.events().map((e) => e['sequence'])).toEqual([1]);
    expect(socket.closes).toEqual([]);

    appendEvent(harness.db, harness.projectId, 'req-2', 'two');
    appendEvent(harness.db, harness.projectId, 'req-3', 'three');
    pump();
    expect(socket.events().map((e) => e['sequence'])).toEqual([1, 2, 3]);
    expect(socket.closes).toEqual([]);

    // The retained binding (not the ticket) drives every later batch: the
    // ticket row was marked used exactly once at upgrade and repeated pumps
    // never re-consume it — a second consume still fails single-use.
    const usedAt = (): number =>
      (harness.db.prepare('SELECT used_at FROM connection_tickets WHERE secret_lookup = (SELECT secret_lookup FROM connection_tickets WHERE id = ?)').get(harness.binding.ticketId) as { used_at: number }).used_at;
    const usedAfterUpgrade = usedAt();
    expect(usedAfterUpgrade).not.toBeNull();
    pump();
    expect(usedAt()).toBe(usedAfterUpgrade);
    let reused: unknown;
    try {
      consumeTicket(harness.db, harness.ticketSecret, { purpose: 'events' });
    } catch (cause) {
      reused = cause;
    }
    expect(isAppError(reused)).toBe(true);
    expect((reused as { code: string }).code).toBe('unauthorized');
    harness.db.close();
  });

  it('closes a slow consumer 4502 with NO error frame and never enqueues again', () => {
    const harness = makeHarness();
    appendEvent(harness.db, harness.projectId, 'req-1', 'one');
    const socket = new FakeSocket();
    socket.bufferedAmount = EVENTS_MAX_BUFFERED_BYTES + 1;
    const pump = makePump(harness, socket);

    pump();
    expect(socket.frames).toEqual([]);
    expect(socket.closes).toEqual([{ code: 4502, reason: 'slow_consumer' }]);

    // Later ticks are inert: no repeated close, no error frame, no events.
    pump();
    pump();
    expect(socket.closes).toEqual([{ code: 4502, reason: 'slow_consumer' }]);
    expect(socket.frames).toEqual([]);
    harness.db.close();
  });

  it('closes 4401 with one error frame when the issuing token is revoked midstream, before later payloads', () => {
    const harness = makeHarness();
    appendEvent(harness.db, harness.projectId, 'req-1', 'delivered');
    const socket = new FakeSocket();
    const pump = makePump(harness, socket);
    pump();
    expect(socket.events().map((e) => e['sequence'])).toEqual([1]);

    const credentialId = harness.binding.credentialId;
    expect(revokeCredential(harness.db, harness.binding.principalId, credentialId)).toBe(true);
    appendEvent(harness.db, harness.projectId, 'req-2', 'secret-later-one');
    appendEvent(harness.db, harness.projectId, 'req-3', 'secret-later-two');

    pump();
    expect(socket.closes).toEqual([{ code: 4401, reason: 'unauthorized' }]);
    const errors = socket.errorFrames();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      kind: 'error',
      requestId: 'req-test',
      error: { code: 'unauthorized', details: { reason: 'issuer_revoked' } },
    });
    // The later project payloads were never delivered.
    expect(socket.events().map((e) => e['sequence'])).toEqual([1]);
    pump();
    expect(socket.closes).toEqual([{ code: 4401, reason: 'unauthorized' }]);
    expect(socket.events()).toHaveLength(1);
    harness.db.close();
  });

  it('closes 4401 (issuer_expired) when the issuing browser session expires midstream', () => {
    const db = makeDb();
    const principal = createPrincipal(db, 'Session Subscriber');
    const project = createProjectRow(db, { name: 'P', engineerDisplayName: 'Ranger', principalId: principal.id });
    addMembershipRow(db, project.id, principal.id, 'member');
    const session = createSession(db, principal.id);
    const ticket = createTicket(db, {
      principalId: principal.id,
      projectId: project.id,
      purpose: 'events',
      credentialKind: 'browser_session',
      credentialId: session.session.id,
    });
    const binding = consumeTicket(db, ticket.secret, { purpose: 'events', projectId: project.id });

    appendEvent(db, project.id, 'req-1', 'delivered');
    const socket = new FakeSocket();
    const pump = createEventPump({ db, projectId: project.id, binding, requestId: 'req-test', socket });
    pump();
    expect(socket.events().map((e) => e['sequence'])).toEqual([1]);

    // The session expires (not revoked) after the connection was accepted.
    db.prepare('UPDATE browser_sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1_000, session.session.id);
    appendEvent(db, project.id, 'req-2', 'secret-later');

    pump();
    expect(socket.closes).toEqual([{ code: 4401, reason: 'unauthorized' }]);
    const errors = socket.errorFrames();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      kind: 'error',
      requestId: 'req-test',
      error: { code: 'unauthorized', details: { reason: 'issuer_expired' } },
    });
    expect(socket.events().map((e) => e['sequence'])).toEqual([1]);
    db.close();
  });

  it('closes 4401 (membership_removed) when the member is removed midstream, before later payloads', () => {
    const harness = makeHarness();
    appendEvent(harness.db, harness.projectId, 'req-1', 'delivered');
    const socket = new FakeSocket();
    const pump = makePump(harness, socket);
    pump();
    expect(socket.events().map((e) => e['sequence'])).toEqual([1]);

    removeMembershipRow(harness.db, harness.projectId, harness.binding.principalId);
    appendEvent(harness.db, harness.projectId, 'req-2', 'secret-later');

    pump();
    expect(socket.closes).toEqual([{ code: 4401, reason: 'unauthorized' }]);
    const errors = socket.errorFrames();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      kind: 'error',
      requestId: 'req-test',
      error: { code: 'unauthorized', details: { reason: 'membership_removed' } },
    });
    expect(socket.events().map((e) => e['sequence'])).toEqual([1]);
    harness.db.close();
  });

  it('assertEventStreamAuthorized passes for a live member and distinguishes failure reasons', () => {
    const harness = makeHarness();
    expect(() => assertEventStreamAuthorized(harness.db, harness.projectId, harness.binding)).not.toThrow();

    removeMembershipRow(harness.db, harness.projectId, harness.binding.principalId);
    try {
      assertEventStreamAuthorized(harness.db, harness.projectId, harness.binding);
      expect.unreachable('expected membership_removed');
    } catch (cause) {
      expect(isAppError(cause)).toBe(true);
      expect((cause as { code: string }).code).toBe('unauthorized');
      expect((cause as { details?: { reason?: string } }).details?.reason).toBe('membership_removed');
    }
    harness.db.close();
  });
});
