import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_STDIN_BYTES } from '@insforge/instabox-sdk';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApiServer } from '../../src/http/app.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { FakeInstabox } from '../../src/workspace/instabox.js';
import { setWorkspaceProviderForTests } from '../../src/workspace/runtime.js';
import { sanitizeProviderError, translateCommandExitError } from '../../src/workspace/diagnostics.js';
import {
  GUEST_TRANSPORT_CAP_BYTES,
  LAUNCHER_STAGE_CGROUP_ENTER,
  LAUNCHER_STAGE_CGROUP_MISSING,
  WORKLOAD_CGROUP,
  WORKLOAD_PROJECT,
  splitFencedCommand,
} from '../../src/workspace/limits.js';
import { WRITE_PATH_ENV, parseWriteTargetFromPayload } from '../../src/workspace/guest-write.js';

/**
 * Deterministic regressions for the offline workspace repair. No provider
 * calls, no live VM, no guest bootstrap executed anywhere: command shapes
 * are asserted as strings and guest behavior is modeled by the fake.
 *
 * Covered categories: cwd/privilege ordering with the trusted launcher,
 * actual payload/command shape, the SDK-stdin-derived transport cap,
 * write-failure persistence, symlink boundaries, sanitized diagnostics.
 */

/**
 * The fixed elevated script, written out here independently of the source.
 * The elevated prefix must stay exactly this text: no customer-controlled
 * bytes may enter it (the payload reaches it only as the $1 argument).
 * Each launcher check/setup stage fails with its own fixed marker so a
 * silent non-zero exit can no longer hide which stage broke.
 */
const EXPECTED_TRUSTED_LAUNCHER = [
  'set -eu',
  'export PATH="/usr/sbin:/usr/bin:/sbin:/bin"',
  `test -f ${WORKLOAD_CGROUP}/cgroup.procs || { echo '${LAUNCHER_STAGE_CGROUP_MISSING}' >&2; exit 10; }`,
  `echo $$ > ${WORKLOAD_CGROUP}/cgroup.procs || { echo '${LAUNCHER_STAGE_CGROUP_ENTER}' >&2; exit 11; }`,
  `exec setpriv --reuid 1100 --regid 1100 --init-groups --no-new-privs --inh-caps -all --ambient-caps -all --bounding-set -all -- /usr/bin/env -i HOME=/data/ranger USER=ranger LOGNAME=ranger /bin/bash -lc "$1"`,
].join('\n');

const tempDirs: string[] = [];

