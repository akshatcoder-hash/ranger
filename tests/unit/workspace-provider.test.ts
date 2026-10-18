import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLedger } from '../../src/budget/ledger.js';
import {
  FakeInstabox,
  InstaboxWorkspace,
  type InstaboxProvider,
  type ProviderCreateRequest,
} from '../../src/workspace/instabox.js';

/**
 * Deterministic Instabox provider-wire tests.
 *
 * The fake provider records calls and never dials Instabox. Live VM evidence
 * is a separate, explicitly labeled suite and is not implied by these cases.
 */

function fixtureLedger(): Record<string, unknown> {
  return {
    version: 1,
    xai: { limitUsd: 5, softAdmissionUsd: 4, observedUsd: 0, reservedUsd: 0, operations: [] },
    instabox: {
      maxAdditionalCreations: 6,
      maxConcurrent: 1,
      maxLifetimeSeconds: 600,
      additionalCreations: 0,
      machines: [],
    },
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function ledgerFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ranger-ws-ledger-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'provider-budget.json');
  writeFileSync(file, JSON.stringify(fixtureLedger()));
  return file;
}

function workspace(provider: InstaboxProvider, file = ledgerFile()): InstaboxWorkspace {
  return new InstaboxWorkspace({
    provider,
    ledgerFile: file,
    feature: 'lean-instabox-workspace-viewing',
    now: () => 1_700_000_000_000,
  });
}

