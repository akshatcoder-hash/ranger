import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Ajv } from 'ajv';
import { afterAll, describe, expect, it } from 'vitest';
import { RangerApiError, RangerClient } from '../../src/clients/ranger-client.js';
import { EVENT_ENVELOPE_SCHEMA } from '../../src/contracts/events.js';
import type { RangerProjectEvent } from '../../src/contracts/types.js';

/**
 * End-to-end events and engineer-name workflow over the REAL public API with
 * the generated typed client alone: project with engineer display name →
 * membership → member visibility → transactional events → ticket-gated
 * WebSocket subscription with cursor recovery → API process restart with all
 * values intact.
 *
 * Evidence rules: bearer credentials are read from their protected files by
 * the driver (the documented contract) and never printed.
 */

const PORT = 3908;
const BASE = `http://127.0.0.1:${PORT}`;

const baseTmp = mkdtempSync(path.join(tmpdir(), 'ranger-events-e2e-'));
const apiDataDir = path.join(baseTmp, 'data');
mkdirSync(apiDataDir, { recursive: true });
const memberCredentialPath = path.join(baseTmp, 'member-credential.txt');
const outsiderCredentialPath = path.join(baseTmp, 'outsider-credential.txt');

/** Ordered single-file flow state. */
const store: { ownerToken: string; memberToken: string; memberPrincipalId: string; projectId: string; conversationId: string } = {
  ownerToken: '',
  memberToken: '',
  memberPrincipalId: '',
  projectId: '',
  conversationId: '',
};

let api: ChildProcess | undefined;