afterEach(() => {
  setWorkspaceProviderForTests(null);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface Harness {
  app: FastifyInstance;
  ownerAuth: Record<string, string>;
  projectId: string;
  provider: FakeInstabox;
  dataDir: string;
}

async function harness(): Promise<Harness> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-ws-write-'));
  tempDirs.push(dataDir);
  const ledger = path.join(dataDir, 'ledger.json');
  writeFileSync(
    ledger,
    JSON.stringify({
      version: 1,
      xai: { limitUsd: 5, softAdmissionUsd: 4, observedUsd: 0, reservedUsd: 0, operations: [] },
      instabox: {
        maxAdditionalCreations: 6,
        maxConcurrent: 1,
        maxLifetimeSeconds: 600,
        additionalCreations: 0,
        machines: [],
      },
    }),
  );
  const provider = new FakeInstabox();
  setWorkspaceProviderForTests(provider);
  const config = await loadConfig({
    RANGER_DATA_DIR: dataDir,
    RANGER_LOG_LEVEL: 'error',
    RANGER_LIVE_BUDGET_FILE: ledger,
  } as NodeJS.ProcessEnv);
  const db = openDatabase(dataDir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const owner = ensureInitialPrincipal(db, {
    dataDir,
    repoRoot: process.cwd(),
    displayName: 'Owner',
  });
  const ownerSecret = readOwnerSecret(owner.credentialPath);
  const project = createProjectRecord(db, {
    name: 'Write protocol',
    engineerDisplayName: 'Ranger',
    principalId: owner.principalId,
  });
  const app = await buildApiServer({ config, db });
  return {
    app,
    ownerAuth: { authorization: `Bearer ${ownerSecret}` },
    projectId: project.id,
    provider,
    dataDir,
  };
}

function readOwnerSecret(credentialPath: string): string {
  // Mirrors workspace-api.test.ts: the bootstrap credential file holds key=value.
  // Extract only the value; never print the line itself.
  const line = readFileSync(credentialPath, 'utf8').trim();
  const eq = line.indexOf('=');
  if (eq === -1) throw new Error('owner credential missing');
  return line.slice(eq + 1);
}

async function createWorkspace(h: Harness): Promise<void> {
  const created = await h.app.inject({
    method: 'POST',
    url: `/v1/projects/${h.projectId}/workspace`,
    headers: { ...h.ownerAuth, 'idempotency-key': 'create-1' },
    payload: {},
  });
  expect(created.statusCode).toBe(200);
}

function lastCommand(provider: FakeInstabox) {
  const executed = provider.commands.at(-1);
  if (executed === undefined) throw new Error('no command was executed');
  return executed;
}

describe('workload cwd and privilege ordering (deterministic, not live)', () => {
  it('elevates only the fixed trusted launcher, drops privileges, then chdirs and runs the payload', async () => {
    const h = await harness();
    await createWorkspace(h);
    const command = await h.app.inject({
      method: 'POST',
      url: `/v1/projects/${h.projectId}/workspace/commands`,
      headers: h.ownerAuth,
      payload: { command: 'echo', args: ['ready'], timeoutMs: 5000 },
    });
    expect(command.statusCode).toBe(200);
    const executed = lastCommand(h.provider);
    // The SDK agent chdirs as the template user before the command starts, so
    // an inaccessible cwd fails the launch before the privilege drop runs.
    expect(executed.cwd).toBeUndefined();
    const fenced = splitFencedCommand(executed.command);
    expect(fenced).not.toBeNull();
    // The elevated prefix is exactly the fixed server-generated script: no
    // customer text rides inside the sudo'd portion.
    expect(fenced?.trusted).toBe(EXPECTED_TRUSTED_LAUNCHER);
    // Privileged cgroup entry happens inside the trusted script, before the
    // irrevocable drop; with set -e any setup failure exits before the drop.
    const cgroupAt = fenced?.trusted.indexOf(`echo $$ > ${WORKLOAD_CGROUP}/cgroup.procs`) ?? -1;
    const dropAt = fenced?.trusted.indexOf('exec setpriv --reuid 1100') ?? -2;
    expect(cgroupAt).toBeGreaterThanOrEqual(0);
    expect(dropAt).toBeGreaterThan(cgroupAt);
    // chdir and the user fragment run only after the drop, as the $1 payload.
    // Foreground commands prefix the payload with the fixed supervision
    // marker (fixed charset, cmdline-visible): no customer bytes move.
    const payload = fenced?.payload ?? '';
    const marker = /^RANGER_CCMD=cmd_[0-9a-f-]{36}; /.exec(payload)?.[0] ?? null;
    expect(marker).not.toBeNull();
    expect(payload.slice(marker!.length).startsWith(`cd -- '${WORKLOAD_PROJECT}' && `)).toBe(true);
    expect(fenced?.payload).toContain("'echo' 'ready'");
    await h.app.close();
  });

  it('keeps the same ordering on the workspace-level command path', async () => {
    const provider = new FakeInstabox();
    const file = mkdtempSync(path.join(tmpdir(), 'ranger-ws-lead-'));
    tempDirs.push(file);
    const { InstaboxWorkspace } = await import('../../src/workspace/instabox.js');
    const ws = new InstaboxWorkspace({
      provider,
      ledgerFile: path.join(file, 'ledger.json'),
      feature: 'lean-instabox-workspace-viewing',
      now: () => 1_700_000_000_000,
    });
    writeFileSync(path.join(file, 'ledger.json'), JSON.stringify({
      version: 1,
      xai: { limitUsd: 5, softAdmissionUsd: 4, observedUsd: 0, reservedUsd: 0, operations: [] },
      instabox: { maxAdditionalCreations: 6, maxConcurrent: 1, maxLifetimeSeconds: 600, additionalCreations: 0, machines: [] },
    }));
    await ws.create({ projectId: 'prj_1', operationKey: 'op-1' });
    await ws.runCommand({ projectId: 'prj_1', commandId: 'cmd_1', argv: ['echo', 'hello'], timeoutMs: 5_000 });
    const executed = lastCommand(provider);
    expect(executed.cwd).toBeUndefined();
    const fenced = splitFencedCommand(executed.command);
    expect(fenced?.trusted).toBe(EXPECTED_TRUSTED_LAUNCHER);
    const cgroupAt = fenced?.trusted.indexOf(`echo $$ > ${WORKLOAD_CGROUP}/cgroup.procs`) ?? -1;
    const dropAt = fenced?.trusted.indexOf('exec setpriv --reuid 1100') ?? -2;
    expect(cgroupAt).toBeGreaterThanOrEqual(0);
    expect(dropAt).toBeGreaterThan(cgroupAt);
    expect(fenced?.payload.startsWith(`cd -- '${WORKLOAD_PROJECT}' && `)).toBe(true);
    expect(fenced?.payload).toContain("'echo' 'hello'");
  });

  it('fails closed: no fallback around a missing cgroup or a failed drop', () => {
    // The trusted script starts with set -eu, the cgroup is verified before
    // it is written, nothing swallows setup errors, and the only payload
    // shell is the setpriv-dropped child. There is no path where a failed
    // setup falls back to the sudo-enabled template user.
    expect(EXPECTED_TRUSTED_LAUNCHER.startsWith('set -eu\n')).toBe(true);
    expect(EXPECTED_TRUSTED_LAUNCHER.indexOf(`test -f ${WORKLOAD_CGROUP}/cgroup.procs`)).toBeGreaterThan(-1);
    expect(EXPECTED_TRUSTED_LAUNCHER).not.toContain('|| true');
    expect(EXPECTED_TRUSTED_LAUNCHER.match(/bash -lc/g) ?? []).toHaveLength(1);
    expect(EXPECTED_TRUSTED_LAUNCHER).toContain(
      '--reuid 1100 --regid 1100 --init-groups --no-new-privs --inh-caps -all --ambient-caps -all --bounding-set -all',
    );
    // The drop itself is what execs the payload shell, so the payload can
    // never run while capabilities are still held.
    expect(EXPECTED_TRUSTED_LAUNCHER.trimEnd().endsWith('/bin/bash -lc "$1"')).toBe(true);
  });

  it('reports each failing launcher check/setup stage with a fixed marker, not silence', () => {
    // Window1 failed with a non-zero exit and BOTH streams empty: with
    // set -eu a bare test/redirect failure is silent. Each launcher setup
    // stage must now emit its own fixed, secret-free marker and stop with a
    // distinct fixed exit code. The full script above is pinned verbatim,
    // which is what makes these markers deterministic (no dynamic bytes).
    expect(EXPECTED_TRUSTED_LAUNCHER).toContain(`|| { echo '${LAUNCHER_STAGE_CGROUP_MISSING}' >&2; exit 10; }`);
    expect(EXPECTED_TRUSTED_LAUNCHER).toContain(`|| { echo '${LAUNCHER_STAGE_CGROUP_ENTER}' >&2; exit 11; }`);
    // The markers ride stderr only, stay bounded static text, and name no
    // payload, path argument or environment content.
    expect(LAUNCHER_STAGE_CGROUP_MISSING).toMatch(/^ranger-launcher-failed stage=cgroup_missing$/);
    expect(LAUNCHER_STAGE_CGROUP_ENTER).toMatch(/^ranger-launcher-failed stage=cgroup_enter$/);
    // Fail-closed is unchanged: the marker block exits, it never falls back
    // to the sudo-enabled template identity.
    expect(EXPECTED_TRUSTED_LAUNCHER).not.toContain('|| true');
    // Both stage guards precede the privilege drop; nothing runs after a
    // failed setup.
    const cgroupGuardAt = EXPECTED_TRUSTED_LAUNCHER.indexOf('|| { echo ');
    const dropAt = EXPECTED_TRUSTED_LAUNCHER.indexOf('exec setpriv --reuid 1100');
    expect(cgroupGuardAt).toBeGreaterThan(-1);
    expect(dropAt).toBeGreaterThan(cgroupGuardAt);
  });

  it('runs the guest write through the trusted launcher with the drop before the payload', async () => {
    const h = await harness();
    await createWorkspace(h);
    const written = await h.app.inject({
      method: 'PUT',
      url: `/v1/projects/${h.projectId}/workspace/file`,
      headers: h.ownerAuth,
      payload: { path: 'src/app.ts', contentBase64: Buffer.from('export const n = 1;\n').toString('base64') },
    });
    expect(written.statusCode).toBe(200);
    const executed = lastCommand(h.provider);
    expect(executed.cwd).toBeUndefined();
    const fenced = splitFencedCommand(executed.command);
    // Trusted elevation for the fixed setup, then the irrevocable drop; the
    // write script appears only as the post-drop payload.
    expect(fenced?.trusted).toBe(EXPECTED_TRUSTED_LAUNCHER);
    expect(fenced?.payload.startsWith(`cd -- '${WORKLOAD_PROJECT}' && `)).toBe(true);
    expect(fenced?.payload).toContain('O_NOFOLLOW');
    expect(fenced?.payload).not.toContain('sudo');
    await h.app.close();
  });
});

describe('actual write payload and command shape (deterministic, not live)', () => {
  it('writes through a no-follow guest script with the target in the payload and the bytes on stdin', async () => {
    const h = await harness();
    await createWorkspace(h);
    const content = 'export const n = 1;\n';
    const written = await h.app.inject({
      method: 'PUT',
      url: `/v1/projects/${h.projectId}/workspace/file`,
      headers: h.ownerAuth,
      payload: { path: 'src/app.ts', contentBase64: Buffer.from(content).toString('base64') },
    });
    expect(written.statusCode).toBe(200);
    const executed = lastCommand(h.provider);
    expect(executed.command).toContain('python3 -c');
    expect(executed.command).toContain('O_NOFOLLOW');
    // The target rides the fenced payload as a post-drop assignment: sudo
    // env_reset would strip ambient env, so nothing may depend on it.
    expect((executed.envs ?? {})[WRITE_PATH_ENV]).toBeUndefined();
    const fenced = splitFencedCommand(executed.command);
    expect(fenced?.payload).toContain(`${WRITE_PATH_ENV}='src/app.ts'`);
    expect(parseWriteTargetFromPayload(fenced?.payload ?? '')).toBe('src/app.ts');
    expect(executed.stdin).toBeDefined();
    expect(Buffer.from(executed.stdin ?? '', 'base64').toString('utf8')).toBe(content);
    // The payload must not ride in the command string itself.
    expect(executed.command).not.toContain(Buffer.from(content).toString('base64'));
    await h.app.close();
  });

  it('stores the written bytes and lists them only after guest success', async () => {
    const h = await harness();
    await createWorkspace(h);
    const content = 'export const n = 1;\n';
    const written = await h.app.inject({
      method: 'PUT',
      url: `/v1/projects/${h.projectId}/workspace/file`,
      headers: h.ownerAuth,
      payload: { path: 'src/app.ts', contentBase64: Buffer.from(content).toString('base64') },
    });
    expect(written.statusCode).toBe(200);
    const db = new DatabaseSync(path.join(h.dataDir, 'ranger.db'));
    const rows = db.prepare('SELECT relative_path, content FROM workspace_source_files').all() as Array<{
      relative_path: string;
      content: Buffer;
    }>;
    db.close();
    const stored = rows.map((row) => ({
      path: row.relative_path,
      body: Buffer.from(row.content as unknown as Uint8Array).toString('utf8'),
    }));
    expect(stored).toContainEqual({ path: 'src/app.ts', body: content });
    await h.app.close();
  });
});

describe('write-failure persistence (deterministic, not live)', () => {
  it('does not publish a failed guest write as saved source', async () => {
    const h = await harness();
    await createWorkspace(h);
    h.provider.failNextWrite('guest-write-refused errno=28');
    const written = await h.app.inject({
      method: 'PUT',
      url: `/v1/projects/${h.projectId}/workspace/file`,
      headers: h.ownerAuth,
      payload: { path: 'src/app.ts', contentBase64: Buffer.from('export const n = 1;\n').toString('base64') },
    });
    expect(written.statusCode).toBe(409);
    expect(written.json()).toMatchObject({
      error: { code: 'conflict', details: { reason: 'guest_write_failed' } },
    });
    const envelope = written.json() as { error: { details?: { detail?: string } } };
    expect(String(envelope.error.details?.detail ?? '')).toContain('guest-write-refused');

    const listed = await h.app.inject({
      method: 'GET',
      url: `/v1/projects/${h.projectId}/workspace/files?path=`,
      headers: h.ownerAuth,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ files: [] });

    const read = await h.app.inject({
      method: 'GET',
      url: `/v1/projects/${h.projectId}/workspace/file?path=src/app.ts`,
      headers: h.ownerAuth,
    });
    expect(read.statusCode).toBe(404);

    const db = new DatabaseSync(path.join(h.dataDir, 'ranger.db'));
    const rows = db.prepare('SELECT relative_path FROM workspace_source_files').all() as Array<{ relative_path: string }>;
    db.close();
    expect(rows).toEqual([]);
    await h.app.close();
  });

  it('keeps failed writes out of the workspace-level persisted source', async () => {
    const provider = new FakeInstabox();
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-ws-src2-'));
    tempDirs.push(dir);
    const ledgerPath = path.join(dir, 'ledger.json');
    writeFileSync(ledgerPath, JSON.stringify({
      version: 1,
      xai: { limitUsd: 5, softAdmissionUsd: 4, observedUsd: 0, reservedUsd: 0, operations: [] },
      instabox: { maxAdditionalCreations: 6, maxConcurrent: 1, maxLifetimeSeconds: 600, additionalCreations: 0, machines: [] },
    }));
    const { InstaboxWorkspace } = await import('../../src/workspace/instabox.js');
    const ws = new InstaboxWorkspace({
      provider,
      ledgerFile: ledgerPath,
      feature: 'lean-instabox-workspace-viewing',
      sourceRoot: dir,
      now: () => 1_700_000_000_000,
    });
    await ws.create({ projectId: 'prj_1', operationKey: 'op-1' });
    provider.failNextWrite('guest-write-refused errno=28');
    const failure = await ws.writeFile('prj_1', 'src/app.ts', 'export const answer = 1;\n').then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(failure).toMatchObject({
      code: 'conflict',
      message: 'Workspace file was not written in the guest',
      details: { reason: 'guest_write_failed', exitCode: 4, timedOut: false, truncated: false },
    });
    const saved = await ws.persistSource('prj_1');
    expect(saved.files).toEqual([]);
  });
});

describe('guest_write_failed preserves the SDK failure fields (deterministic, not live)', () => {
  it('keeps exitCode, timedOut and truncated when the write is killed at the command timeout', async () => {
    // A write killed by the guest agent at its command deadline arrives as a
    // non-zero exit with empty streams and timedOut=true. The public error
    // must carry those fields so a timeout can be recognized, never
    // collapsed into a bare reason string.
    const h = await harness();
    await createWorkspace(h);
    h.provider.failNextWriteTimedOut();
    const written = await h.app.inject({
      method: 'PUT',
      url: `/v1/projects/${h.projectId}/workspace/file`,
      headers: h.ownerAuth,
      payload: { path: 'src/app.ts', contentBase64: Buffer.from('export const n = 1;\n').toString('base64') },
    });
    expect(written.statusCode).toBe(409);
    expect(written.json()).toMatchObject({
      error: {
        code: 'conflict',
        message: 'Workspace file was not written in the guest',
        details: { reason: 'guest_write_failed', exitCode: 124, timedOut: true, truncated: false },
      },
    });
    await h.app.close();
  });

  it('preserves the window1 evidence shape: non-zero exit with both streams empty', async () => {
    // Window1 observed exactly this shape (sanitized detail was empty). The
    // fields must survive so the shape itself is recorded, not lost.
    const h = await harness();
    await createWorkspace(h);
    h.provider.failNextWriteSilentExit(1);
    const written = await h.app.inject({
      method: 'PUT',
      url: `/v1/projects/${h.projectId}/workspace/file`,
      headers: h.ownerAuth,
      payload: { path: 'src/app.ts', contentBase64: Buffer.from('export const n = 1;\n').toString('base64') },
    });
    expect(written.statusCode).toBe(409);
    expect(written.json()).toMatchObject({
      error: {
        code: 'conflict',
        details: { reason: 'guest_write_failed', exitCode: 1, timedOut: false, truncated: false },
      },
    });
    await h.app.close();
  });

  it('surfaces a failing launcher setup stage through the sanitized detail', async () => {
    // With fixed stage markers, a launcher check failure reaches the public
    // detail as the fixed marker text plus the preserved stage exit code.
    const h = await harness();
    await createWorkspace(h);
    h.provider.failNextWriteLauncherStage('cgroup_missing');
    const written = await h.app.inject({
      method: 'PUT',
      url: `/v1/projects/${h.projectId}/workspace/file`,
      headers: h.ownerAuth,
      payload: { path: 'src/app.ts', contentBase64: Buffer.from('export const n = 1;\n').toString('base64') },
    });
    expect(written.statusCode).toBe(409);
    const envelope = written.json() as { error: { details?: { detail?: string; exitCode?: number } } };
    expect(envelope.error.details?.detail).toContain('ranger-launcher-failed stage=cgroup_missing');
    expect(envelope.error.details?.exitCode).toBe(10);
    await h.app.close();
  });

  it('preserves the fields on the workspace-level write path too', async () => {
    const provider = new FakeInstabox();
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-ws-fields-'));
    tempDirs.push(dir);
    const ledgerPath = path.join(dir, 'ledger.json');
    writeFileSync(ledgerPath, JSON.stringify({
      version: 1,
      xai: { limitUsd: 5, softAdmissionUsd: 4, observedUsd: 0, reservedUsd: 0, operations: [] },
      instabox: { maxAdditionalCreations: 6, maxConcurrent: 1, maxLifetimeSeconds: 600, additionalCreations: 0, machines: [] },
    }));
    const { InstaboxWorkspace } = await import('../../src/workspace/instabox.js');
    const ws = new InstaboxWorkspace({
      provider,
      ledgerFile: ledgerPath,
      feature: 'lean-instabox-workspace-viewing',
      sourceRoot: dir,
      now: () => 1_700_000_000_000,
    });
    await ws.create({ projectId: 'prj_1', operationKey: 'op-1' });
    provider.failNextWriteTimedOut();
    const failure = await ws.writeFile('prj_1', 'src/app.ts', 'export const answer = 1;\n').then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(failure).toMatchObject({
      code: 'conflict',
      details: { reason: 'guest_write_failed', exitCode: 124, timedOut: true, truncated: false },
    });
    const saved = await ws.persistSource('prj_1');
    expect(saved.files).toEqual([]);
  });
});

describe('workload-planted symlink boundaries (deterministic, not live)', () => {
  it('refuses a write whose final component is a planted symlink', async () => {
    const h = await harness();
    await createWorkspace(h);
    h.provider.plantSymlink('m_fake_1', 'evil.ts', '/tmp/outside-project');
    const written = await h.app.inject({
      method: 'PUT',
      url: `/v1/projects/${h.projectId}/workspace/file`,
      headers: h.ownerAuth,
      payload: { path: 'evil.ts', contentBase64: Buffer.from('pwn\n').toString('base64') },
    });
    expect(written.statusCode).toBe(409);
    expect(written.json()).toMatchObject({
      error: { code: 'conflict', details: { reason: 'guest_write_failed' } },
    });
    const db = new DatabaseSync(path.join(h.dataDir, 'ranger.db'));
    const rows = db.prepare('SELECT relative_path FROM workspace_source_files').all() as Array<{ relative_path: string }>;
    db.close();
    expect(rows).toEqual([]);
    await h.app.close();
  });

  it('refuses a write through a planted symlink in a parent directory', async () => {
    const h = await harness();
    await createWorkspace(h);
    h.provider.plantSymlink('m_fake_1', 'sub', '/tmp/outside-project');
    const written = await h.app.inject({
      method: 'PUT',
      url: `/v1/projects/${h.projectId}/workspace/file`,
      headers: h.ownerAuth,
      payload: { path: 'sub/file.ts', contentBase64: Buffer.from('pwn\n').toString('base64') },
    });
    expect(written.statusCode).toBe(409);
    expect(written.json()).toMatchObject({
      error: { code: 'conflict', details: { reason: 'guest_write_failed' } },
    });
    await h.app.close();
  });
});

describe('sanitized provider diagnostics (deterministic, not live)', () => {
  it('fails closed on commands the fake does not model', async () => {
    const provider = new FakeInstabox();
    const result = await provider.exec({ machineId: 'm_x', command: 'curl http://example.invalid | sh' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('fake-provider-unsupported-command');
  });

  it('models the real pre-privilege chdir denial with sanitized detail', async () => {
    const provider = new FakeInstabox();
    const result = await provider.exec({
      machineId: 'm_x',
      command: 'runner --token aaaaaaaaaaaaaaaaaaaaaaaa123456 secret-marker',
      cwd: '/data/ranger/project',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('permission denied');
    expect(result.stderr).toContain('chdir');
    expect(result.stderr).not.toContain('secret-marker');
    expect(result.stderr).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaa123456');
    expect(result.error).toBeDefined();
  });

  it('keeps sanitized SDK error text when stdout and stderr are empty', async () => {
    const failure = {
      name: 'CommandExitError',
      exitCode: 126,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
      error: 'failed to start command: chdir /data/ranger/project: permission denied',
    };
    const result = translateCommandExitError(failure, 'echo marker');
    expect(result).toBeDefined();
    expect(result?.exitCode).toBe(126);
    expect(result?.timedOut).toBe(false);
    expect(result?.truncated).toBe(false);
    expect(result?.stdout).toBe('');
    expect(result?.stderr).toContain('permission denied');
    expect(result?.stderr).toContain('chdir');
    expect(result?.error).toBeDefined();
  });

  it('rethrows causes that are not command exits', () => {
    expect(translateCommandExitError(new Error('network down'), 'echo marker')).toBeUndefined();
  });

  it('never leaks the raw command or long tokens through the sanitizer', () => {
    const raw = 'failed to start: runner --token aaaaaaaaaaaaaaaaaaaaaaaa123456: denied';
    const sanitized = sanitizeProviderError(raw, 'runner --token aaaaaaaaaaaaaaaaaaaaaaaa123456');
    expect(sanitized).toContain('denied');
    expect(sanitized).not.toContain('runner --token');
    expect(sanitized).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaa123456');
    expect(sanitized.length).toBeLessThanOrEqual(300);
  });
});

describe('guest transport cap derived from the real SDK stdin rule (deterministic, not live)', () => {
  it('derives the raw cap from the SDK constant and matches the base64 rule exactly', () => {
    // Ranger transports file payloads base64-encoded on stdin; the SDK
    // accepts at most MAX_STDIN_BYTES UTF-8 bytes and rejects more before
    // the HTTP call. The safe raw cap is therefore floor(cap/4)*3.
    expect(GUEST_TRANSPORT_CAP_BYTES).toBe(Math.floor(MAX_STDIN_BYTES / 4) * 3);
    const atCap = Buffer.alloc(GUEST_TRANSPORT_CAP_BYTES, 0x61).toString('base64');
    const over = Buffer.alloc(GUEST_TRANSPORT_CAP_BYTES + 1, 0x61).toString('base64');
    expect(atCap).toHaveLength(MAX_STDIN_BYTES);
    expect(over.length).toBeGreaterThan(MAX_STDIN_BYTES);
  });

  it('accepts exactly cap-sized writes and refuses one byte more before any exec (public API)', async () => {
    const h = await harness();
    await createWorkspace(h);
    const capContent = Buffer.alloc(GUEST_TRANSPORT_CAP_BYTES, 0x61).toString('utf8');
    const ok = await h.app.inject({
      method: 'PUT',
      url: `/v1/projects/${h.projectId}/workspace/file`,
      headers: h.ownerAuth,
      payload: { path: 'big.ts', contentBase64: Buffer.from(capContent).toString('base64') },
    });
    expect(ok.statusCode).toBe(200);
    const commandsAfterCap = h.provider.commands.length;
    const refused = await h.app.inject({
      method: 'PUT',
      url: `/v1/projects/${h.projectId}/workspace/file`,
      headers: h.ownerAuth,
      payload: { path: 'over.ts', contentBase64: Buffer.from(`${capContent}b`).toString('base64') },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      error: { code: 'validation_failed', details: { reason: 'file_too_large' } },
    });
    // The refusal happens before exec: the SDK never sees oversized stdin,
    // so no write can surface later as a generic provider 500.
    expect(h.provider.commands).toHaveLength(commandsAfterCap);
    await h.app.close();
  });

  it('accepts exactly cap-sized writes and refuses one byte more before any exec (workspace level)', async () => {
    const provider = new FakeInstabox();
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-ws-cap-'));
    tempDirs.push(dir);
    const ledgerPath = path.join(dir, 'ledger.json');
    writeFileSync(ledgerPath, JSON.stringify({
      version: 1,
      xai: { limitUsd: 5, softAdmissionUsd: 4, observedUsd: 0, reservedUsd: 0, operations: [] },
      instabox: { maxAdditionalCreations: 6, maxConcurrent: 1, maxLifetimeSeconds: 600, additionalCreations: 0, machines: [] },
    }));
    const { InstaboxWorkspace } = await import('../../src/workspace/instabox.js');
    const ws = new InstaboxWorkspace({
      provider,
      ledgerFile: ledgerPath,
      feature: 'lean-instabox-workspace-viewing',
      sourceRoot: dir,
      now: () => 1_700_000_000_000,
    });
    await ws.create({ projectId: 'prj_1', operationKey: 'op-1' });
    const commandsAfterCreate = provider.commands.length;
    const capContent = Buffer.alloc(GUEST_TRANSPORT_CAP_BYTES, 0x61).toString('utf8');
    await ws.writeFile('prj_1', 'big.ts', capContent);
    expect(provider.commands).toHaveLength(commandsAfterCreate + 1);
    await expect(ws.writeFile('prj_1', 'over.ts', `${capContent}b`)).rejects.toMatchObject({
      code: 'validation_failed',
      details: { reason: 'file_too_large' },
    });
    expect(provider.commands).toHaveLength(commandsAfterCreate + 1);
  });

  it('models the real SDK stdin rule in the fake at exactly MAX_STDIN_BYTES', async () => {
    const provider = new FakeInstabox();
    await expect(
      provider.exec({ machineId: 'm_x', command: 'echo x', stdin: 'a'.repeat(MAX_STDIN_BYTES) }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      provider.exec({ machineId: 'm_x', command: 'echo x', stdin: 'a'.repeat(MAX_STDIN_BYTES + 1) }),
    ).rejects.toThrow(/stdin is longer/);
  });

  it('carries a quoted write target through the payload assignment', async () => {
    const provider = new FakeInstabox();
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-ws-quote-'));
    tempDirs.push(dir);
    const ledgerPath = path.join(dir, 'ledger.json');
    writeFileSync(ledgerPath, JSON.stringify({
      version: 1,
      xai: { limitUsd: 5, softAdmissionUsd: 4, observedUsd: 0, reservedUsd: 0, operations: [] },
      instabox: { maxAdditionalCreations: 6, maxConcurrent: 1, maxLifetimeSeconds: 600, additionalCreations: 0, machines: [] },
    }));
    const { InstaboxWorkspace } = await import('../../src/workspace/instabox.js');
    const ws = new InstaboxWorkspace({
      provider,
      ledgerFile: ledgerPath,
      feature: 'lean-instabox-workspace-viewing',
      sourceRoot: dir,
      now: () => 1_700_000_000_000,
    });
    await ws.create({ projectId: 'prj_1', operationKey: 'op-1' });
    await ws.writeFile("prj_1", "src/we'ird.ts", 'export const q = 1;\n');
    const saved = await ws.persistSource('prj_1');
    expect(saved.files).toEqual(["src/we'ird.ts"]);
  });
});
