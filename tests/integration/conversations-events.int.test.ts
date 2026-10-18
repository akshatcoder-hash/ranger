import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { Ajv } from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/db.js';
import { loadConfig, type RangerConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApiServer } from '../../src/http/app.js';
import { createAdditionalPrincipal, ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { encodeEventCursor } from '../../src/events/store.js';
import { EVENT_ENVELOPE_SCHEMA, EVENT_TYPES } from '../../src/contracts/events.js';
import type { RangerProjectEvent } from '../../src/contracts/types.js';

/**
 * Conversations durability + transactional events integration tests: real
 * SQLite on temporary data directories, app restarts, HTTP cursor replay
 * and real WebSocket subscriptions on the loopback test port range.
 */

const PORT = 3906;
const EXPIRY_PORT = 3907;

async function makeApp(env: Record<string, string>, existingDataDir?: string): Promise<{ app: FastifyInstance; config: RangerConfig; dataDir: string }> {
  const dataDir = existingDataDir ?? mkdtempSync(path.join(tmpdir(), 'ranger-conv-int-'));
  const config = await loadConfig({ RANGER_DATA_DIR: dataDir, RANGER_LOG_LEVEL: 'error', ...env } as NodeJS.ProcessEnv);
  const db = openDatabase(dataDir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const app = await buildApiServer({ config, db });
  return { app, config, dataDir };
}

function readCredential(file: string): string {
  return readFileSync(file, 'utf8').trim().split('=')[1]!;
}

/** Minimal WebSocket subscriber that classifies event vs error frames. */
class Subscriber {
  readonly events: RangerProjectEvent[] = [];
  readonly errorFrames: Array<{ kind: string; requestId: string; error: { code: string; message: string; details?: Record<string, unknown> } }> = [];
  closed: { code: number; reason: string } | null = null;

  private readonly socket: WebSocket;
  private readonly waiters: Array<() => void> = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('error', () => {
      // Upgrade rejections surface as close codes; keep them out of the
      // unhandled-error channel.
    });
    this.socket.on('message', (raw) => {
      const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
      if (parsed['kind'] === 'error') {
        this.errorFrames.push(parsed as never);
      } else {
        this.events.push(parsed as unknown as RangerProjectEvent);
      }
      for (const waiter of this.waiters.splice(0)) waiter();
    });
    this.socket.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      for (const waiter of this.waiters.splice(0)) waiter();
    });
  }

  async waitEventCount(count: number, timeoutMs = 8000): Promise<RangerProjectEvent[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.events.length < count && this.closed === null && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, Math.max(1, deadline - Date.now()));
      });
    }
    return this.events;
  }

  async waitClose(timeoutMs = 8000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    while (this.closed === null && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, Math.max(1, deadline - Date.now()));
      });
    }
    if (this.closed === null) throw new Error('socket never closed');
    return this.closed;
  }

  destroy(): void {
    try {
      if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
    } catch {
      // A socket that never finished connecting may refuse terminate(); the
      // server side already closed it.
    }
  }
}