function startApi(): ChildProcess {
  return spawn('node', ['dist/src/entrypoints/api.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RANGER_LOG_LEVEL: 'error',
      RANGER_DATA_DIR: apiDataDir,
      RANGER_HOST: '127.0.0.1',
      RANGER_PORT: String(PORT),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

async function stopApi(): Promise<void> {
  const running = api;
  if (running !== undefined && running.exitCode === null) {
    running.kill('SIGTERM');
    await new Promise((resolve) => running.once('exit', resolve));
  }
  api = undefined;
}

async function waitForHealth(client: RangerClient, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      await client.getHealth();
      return;
    } catch (cause) {
      lastError = String(cause);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`api never became healthy: ${lastError}`);
}

function credentialFrom(file: string): string {
  return readFileSync(file, 'utf8').trim().split('=')[1]!;
}

function runBootstrap(args: string[]): string {
  return execFileSync('node', ['dist/scripts/bootstrap.js', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, RANGER_LOG_LEVEL: 'error', RANGER_DATA_DIR: apiDataDir },
    encoding: 'utf8',
  });
}

function expectApiError(cause: unknown, code: string, status: number): void {
  expect(cause).toBeInstanceOf(RangerApiError);
  expect((cause as RangerApiError).code).toBe(code);
  expect((cause as RangerApiError).status).toBe(status);
}

afterAll(async () => {
  await stopApi();
});

describe('events e2e over the public API', () => {
  it('bootstraps owner, member and outsider principals through the real CLI', () => {
    const first = runBootstrap(['--create-principal', 'Owner']);
    expect(first).toContain('principal:');
    const second = runBootstrap(['--additional-principal', 'Member', '--credential-file', memberCredentialPath]);
    expect(second).toContain('principal:');
    runBootstrap(['--additional-principal', 'Outsider', '--credential-file', outsiderCredentialPath]);
    store.ownerToken = credentialFrom(path.join(apiDataDir, 'bootstrap-credential.txt'));
    store.memberToken = credentialFrom(memberCredentialPath);
  });

  it('creates the project, sets the engineer name and adds the member with the typed client', async () => {
    api = startApi();
    const owner = new RangerClient({ baseUrl: BASE, headers: { authorization: `Bearer ${store.ownerToken}` } });
    const member = new RangerClient({ baseUrl: BASE, headers: { authorization: `Bearer ${store.memberToken}` } });
    await waitForHealth(owner);

    const me = await member.getPrincipal();
    store.memberPrincipalId = me.principalId;

    const created = await owner.createProject({ body: { name: 'Events E2E Project', engineerDisplayName: 'Ranger' } });
    store.projectId = created.project.projectId;

    // The customer-configurable engineer name change carries through reads.
    const renamed = await owner.updateProject({ path: { projectId: store.projectId }, body: { engineerDisplayName: 'Ranger E2E' } });
    expect(renamed.project.engineerDisplayName).toBe('Ranger E2E');

    // Member management: the member can now read the project.
    const added = await owner.addMembership({ path: { projectId: store.projectId }, body: { principalId: store.memberPrincipalId, role: 'member' } });
    expect(added.membership.role).toBe('member');
    const memberRead = await member.getProject({ path: { projectId: store.projectId } });
    expect(memberRead.project.engineerDisplayName).toBe('Ranger E2E');

    // A member message drives conversation events.
    const conversation = await member.createConversation({ path: { projectId: store.projectId }, body: { title: 'E2E thread' } });
    store.conversationId = conversation.conversation.conversationId;
    await member.postMessage({ path: { projectId: store.projectId, conversationId: store.conversationId }, body: { role: 'user', content: 'first' } });

    // Public replay shows the rename event carrying the new values, visible
    // to the member.
    const replay = await member.replayProjectEvents({ path: { projectId: store.projectId }, query: { limit: '100' } });
    const types = replay.events.map((e) => e.type);
    expect(types).toContain('project.updated');
    expect(types).toContain('membership.updated');
    const rename = replay.events.find((e) => e.type === 'project.updated');
    expect(rename?.data).toMatchObject({ engineerDisplayName: 'Ranger E2E' });
    // Sequences strictly increase with no gaps.
    for (let i = 1; i < replay.events.length; i += 1) {
      expect(replay.events[i]!.sequence).toBe(replay.events[i - 1]!.sequence + 1);
    }
  });

  it('delivers live events over the ticket-gated WebSocket and recovers by cursor after a kill', async () => {
    const owner = new RangerClient({ baseUrl: BASE, headers: { authorization: `Bearer ${store.ownerToken}` } });
    const member = new RangerClient({ baseUrl: BASE, headers: { authorization: `Bearer ${store.memberToken}` } });

    const ticket = await member.createConnectionTicket({ body: { projectId: store.projectId, purpose: 'events' } });
    expect(ticket.ticket).toBeTruthy();

    const received: RangerProjectEvent[] = [];
    const socket = owner.openSubscribeProjectEvents(
      { path: { projectId: store.projectId }, query: { ticket: ticket.ticket } },
      { onEvent: (event) => received.push(event) },
    );

    // Full history replays through the socket.
    const before = await owner.replayProjectEvents({ path: { projectId: store.projectId }, query: { limit: '100' } });
    const deadline = Date.now() + 8000;
    while (received.length < before.events.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(received.map((e) => e.sequence)).toEqual(before.events.map((e) => e.sequence));

    // Live delivery in order.
    await member.postMessage({ path: { projectId: store.projectId, conversationId: store.conversationId }, body: { role: 'user', content: 'live' } });
    const liveDeadline = Date.now() + 8000;
    while (received.length <= before.events.length && Date.now() < liveDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const lastLive = received[received.length - 1]!;
    expect(lastLive.type).toBe('conversation.message.created');

    // Kill the socket hard, produce two events while disconnected.
    socket.terminate();
    await member.postMessage({ path: { projectId: store.projectId, conversationId: store.conversationId }, body: { role: 'user', content: 'missed A' } });
    await member.postMessage({ path: { projectId: store.projectId, conversationId: store.conversationId }, body: { role: 'agent', content: 'missed B' } });

    const ticket2 = await member.createConnectionTicket({ body: { projectId: store.projectId, purpose: 'events' } });
    const missed: RangerProjectEvent[] = [];
    const resume = owner.openSubscribeProjectEvents(
      {
        path: { projectId: store.projectId },
        query: { ticket: ticket2.ticket, cursor: Buffer.from(JSON.stringify({ v: 1, seq: lastLive.sequence, ts: Date.parse(lastLive.timestamp) })).toString('base64url') },
      },
      { onEvent: (event) => missed.push(event) },
    );
    const missedDeadline = Date.now() + 8000;
    while (missed.length < 2 && Date.now() < missedDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    resume.terminate();
    expect(missed.map((e) => e.sequence)).toEqual([lastLive.sequence + 1, lastLive.sequence + 2]);
    expect(missed.every((e) => e.type === 'conversation.message.created')).toBe(true);
  });

  it('keeps the project, name, membership and event history across an API restart', async () => {
    await stopApi();
    api = startApi();
    const member = new RangerClient({ baseUrl: BASE, headers: { authorization: `Bearer ${store.memberToken}` } });
    await waitForHealth(member);

    const memberRead = await member.getProject({ path: { projectId: store.projectId } });
    expect(memberRead.project.engineerDisplayName).toBe('Ranger E2E');
    const conversations = await member.listConversations({ path: { projectId: store.projectId } });
    expect(conversations.conversations.map((c) => c.conversationId)).toContain(store.conversationId);

    // The whole history is still replayable after the restart and every
    // event still validates against the declared envelope schema.
    const replay = await member.replayProjectEvents({ path: { projectId: store.projectId }, query: { limit: '100' } });
    expect(replay.events.length).toBeGreaterThanOrEqual(6);
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    for (const event of replay.events) {
      expect(ajv.compile(EVENT_ENVELOPE_SCHEMA)(event), `envelope for ${event.type}`).toBe(true);
    }
  });

  it('denies a non-member replay and subscription with the standard envelope', async () => {
    const outsider = new RangerClient({ baseUrl: BASE, headers: { authorization: `Bearer ${credentialFrom(outsiderCredentialPath)}` } });

    let caught: unknown;
    try {
      await outsider.replayProjectEvents({ path: { projectId: store.projectId } });
    } catch (cause) {
      caught = cause;
    }
    expectApiError(caught, 'forbidden', 403);

    const frames: RangerProjectEvent[] = [];
    const errors: Array<{ code: string }> = [];
    let closeCode: number | null = null;
    const socket = outsider.openSubscribeProjectEvents(
      { path: { projectId: store.projectId }, query: {} },
      {
        onEvent: (event) => {
          const parsed = event as unknown as Record<string, unknown>;
          if (parsed['kind'] === 'error') errors.push(parsed['error'] as { code: string });
          else frames.push(event);
        },
        onClose: (code) => {
          closeCode = code;
        },
      },
    );
    const deadline = Date.now() + 8000;
    while (closeCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    socket.terminate();
    expect(closeCode).toBe(4401);
    expect(frames).toEqual([]);
    expect(errors[0]?.code).toBe('unauthorized');
  });
});