describe('instabox workspace provider wire (deterministic, not live)', () => {
  it('reserves before create, records vault:false and the kill timeout, and confirms the id', async () => {
    const provider = new FakeInstabox();
    const file = ledgerFile();
    const ws = workspace(provider, file);
    const created = await ws.create({ projectId: 'prj_1', operationKey: 'op-1' });
    expect(created.machineId).toBe('m_fake_1');
    expect(created.vault).toBe(false);
    expect(created.killTimeoutMs).toBe(600_000);
    expect(created.onTimeout).toBe('kill');
    const request = provider.creates[0] as ProviderCreateRequest;
    expect(request.vault).toBe(false);
    expect(request.timeoutMs).toBe(600_000);
    expect(request.onTimeout).toBe('kill');
    expect(request.template).toBe('agent-browser');
    expect(request.envs).toBeUndefined();
    const ledger = readLedger(file);
    expect(ledger.instabox.additionalCreations).toBe(1);
    expect(ledger.instabox.machines[0]?.machineId).toBe('m_fake_1');
    expect(ledger.instabox.pendingReservations ?? []).toHaveLength(0);
  });

  it('does not create again after an ambiguous create and resolves the recorded identity', async () => {
    const provider = new FakeInstabox();
    provider.failNextCreateAmbiguous('m_ambiguous');
    const ws = workspace(provider);
    await expect(ws.create({ projectId: 'prj_1', operationKey: 'op-ambiguous' })).rejects.toThrow(/uncertain/i);
    expect(provider.creates).toHaveLength(1);
    const resolved = await ws.resolveUncertain('op-ambiguous');
    expect(resolved?.machineId).toBe('m_ambiguous');
    await expect(ws.create({ projectId: 'prj_1', operationKey: 'op-ambiguous' })).rejects.toThrow(/uncertain|already/i);
    expect(provider.creates).toHaveLength(1);
    expect(provider.kills).toEqual([]);
  });

  it('releases the reservation when create fails before any machine exists', async () => {
    const provider = new FakeInstabox();
    provider.failNextCreateDefinite();
    const file = ledgerFile();
    const ws = workspace(provider, file);
    await expect(ws.create({ projectId: 'prj_1', operationKey: 'op-fail' })).rejects.toThrow(/unavailable/i);
    expect(provider.creates).toHaveLength(1);
    const ledger = readLedger(file);
    expect(ledger.instabox.additionalCreations).toBe(0);
    expect(ledger.instabox.pendingReservations ?? []).toHaveLength(0);
    const retry = await ws.create({ projectId: 'prj_1', operationKey: 'op-retry' });
    expect(retry.machineId).toBe('m_fake_1');
  });

  it('runs workload commands as the restricted identity and records bounded output', async () => {
    const provider = new FakeInstabox();
    const ws = workspace(provider);
    await ws.create({ projectId: 'prj_1', operationKey: 'op-1' });
    const finished = await ws.runCommand({
      projectId: 'prj_1',
      commandId: 'cmd_1',
      argv: ['echo', 'hello'],
      timeoutMs: 5_000,
    });
    expect(finished.exitCode).toBe(0);
    expect(finished.stdout).toContain('hello');
    const executed = provider.commands[0];
    expect(executed?.user).toBe('ranger');
    expect(executed?.command).toContain('runuser');
    expect(executed?.command).not.toContain('INSTABOX_API_KEY');
    expect(executed?.envs === undefined || !('INSTABOX_API_KEY' in executed.envs)).toBe(true);
  });

  it('terminates a TERM-ignoring descendant with KILL and confirms it is gone', async () => {
    const provider = new FakeInstabox();
    const ws = workspace(provider);
    await ws.create({ projectId: 'prj_1', operationKey: 'op-1' });
    const handle = await ws.startBackground({
      projectId: 'prj_1',
      commandId: 'cmd_tree',
      argv: ['sh', '-c', 'sleep 30 & wait'],
      timeoutMs: 30_000,
    });
    provider.markTermIgnoring(handle.pid);
    const outcome = await ws.cancelCommand('prj_1', 'cmd_tree');
    expect(outcome.state).toBe('terminated');
    expect(provider.signals.map((signal) => signal.signal)).toEqual(['TERM', 'KILL']);
    expect(await provider.livePids('m_fake_1', handle.pid)).toEqual([]);
  });

  it('does not treat an HTTP abort token as command cancellation', async () => {
    const provider = new FakeInstabox();
    const ws = workspace(provider);
    await ws.create({ projectId: 'prj_1', operationKey: 'op-1' });
    const controller = new AbortController();
    const pending = ws.startBackground({
      projectId: 'prj_1',
      commandId: 'cmd_abort',
      argv: ['sleep', '30'],
      timeoutMs: 30_000,
      abortSignal: controller.signal,
    });
    controller.abort();
    const handle = await pending;
    expect(await provider.livePids('m_fake_1', handle.pid)).toEqual([handle.pid]);
    expect(provider.signals).toEqual([]);
  });

  it('persists source bytes outside the provider before destroy', async () => {
    const provider = new FakeInstabox();
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-ws-src-'));
    tempDirs.push(dir);
    const file = ledgerFile();
    const ws = new InstaboxWorkspace({
      provider,
      ledgerFile: file,
      feature: 'lean-instabox-workspace-viewing',
      sourceRoot: dir,
      now: () => 1_700_000_000_000,
    });
    await ws.create({ projectId: 'prj_1', operationKey: 'op-1' });
    await ws.writeFile('prj_1', 'src/app.ts', 'export const answer = 1;\n');
    const saved = await ws.persistSource('prj_1');
    expect(saved.files).toEqual(['src/app.ts']);
    expect(readFileSync(path.join(dir, 'prj_1', 'src/app.ts'), 'utf8')).toBe('export const answer = 1;\n');
    await ws.destroy('prj_1');
    expect(provider.kills).toEqual(['m_fake_1']);
    expect(readFileSync(path.join(dir, 'prj_1', 'src/app.ts'), 'utf8')).toBe('export const answer = 1;\n');
    const ledger = readLedger(file);
    expect(ledger.instabox.machines[0]?.releasedAt).toEqual(expect.any(Number));
  });

  it('keeps stream URLs and certificates off the public session record', async () => {
    const provider = new FakeInstabox();
    const ws = workspace(provider);
    await ws.create({ projectId: 'prj_1', operationKey: 'op-1' });
    const desktop = await ws.openDesktop('prj_1', 60_000);
    expect(desktop.gatewayPath.startsWith('/v1/projects/prj_1/desktop/sessions/')).toBe(true);
    expect(JSON.stringify(desktop)).not.toContain('stream.example');
    expect(JSON.stringify(desktop)).not.toContain('BEGIN CERT');
    const preview = await ws.openPreview('prj_1', 4173, 60_000);
    expect(preview.bindHost).toBe('127.0.0.1');
    expect(preview.guestPort).toBe(4173);
    expect(JSON.stringify(preview)).not.toContain('BEGIN CERT');
    expect(JSON.stringify(preview)).not.toContain('PRIVATE KEY');
  });

  it('rejects pause, resume and restart as unsupported', async () => {
    const provider = new FakeInstabox();
    const ws = workspace(provider);
    await ws.create({ projectId: 'prj_1', operationKey: 'op-1' });
    await expect(ws.pause('prj_1')).rejects.toMatchObject({ code: 'unsupported_operation' });
    await expect(ws.resume('prj_1')).rejects.toMatchObject({ code: 'unsupported_operation' });
    expect(provider.pauses).toEqual([]);
    expect(provider.resumes).toEqual([]);
  });
});