describe('conversations and transactional events', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let bearerA: Record<string, string>;
  let bearerB: Record<string, string>;

  const store: { projectId: string; otherProjectId: string; conversationId: string; questionId: string; requirementId: string; memberPrincipalId: string } = {
    projectId: '',
    otherProjectId: '',
    conversationId: '',
    questionId: '',
    requirementId: '',
    memberPrincipalId: '',
  };

  const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
  const envelopeValidate = ajv.compile(EVENT_ENVELOPE_SCHEMA);
  const dataValidators = new Map(EVENT_TYPES.map((t) => [t.name, ajv.compile(t.dataSchema)]));

  function inject(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, opts: { headers?: Record<string, string>; body?: Record<string, unknown> } = {}): Promise<{ statusCode: number; body: string; json: () => unknown }> {
    return app.inject({
      method,
      url,
      ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
      ...(opts.body !== undefined ? { payload: opts.body } : {}),
    });
  }

  /** All persisted events for the project so far (full replay, member auth). */
  async function allEvents(projectId: string, headers: Record<string, string>): Promise<RangerProjectEvent[]> {
    const collected: RangerProjectEvent[] = [];
    let cursor: string | undefined;
    for (;;) {
      const res = await inject('GET', `/v1/projects/${projectId}/events?limit=100${cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { events: RangerProjectEvent[]; nextCursor: string | null; hasMore: boolean };
      collected.push(...body.events);
      if (!body.hasMore || body.nextCursor === null) break;
      cursor = body.nextCursor;
    }
    return collected;
  }

  beforeAll(async () => {
    const made = await makeApp({});
    app = made.app;
    dataDir = made.dataDir;
    const bootstrapDb = openDatabase(dataDir);
    const owner = ensureInitialPrincipal(bootstrapDb, {
      dataDir,
      repoRoot: process.cwd(),
      displayName: 'Owner Driver',
    });
    const member = createAdditionalPrincipal(bootstrapDb, {
      repoRoot: process.cwd(),
      displayName: 'Team Member',
      credentialPath: path.join(mkdtempSync(path.join(tmpdir(), 'ranger-conv-cred-')), 'member-credential.txt'),
    });
    bootstrapDb.close();
    store.memberPrincipalId = member.principalId;
    bearerA = { authorization: `Bearer ${readCredential(owner.credentialPath)}` };
    bearerB = { authorization: `Bearer ${readCredential(member.credentialPath)}` };
  });

  afterAll(async () => {
    await app.close();
  });

  it('persists conversations, messages, questions, answers and versions with one schema-valid event per mutation', async () => {
    // Projects: the owner creates two; the second proves isolation.
    const first = await inject('POST', '/v1/projects', { headers: bearerA, body: { name: 'Events Project', engineerDisplayName: 'Ranger' } });
    expect(first.statusCode).toBe(200);
    store.projectId = (first.json() as { project: { projectId: string } }).project.projectId;
    const second = await inject('POST', '/v1/projects', { headers: bearerA, body: { name: 'Other Project', engineerDisplayName: 'Other' } });
    store.otherProjectId = (second.json() as { project: { projectId: string } }).project.projectId;

    // VAL-API-005 flow: set name, add member, member reads.
    const renamed = await inject('PATCH', `/v1/projects/${store.projectId}`, {
      headers: bearerA,
      body: { engineerDisplayName: 'Ranger Prime' },
    });
    expect(renamed.statusCode).toBe(200);
    const added = await inject('POST', `/v1/projects/${store.projectId}/memberships`, {
      headers: bearerA,
      body: { principalId: store.memberPrincipalId, role: 'member' },
    });
    expect(added.statusCode).toBe(200);

    // Conversations.
    const cnv = await inject('POST', `/v1/projects/${store.projectId}/conversations`, { headers: bearerA, body: { title: 'Integration thread' } });
    expect(cnv.statusCode).toBe(200);
    store.conversationId = (cnv.json() as { conversation: { conversationId: string } }).conversation.conversationId;

    const msg1 = await inject('POST', `/v1/projects/${store.projectId}/conversations/${store.conversationId}/messages`, {
      headers: bearerA,
      body: { role: 'user', content: 'Integrate the support inbox' },
    });
    const msg2 = await inject('POST', `/v1/projects/${store.projectId}/conversations/${store.conversationId}/messages`, {
      headers: bearerA,
      body: { role: 'agent', content: 'Understood; I will ask clarifying questions' },
    });
    expect(msg1.statusCode).toBe(200);
    expect(msg2.statusCode).toBe(200);

    const question = await inject('POST', `/v1/projects/${store.projectId}/conversations/${store.conversationId}/questions`, {
      headers: bearerA,
      body: { prompt: 'Which refund policy applies?' },
    });
    expect(question.statusCode).toBe(200);
    store.questionId = (question.json() as { question: { questionId: string } }).question.questionId;

    const answer = await inject('POST', `/v1/projects/${store.projectId}/conversations/${store.conversationId}/questions/${store.questionId}/answers`, {
      headers: bearerA,
      body: { content: 'Policy v3' },
    });
    expect(answer.statusCode).toBe(200);
    expect((answer.json() as { answer: { questionId: string } }).answer.questionId).toBe(store.questionId);

    const req1 = await inject('POST', `/v1/projects/${store.projectId}/requirements`, {
      headers: bearerA,
      body: { content: 'Ask a human before refunds' },
    });
    expect(req1.statusCode).toBe(200);
    store.requirementId = (req1.json() as { requirement: { requirementId: string } }).requirement.requirementId;
    const req2 = await inject('POST', `/v1/projects/${store.projectId}/requirements`, {
      headers: bearerA,
      body: { content: 'Also dedupe tickets', requirementId: store.requirementId },
    });
    expect(req2.statusCode).toBe(200);
    const requirement = (req2.json() as { requirement: { currentVersion: number; versions: unknown[] } }).requirement;
    expect(requirement.currentVersion).toBe(2);
    expect(requirement.versions).toHaveLength(2);

    // Member reads see the persisted engineer name (VAL-API-005).
    const memberRead = await inject('GET', `/v1/projects/${store.projectId}`, { headers: bearerB });
    expect(memberRead.statusCode).toBe(200);
    expect((memberRead.json() as { project: { engineerDisplayName: string } }).project.engineerDisplayName).toBe('Ranger Prime');

    // Every mutation so far produced exactly one schema-valid event, in order.
    const events = await allEvents(store.projectId, bearerA);
    const expectedTypes = [
      'project.updated',
      'membership.updated',
      'conversation.created',
      'conversation.message.created',
      'conversation.message.created',
      'conversation.question.created',
      'conversation.answer.created',
      'requirement.version.created',
      'requirement.version.created',
    ];
    expect(events.map((e) => e.type)).toEqual(expectedTypes);
    for (const event of events) {
      expect(envelopeValidate(event), `envelope schema for ${event.type}`).toBe(true);
      const validateData = dataValidators.get(event.type);
      expect(validateData !== undefined, `declared schema for ${event.type}`).toBe(true);
      expect(validateData!(event.data), `data schema for ${event.type}`).toBe(true);
    }
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]!.sequence).toBe(events[i - 1]!.sequence + 1);
    }
    // The rename event carries the new values members will see.
    const renameEvent = events.find((e) => e.type === 'project.updated');
    expect(renameEvent?.data).toEqual({ name: 'Events Project', engineerDisplayName: 'Ranger Prime' });
    // The membership event carries the targeted principal and role.
    const membershipEvent = events.find((e) => e.type === 'membership.updated');
    expect(membershipEvent?.data).toEqual({ principalId: store.memberPrincipalId, role: 'member' });
  });

  it('isolates the second project and denies non-members', async () => {
    const events = await allEvents(store.otherProjectId, bearerA);
    expect(events).toEqual([]);
    const denied = await inject('GET', `/v1/projects/${store.otherProjectId}/events`, { headers: bearerB });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { error: { code: string } }).error.code).toBe('forbidden');
    const foreign = await inject('GET', `/v1/projects/${store.otherProjectId}/conversations`, { headers: bearerB });
    expect(foreign.statusCode).toBe(403);
  });

  it('retries idempotent mutations exactly once and conflicts on key reuse with different input', async () => {
    const key = { 'idempotency-key': 'msg-retry-1' };
    const first = await inject('POST', `/v1/projects/${store.projectId}/conversations/${store.conversationId}/messages`, {
      headers: { ...bearerA, ...key },
      body: { role: 'user', content: 'Exactly once' },
    });
    expect(first.statusCode).toBe(200);
    const messageId = (first.json() as { message: { messageId: string } }).message.messageId;

    const retry = await inject('POST', `/v1/projects/${store.projectId}/conversations/${store.conversationId}/messages`, {
      headers: { ...bearerA, ...key },
      body: { role: 'user', content: 'Exactly once' },
    });
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as { message: { messageId: string } }).message.messageId).toBe(messageId);

    const conflict = await inject('POST', `/v1/projects/${store.projectId}/conversations/${store.conversationId}/messages`, {
      headers: { ...bearerA, ...key },
      body: { role: 'user', content: 'Different content, same key' },
    });
    expect(conflict.statusCode).toBe(409);
    const conflictBody = conflict.json() as { requestId: string; error: { code: string } };
    expect(conflictBody.error.code).toBe('conflict');
    expect(conflictBody.requestId).toBeTruthy();

    // Exactly one event and one row for the duplicate posts.
    const events = await allEvents(store.projectId, bearerA);
    const messageEvents = events.filter((e) => e.type === 'conversation.message.created');
    expect(messageEvents).toHaveLength(3); // two from the first test + the idempotent one
    const list = await inject('GET', `/v1/projects/${store.projectId}/conversations/${store.conversationId}/messages`, { headers: bearerA });
    const messages = (list.json() as { messages: Array<{ content: string }> }).messages;
    expect(messages.filter((m) => m.content === 'Exactly once')).toHaveLength(1);
  });

  it('keeps conversation data unchanged across an API restart on the same data dir', async () => {
    const withoutRequestId = (body: unknown): unknown => {
      const { requestId: _omitted, ...rest } = body as Record<string, unknown>;
      void _omitted;
      return rest;
    };
    const before = {
      conversations: withoutRequestId((await inject('GET', `/v1/projects/${store.projectId}/conversations`, { headers: bearerA })).json()),
      messages: withoutRequestId((await inject('GET', `/v1/projects/${store.projectId}/conversations/${store.conversationId}/messages`, { headers: bearerA })).json()),
      requirements: withoutRequestId((await inject('GET', `/v1/projects/${store.projectId}/requirements`, { headers: bearerA })).json()),
    };

    await app.close();
    const restarted = await makeApp({}, dataDir);
    app = restarted.app;

    const after = {
      conversations: withoutRequestId((await inject('GET', `/v1/projects/${store.projectId}/conversations`, { headers: bearerA })).json()),
      messages: withoutRequestId((await inject('GET', `/v1/projects/${store.projectId}/conversations/${store.conversationId}/messages`, { headers: bearerA })).json()),
      requirements: withoutRequestId((await inject('GET', `/v1/projects/${store.projectId}/requirements`, { headers: bearerA })).json()),
    };
    expect(after).toEqual(before);
    const project = await inject('GET', `/v1/projects/${store.projectId}`, { headers: bearerA });
    expect((project.json() as { project: { engineerDisplayName: string } }).project.engineerDisplayName).toBe('Ranger Prime');
  });

  it('replays pages in order, rejects invalid and ahead-of-head cursors, and replay changes no state', async () => {
    const head = await allEvents(store.projectId, bearerA);
    const headCount = head.length;

    // Paged replay assembles the exact same ordered list (no gaps, no dups).
    const paged: RangerProjectEvent[] = [];
    let cursor: string | undefined;
    for (;;) {
      const res = await inject('GET', `/v1/projects/${store.projectId}/events?limit=2${cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: bearerA });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { events: RangerProjectEvent[]; nextCursor: string | null; hasMore: boolean };
      paged.push(...body.events);
      if (!body.hasMore || body.nextCursor === null) break;
      cursor = body.nextCursor;
    }
    expect(paged).toEqual(head);

    // Invalid cursor: explicit documented error, not a silent resync.
    const invalid = await inject('GET', `/v1/projects/${store.projectId}/events?cursor=garbage!!`, { headers: bearerA });
    expect(invalid.statusCode).toBe(400);
    expect((invalid.json() as { error: { code: string } }).error.code).toBe('invalid_cursor');

    const ahead = await inject('GET', `/v1/projects/${store.projectId}/events?cursor=${encodeURIComponent(encodeEventCursor(9_999, Date.now()))}`, { headers: bearerA });
    expect(ahead.statusCode).toBe(400);
    expect((ahead.json() as { error: { code: string } }).error.code).toBe('invalid_cursor');

    // Replay is a pure read: head unchanged, no jobs (no tools invoked).
    const afterReplay = await allEvents(store.projectId, bearerA);
    expect(afterReplay).toHaveLength(headCount);
    const freshDb = openDatabase(dataDir);
    try {
      const jobs = freshDb.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number };
      expect(jobs.count).toBe(0);
    } finally {
      freshDb.close();
    }
  });

  it('delivers live events over ticket-authenticated WebSocket and recovers by cursor after a disconnect', async () => {
    await app.listen({ host: '127.0.0.1', port: PORT });
    const ticketRes = await inject('POST', '/v1/auth/connection-tickets', {
      headers: bearerA,
      body: { projectId: store.projectId, purpose: 'events' },
    });
    expect(ticketRes.statusCode).toBe(200);
    const ticket = (ticketRes.json() as { ticket: string }).ticket;

    // Full replay through the socket, then live delivery.
    const firstSubscriber = new Subscriber(`ws://127.0.0.1:${PORT}/v1/projects/${store.projectId}/events/subscribe?ticket=${encodeURIComponent(ticket)}`);
    try {
      const before = await allEvents(store.projectId, bearerA);
      await firstSubscriber.waitEventCount(before.length);
      expect(firstSubscriber.events.map((e) => e.sequence)).toEqual(before.map((e) => e.sequence));
      expect(firstSubscriber.closed).toBeNull();

      // A live mutation arrives in order after the replay.
      const live = await inject('POST', `/v1/projects/${store.projectId}/conversations/${store.conversationId}/messages`, {
        headers: bearerA,
        body: { role: 'user', content: 'live one' },
      });
      expect(live.statusCode).toBe(200);
      await firstSubscriber.waitEventCount(before.length + 1);
      const lastLive = firstSubscriber.events[firstSubscriber.events.length - 1]!;
      expect(lastLive.type).toBe('conversation.message.created');

      // Kill the socket, produce two more events, reconnect with the cursor.
      firstSubscriber.destroy();
      await inject('POST', `/v1/projects/${store.projectId}/conversations/${store.conversationId}/messages`, {
        headers: bearerA,
        body: { role: 'user', content: 'missed one' },
      });
      await inject('POST', `/v1/projects/${store.projectId}/conversations/${store.conversationId}/messages`, {
        headers: bearerA,
        body: { role: 'agent', content: 'missed two' },
      });

      const ticket2Res = await inject('POST', '/v1/auth/connection-tickets', {
        headers: bearerA,
        body: { projectId: store.projectId, purpose: 'events' },
      });
      const ticket2 = (ticket2Res.json() as { ticket: string }).ticket;
      // Cursor from the last observed event: replay resumes strictly after it.
      const resumeCursor = encodeEventCursor(lastLive.sequence, Date.parse(lastLive.timestamp));
      const secondSubscriber = new Subscriber(`ws://127.0.0.1:${PORT}/v1/projects/${store.projectId}/events/subscribe?ticket=${encodeURIComponent(ticket2)}&cursor=${encodeURIComponent(resumeCursor)}`);
      try {
        await secondSubscriber.waitEventCount(2);
        const sequences = secondSubscriber.events.map((e) => e.sequence);
        expect(sequences).toEqual([lastLive.sequence + 1, lastLive.sequence + 2]);
        expect(secondSubscriber.events.every((e) => e.type === 'conversation.message.created')).toBe(true);
      } finally {
        secondSubscriber.destroy();
      }

      // The store saw each message exactly once (no duplicate effects).
      const eventsAfter = await allEvents(store.projectId, bearerA);
      const messageEvents = eventsAfter.filter((e) => e.type === 'conversation.message.created');
      expect(messageEvents).toHaveLength(6);
    } finally {
      firstSubscriber.destroy();
    }
  });

  it('rejects WebSocket subscriptions without a valid ticket or current membership with zero events', async () => {
    const subscribeUrl = (query: string): string => `ws://127.0.0.1:${PORT}/v1/projects/${store.projectId}/events/subscribe${query}`;

    // No ticket at all.
    const noTicket = new Subscriber(subscribeUrl(''));
    try {
      const noTicketClose = await noTicket.waitClose();
      expect(noTicketClose.code).toBe(4401);
      expect(noTicket.errorFrames[0]?.error.code).toBe('unauthorized');
      expect(noTicket.events).toEqual([]);
    } finally {
      noTicket.destroy();
    }

    // Wrong purpose ticket.
    const wrongPurpose = await inject('POST', '/v1/auth/connection-tickets', {
      headers: bearerA,
      body: { projectId: store.projectId, purpose: 'voice-relay' },
    });
    const wrongPurposeSubscriber = new Subscriber(subscribeUrl(`?ticket=${encodeURIComponent((wrongPurpose.json() as { ticket: string }).ticket)}`));
    try {
      const wrongPurposeClose = await wrongPurposeSubscriber.waitClose();
      expect(wrongPurposeClose.code).toBe(4401);
      expect(wrongPurposeSubscriber.events).toEqual([]);
    } finally {
      wrongPurposeSubscriber.destroy();
    }

    // Valid ticket bound to ANOTHER project: no delivery on this project's URL.
    const wrongProjectTicket = await inject('POST', '/v1/auth/connection-tickets', {
      headers: bearerA,
      body: { projectId: store.otherProjectId, purpose: 'events' },
    });
    const wrongProjectSubscriber = new Subscriber(subscribeUrl(`?ticket=${encodeURIComponent((wrongProjectTicket.json() as { ticket: string }).ticket)}`));
    try {
      const wrongProjectClose = await wrongProjectSubscriber.waitClose();
      expect(wrongProjectClose.code).toBe(4401);
      expect(wrongProjectSubscriber.events).toEqual([]);
    } finally {
      wrongProjectSubscriber.destroy();
    }

    // Removed member: current membership is enforced at upgrade even though
    // the ticket itself is valid and unused — zero events, explicit close.
    // The ticket is issued while the principal IS still a member.
    const memberTicket = await inject('POST', '/v1/auth/connection-tickets', {
      headers: bearerB,
      body: { projectId: store.projectId, purpose: 'events' },
    });
    expect(memberTicket.statusCode).toBe(200);

    const removed = await inject('DELETE', `/v1/projects/${store.projectId}/memberships/${store.memberPrincipalId}`, { headers: bearerA });
    expect(removed.statusCode).toBe(200);
    const removedEvents = await allEvents(store.projectId, bearerA);
    const removalEvent = removedEvents.find((e) => e.type === 'membership.updated' && e.data['role'] === null);
    expect(removalEvent).toBeDefined();

    const removedSubscriber = new Subscriber(subscribeUrl(`?ticket=${encodeURIComponent((memberTicket.json() as { ticket: string }).ticket)}`));
    try {
      const removedClose = await removedSubscriber.waitClose();
      expect(removedClose.code).toBe(4401);
      expect(removedSubscriber.events).toEqual([]);
    } finally {
      removedSubscriber.destroy();
    }

    // Ticket reuse (single-use): the second upgrade fails with zero events.
    const reuseTicket = await inject('POST', '/v1/auth/connection-tickets', {
      headers: bearerA,
      body: { projectId: store.projectId, purpose: 'events' },
    });
    const reuseSecret = (reuseTicket.json() as { ticket: string }).ticket;
    const firstUse = new Subscriber(subscribeUrl(`?ticket=${encodeURIComponent(reuseSecret)}`));
    try {
      await firstUse.waitEventCount(1); // accepted; history replays
      firstUse.destroy();
      const secondUse = new Subscriber(subscribeUrl(`?ticket=${encodeURIComponent(reuseSecret)}`));
      try {
        const secondUseClose = await secondUse.waitClose();
        expect(secondUseClose.code).toBe(4401);
        expect(secondUse.events).toEqual([]);
      } finally {
        secondUse.destroy();
      }
    } finally {
      firstUse.destroy();
    }
  });

  it('answers invalid and expired WS cursors with explicit close codes, never silent gaps', async () => {
    // Invalid cursor on the main app (a valid ticket must be presented
    // first; cursor validation happens after authentication).
    const invalidTicket = await inject('POST', '/v1/auth/connection-tickets', {
      headers: bearerA,
      body: { projectId: store.projectId, purpose: 'events' },
    });
    const invalid = new Subscriber(`ws://127.0.0.1:${PORT}/v1/projects/${store.projectId}/events/subscribe?ticket=${encodeURIComponent((invalidTicket.json() as { ticket: string }).ticket)}&cursor=garbage`);
    try {
      const invalidClose = await invalid.waitClose();
      expect(invalidClose.code).toBe(4400);
      expect(invalid.errorFrames[0]?.error.code).toBe('invalid_cursor');
      expect(invalid.events).toEqual([]);
    } finally {
      invalid.destroy();
    }

    // Expired cursor on an app configured with a 1ms replay window.
    const expiryDir = mkdtempSync(path.join(tmpdir(), 'ranger-expiry-int-'));
    const configFile = path.join(expiryDir, 'config.json');
    writeFileSync(configFile, JSON.stringify({ limits: { eventReplayWindowMs: 1 } }));
    // The app must open the SAME data dir whose config file we wrote.
    const expiryApp = (await makeApp({ RANGER_CONFIG_FILE: configFile }, expiryDir)).app;
    const bootstrapDb = openDatabase(expiryDir);
    runMigrations(bootstrapDb, path.join(process.cwd(), 'migrations'));
    const owner = ensureInitialPrincipal(bootstrapDb, {
      dataDir: expiryDir,
      repoRoot: process.cwd(),
      displayName: 'Expiry Driver',
    });
    bootstrapDb.close();
    const expiryHeaders = { authorization: `Bearer ${readCredential(owner.credentialPath)}` };
    const project = await expiryApp.inject({ method: 'POST', url: '/v1/projects', headers: expiryHeaders, payload: { name: 'Expiry', engineerDisplayName: 'E' } });
    expect(project.statusCode, project.body).toBe(200);
    const projectId = (project.json() as { project: { projectId: string } }).project.projectId;
    await expiryApp.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/conversations`,
      headers: expiryHeaders,
      payload: { title: 'T' },
    });

    await expiryApp.listen({ host: '127.0.0.1', port: EXPIRY_PORT });
    try {
      const ticketRes = await expiryApp.inject({
        method: 'POST',
        url: '/v1/auth/connection-tickets',
        headers: expiryHeaders,
        payload: { projectId, purpose: 'events' },
      });
      const ticket = (ticketRes.json() as { ticket: string }).ticket;
      // Wait out the 1ms replay window, then connect with a stale cursor.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const expired = new Subscriber(`ws://127.0.0.1:${EXPIRY_PORT}/v1/projects/${projectId}/events/subscribe?ticket=${encodeURIComponent(ticket)}&cursor=${encodeURIComponent(encodeEventCursor(1, Date.now() - 5_000))}`);
      try {
        const expiredClose = await expired.waitClose();
        expect(expiredClose.code).toBe(4410);
        expect(expired.errorFrames[0]?.error.code).toBe('cursor_expired');
        expect(expired.events).toEqual([]);
      } finally {
        expired.destroy();
      }
    } finally {
      await expiryApp.close();
    }
  });
});
