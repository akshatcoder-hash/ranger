import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type RangerConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { SecretResolver } from '../../src/secrets.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { FakeInstabox } from '../../src/workspace/instabox.js';
import { setWorkspaceProviderForTests } from '../../src/workspace/runtime.js';
import { WorkspaceService } from '../../src/workspace/service.js';
import { splitFencedCommand } from '../../src/workspace/limits.js';
import { listProjectEvents } from '../../src/events/store.js';

/**
 * Foreground run-command supervision protocol (deterministic, not live).
 *
 * The approved c2135f8 defect: WorkspaceService.runCommand awaited the
 * foreground SDK exec BEFORE any command row existed, and the SDK
 * foreground result carries no pid, so a run-owned foreground command was
 * invisible to public cancel and unkillable while in flight. These tests
 * pin the corrected protocol:
 *   - the run-owned row is durable (state running) BEFORE the exec resolves;
 *   - cancel/timeout terminates the real guest process group with TERM and
 *     then a liveness-checked KILL;
 *   - outcomes stay truthful (terminated/unknown, real exit codes) and no
 *     workload-writable completion channel exists that could forge a pass.
 */

const tempDirs: string[] = [];

interface Harness {
  dataDir: string;
  db: DatabaseSync;
  config: RangerConfig;
  workspace: WorkspaceService;
  provider: FakeInstabox;
  projectId: string;
}

async function harness(): Promise<Harness> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-fg-'));
  tempDirs.push(dataDir);
  const ledgerFile = path.join(dataDir, 'ledger.json');
  writeFileSync(
    ledgerFile,
    JSON.stringify({
      version: 1,
      xai: { limitUsd: 5, softAdmissionUsd: 4, observedUsd: 0, reservedUsd: 0, operations: [] },
      instabox: { maxAdditionalCreations: 6, maxConcurrent: 1, maxLifetimeSeconds: 600, additionalCreations: 0, machines: [] },
    }),
  );
  const config = await loadConfig({
    RANGER_DATA_DIR: dataDir,
    RANGER_LOG_LEVEL: 'error',
    RANGER_LIVE_BUDGET_FILE: ledgerFile,
  } as NodeJS.ProcessEnv);
  const db = openDatabase(dataDir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Owner' });
  const project = createProjectRecord(db, { name: 'Foreground', engineerDisplayName: 'Ranger', principalId: owner.principalId });
  const provider = new FakeInstabox();
  setWorkspaceProviderForTests(provider);
  const workspace = new WorkspaceService({ db, config, secrets: new SecretResolver(null) });
  await workspace.create(project.id, null, 'req-fg-test');
  return { dataDir, db, config, workspace, provider, projectId: project.id };
}

let h: Harness;

beforeEach(async () => {
  h = await harness();
});

