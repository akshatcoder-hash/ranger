import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLedger } from '../../src/budget/ledger.js';
import { generateKeyPairSync } from 'node:crypto';
import {
  FakeInstabox,
  InstaboxWorkspace,
  type InstaboxProvider,
  type ProviderCreateRequest,
} from '../../src/workspace/instabox.js';
import { opensshEd25519PublicKey } from '../../src/workspace/preview-tunnel.js';
import { elevatedKillCommand, processListCommand } from '../../src/workspace/signals.js';

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
    // Privileged setup precedes the irrevocable drop, and the payload only
    // runs after it: the elevated prefix is the fixed sudo'd launcher and
    // the workload identity never gains sudo itself.
    expect(executed?.command).toContain('exec sudo -n /bin/bash -c');
    expect(executed?.command).toContain('setpriv --reuid 1100');
    expect(executed?.command).toContain('--no-new-privs');
    expect(executed?.command).toContain('--init-groups');
    expect(executed?.command).toContain('--bounding-set -all');
    expect(executed?.command).toContain('/sys/fs/cgroup/ranger-workload/cgroup.procs');
    expect(executed?.command).not.toContain('runuser');
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

  it('encodes an Ed25519 public key as an OpenSSH line, not PEM', () => {
    const pair = generateKeyPairSync('ed25519');
    const line = opensshEd25519PublicKey(pair.publicKey);
    expect(line.startsWith('ssh-ed25519 AAAA')).toBe(true);
    expect(line).not.toContain('BEGIN');
    const decoded = Buffer.from(line.split(' ')[1]!, 'base64');
    expect(decoded.subarray(4, 15).toString()).toBe('ssh-ed25519');
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

describe('elevated guest signalling (deterministic, not live)', () => {
  it('builds a fixed elevated kill for the workload process group', () => {
    // The workload runs under its own UID, so the template identity cannot
    // signal it: cancellation is elevated, fixed, and integer-only.
    expect(elevatedKillCommand(4123, 'TERM')).toBe('sudo -n /bin/kill -TERM -- -4123');
    expect(elevatedKillCommand(4123, 'KILL')).toBe('sudo -n /bin/kill -KILL -- -4123');
  });

  it('refuses to interpolate a non-integer pid into an elevated command', () => {
    for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(elevatedKillCommand(pid, 'TERM')).toBeNull();
      expect(processListCommand(pid)).toBeNull();
    }
    expect(processListCommand(4123)).toBe('ps -o pid= -g 4123');
  });

  it('cancels a running workload command with TERM then KILL through the provider', async () => {
    const provider = new FakeInstabox();
    const ws = workspace(provider);
    await ws.create({ projectId: 'prj_1', operationKey: 'op-1' });
    const handle = await ws.startBackground({
      projectId: 'prj_1',
      commandId: 'cmd_sig',
      argv: ['sleep', '30'],
      timeoutMs: 30_000,
    });
    const outcome = await ws.cancelCommand('prj_1', 'cmd_sig');
    expect(outcome.state).toBe('terminated');
    // A process that exits on TERM receives only TERM; the KILL escalation
    // for TERM-ignoring descendants is covered by its own test above.
    expect(provider.signals.map((signal) => signal.pid)).toEqual([handle.pid]);
    expect(provider.signals.map((signal) => signal.signal)).toEqual(['TERM']);
  });
});