afterEach(() => {
  setWorkspaceProviderForTests(null);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

async function waitForRow(db: DatabaseSync, runId: string): Promise<{ id: string; state: string; pid: number | null; exit_code: number | null; timed_out: number }> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const row = db.prepare('SELECT id, state, pid, exit_code, timed_out FROM workspace_commands WHERE run_id = ?').get(runId) as
      | { id: string; state: string; pid: number | null; exit_code: number | null; timed_out: number }
      | undefined;
    if (row !== undefined) return row;
    if (Date.now() > deadline) throw new Error('run-owned command row never appeared while the exec was in flight');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('foreground run-command supervision (deterministic, not live)', () => {
  it('persists a run-owned running command row before the foreground exec resolves', async () => {
    const hang = h.provider.hangNextForeground();
    const pending = h.workspace.runCommand(h.projectId, ['sleep', '30'], 60_000, false, { runId: 'run_fg1' });
    // The row must be durable and run-attributed while the exec is still
    // in flight: public cancel reads exactly these rows.
    const during = await waitForRow(h.db, 'run_fg1');
    expect(during.state).toBe('running');
    expect(during.exit_code).toBeNull();
    const started = listProjectEvents(h.db, h.projectId).events;
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      type: 'workspace.command.started',
      runId: 'run_fg1',
      data: { commandId: during.id, command: 'sleep 30', state: 'running', exitCode: null },
    });
    hang.release({ stdout: 'done\n' });
    const row = await pending;
    expect(row.state).toBe('succeeded');
    expect(row.exitCode).toBe(0);
    expect(row.logs).toContain('done');
    expect(row.pid).toBeNull();
    expect(listProjectEvents(h.db, h.projectId).events.at(-1)).toMatchObject({
      type: 'workspace.command.finished',
      data: { commandId: row.id, state: 'succeeded', exitCode: 0, timedOut: false },
    });
  });

  it('terminates an in-flight foreground command with TERM then liveness-checked KILL and truthful termination', async () => {
    const hang = h.provider.hangNextForeground({ ignoresTerm: true });
    const pending = h.workspace.runCommand(h.projectId, ['sleep', '30'], 60_000, false, { runId: 'run_fg2' });
    const during = await waitForRow(h.db, 'run_fg2');
    const terminated = await h.workspace.terminate(h.projectId, during.id);
    expect(terminated.state).toBe('terminated');
    expect(terminated.exitCode).toBeNull();
    expect(h.provider.signals.map((signal) => signal.signal)).toEqual(['TERM', 'KILL']);
    // The killed exec resolves with the truthful signal-death result; it is
    // attached to the terminated row without changing the terminated state.
    const row = await pending;
    expect(row.state).toBe('terminated');
    expect(row.exitCode).toBe(137);
    hang.assertResolved();
  });

  it('sweeps surviving descendants after a timeout and records truthful failure, never a pass', async () => {
    // The guest agent reports its own deadline kill (timedOut) while a
    // TERM-ignoring group member survives: supervision sweeps it.
    const hang = h.provider.hangNextForeground({ ignoresTerm: true, keepAliveAfterRelease: true });
    const pending = h.workspace.runCommand(h.projectId, ['sleep', '30'], 120, false, { runId: 'run_fg3' });
    hang.release({ exitCode: 124, timedOut: true });
    const row = await pending;
    expect(row.state).toBe('failed');
    expect(row.timedOut).toBe(true);
    expect(row.exitCode).toBe(124);
    expect(h.provider.signals.map((signal) => signal.signal)).toEqual(['TERM', 'KILL']);
  });

  it('never regresses a finished command through a late terminate', async () => {
    const row = await h.workspace.runCommand(h.projectId, ['echo', 'quick'], 30_000, false, { runId: 'run_fg4' });
    expect(row.state).toBe('succeeded');
    const after = await h.workspace.terminate(h.projectId, row.id);
    expect(after.state).toBe('succeeded');
    expect(h.provider.signals).toEqual([]);
  });

  it('discovers the foreground group by a fixed marker with no workload-writable completion channel', async () => {
    await h.workspace.runCommand(h.projectId, ['echo', 'marked'], 30_000, false, { runId: 'run_fg5' });
    const executed = h.provider.commands.at(-1);
    expect(executed).toBeDefined();
    const fenced = splitFencedCommand(executed!.command);
    expect(fenced).not.toBeNull();
    // The discovery marker rides the payload: fixed charset, pgrep-able.
    expect(executed!.command).toMatch(/RANGER_CCMD=cmd_[0-9a-f-]+/);
    // No workload-writable completion protocol: pass decisions may never
    // depend on a file the workload identity could write or forge.
    expect(fenced!.payload).not.toMatch(/echo \$\?/);
    expect(fenced!.payload).not.toMatch(/\/tmp\//);
  });

  it('fails honestly with an unknown outcome when the exec never reports after supervision', async () => {
    // The group is killed by supervision but the exec never delivers a
    // result (the true unknown-outcome shape): no exit code may be invented.
    h.provider.hangNextForeground({ unreporting: true });
    const pending = h.workspace.runCommand(h.projectId, ['sleep', '30'], 80, false, { runId: 'run_fg6' });
    await expect(pending).rejects.toThrow(/supervision|unknown/i);
    const row = h.db.prepare('SELECT state, exit_code, timed_out FROM workspace_commands WHERE run_id = ?').get('run_fg6') as {
      state: string;
      exit_code: number | null;
      timed_out: number;
    };
    expect(row.state).toBe('failed');
    expect(row.exit_code).toBeNull();
  });
});
