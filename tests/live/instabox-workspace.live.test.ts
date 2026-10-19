import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Sandbox } from '@insforge/instabox-sdk';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApiServer } from '../../src/http/app.js';
import { buildPreviewApp } from '../../src/entrypoints/preview.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { RangerClient } from '../../src/clients/ranger-client.js';
import { readLedger } from '../../src/budget/ledger.js';
import { SecretResolver } from '../../src/secrets.js';
import { browserProcessEnv, requireLiveBrowser } from '../helpers/live-browser.js';

/**
 * LIVE Instabox evidence. Not part of npm test.
 * One VM covers lifecycle, isolation, cancellation, desktop and private preview.
 * Requires RANGER_LIVE_INSTABOX=1, an explicit secret source and RANGER_LIVE_BUDGET_FILE.
 * Evidence records statuses and counts only. No stream URLs, tickets or keys.
 */

const enabled = process.env['RANGER_LIVE_INSTABOX'] === '1';
const describeLive = enabled ? describe : describe.skip;
const browserEnv = browserProcessEnv(process.env);

describeLive('live Instabox workspace (one combined VM)', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-live-ws-'));
  const apiPort = 3971;
  const previewPort = 3972;
  let projectId = '';
  let machineId = '';
  let api: Awaited<ReturnType<typeof buildApiServer>> | null = null;
  let preview: Awaited<ReturnType<typeof buildPreviewApp>> | null = null;

  afterAll(async () => {
    try {
      if (api !== null && projectId !== '') {
        const secret = readFileSync(path.join(dataDir, 'bootstrap-credential.txt'), 'utf8').trim().split('=')[1] ?? '';
        const client = new RangerClient({
        baseUrl: `http://127.0.0.1:${apiPort}`,
        headers: { authorization: `Bearer ${secret}` },
      });
        await client.destroyWorkspace({ path: { projectId } }).catch(() => undefined);
      }
    } finally {
      await api?.close();
      await preview?.app.close();
      preview?.db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('creates, works, isolates, cancels, views and destroys through the public API', async () => {
    requireLiveBrowser(process.env);
    const config = await loadConfig({
      ...process.env,
      RANGER_DATA_DIR: dataDir,
      RANGER_PORT: String(apiPort),
      RANGER_PREVIEW_PORT: String(previewPort),
      RANGER_HOST: '127.0.0.1',
      RANGER_LOG_LEVEL: 'error',
    });
    const db = openDatabase(dataDir);
    runMigrations(db, path.join(process.cwd(), 'migrations'));
    const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Live' });
    const secret = readFileSync(owner.credentialPath, 'utf8').trim().split('=')[1] ?? '';
    const project = createProjectRecord(db, {
      name: 'Live workspace',
      engineerDisplayName: 'Ranger',
      principalId: owner.principalId,
    });
    projectId = project.id;
    api = await buildApiServer({ config, db });
    await api.listen({ host: '127.0.0.1', port: apiPort });
    preview = await buildPreviewApp(config);
    await preview.app.listen({ host: '127.0.0.1', port: previewPort });

    const client = new RangerClient({
        baseUrl: `http://127.0.0.1:${apiPort}`,
        headers: { authorization: `Bearer ${secret}` },
      });
    const providerKey = SecretResolver.fromConfig(config).get('INSTABOX_API_KEY');
    const before = await Sandbox.list({ apiKey: providerKey });
    // Account quota is five machines: this one window requires headroom of at
    // least one live machine before any reserve/create is attempted.
    expect(before.length).toBeLessThanOrEqual(4);
    const ledgerBefore = readLedger(config.liveBudgetFile!);
    if (ledgerBefore.instabox.maxAdditionalCreations !== null) {
      expect(ledgerBefore.instabox.additionalCreations).toBeLessThan(ledgerBefore.instabox.maxAdditionalCreations);
    }
    let created: Awaited<ReturnType<typeof client.createWorkspace>>;
    try {
      created = await client.createWorkspace({
        path: { projectId },
        body: { sourceRevision: 'live' },
      });
    } catch (cause) {
      const error = cause as { details?: unknown; message?: string };
      process.stderr.write(`bootstrap-failure ${JSON.stringify(error.details ?? { message: error.message })}\n`);
      throw cause;
    }
    expect(created.workspace.observedState).toBe('running');
    const listed = await Sandbox.list({ apiKey: providerKey });
    const mine = listed.find((item) => !before.some((prior) => prior.sandboxId === item.sandboxId));
    expect(mine).toBeTruthy();
    machineId = mine!.sandboxId;
    expect(mine!.vault).toBe(false);
    expect(mine!.onTimeout).toBe('kill');

    let written: Awaited<ReturnType<typeof client.writeWorkspaceFile>>;
    try {
      written = await client.writeWorkspaceFile({
        path: { projectId },
        body: { path: 'src/app.ts', contentBase64: Buffer.from('export const live = 1;\n').toString('base64') },
      });
    } catch (cause) {
      const error = cause as { details?: unknown };
      process.stderr.write(`write-failure ${JSON.stringify(error.details ?? {})}\n`);
      throw cause;
    }
    expect(written.sizeBytes).toBeGreaterThan(0);
    const readBack = await client.readWorkspaceFile({ path: { projectId }, query: { path: 'src/app.ts' } });
    expect(Buffer.from(readBack.contentBase64, 'base64').toString()).toContain('live = 1');

    const command = await client.startWorkspaceCommand({
      path: { projectId },
      body: { command: 'printf', args: ['ran-live\\n'], timeoutMs: 20_000 },
    });
    expect(command.command.exitCode).toBe(0);
    const logs = await client.getWorkspaceCommandLogs({
      path: { projectId, commandId: command.command.commandId },
    });
    expect(logs.logs).toContain('ran-live');

    const probe = await client.startWorkspaceCommand({
      path: { projectId },
      body: {
        command: 'bash',
        args: ['-lc', 'set +e; echo UID:$(id -u); echo GROUPS:$(id -Gn | tr " " ","); echo NNP:$(awk "/NoNewPrivs/ {print \\$2}" /proc/self/status); echo CGROUP:$(cut -d: -f3 /proc/self/cgroup); echo MEMMAX:$(cat /sys/fs/cgroup/memory.max); echo PIDSMAX:$(cat /sys/fs/cgroup/pids.max); sudo -n true >/dev/null 2>&1; echo SUDO:$?; docker info >/dev/null 2>&1; echo DOCKER:$?; test -r /etc/ranger/provider-marker; echo FILE:$?; curl -m 3 -sS -o /dev/null -w "EGRESS:%{http_code}\\n" https://example.com/ || echo EGRESS:000; curl -m 3 -sS -o /dev/null -w "META:%{http_code}\\n" http://169.254.169.254/latest/meta-data/ || echo META:000; exit 0'],
        timeoutMs: 30_000,
      },
    });
    const probeLogs = (await client.getWorkspaceCommandLogs({
      path: { projectId, commandId: probe.command.commandId },
    })).logs;
    expect(probe.command.exitCode).toBe(0);
    expect(probeLogs).toContain('UID:1100');
    expect(probeLogs).toContain('NNP:1');
    expect(probeLogs).toContain('CGROUP:/ranger-workload');
    expect(probeLogs).toContain('MEMMAX:268435456');
    expect(probeLogs).toContain('PIDSMAX:32');
    expect(probeLogs).toContain('SUDO:1');
    expect(probeLogs).toContain('DOCKER:1');
    expect(probeLogs).toContain('FILE:1');
    expect(probeLogs).toMatch(/EGRESS:000/);
    expect(probeLogs).toMatch(/META:000/);
    expect(probeLogs).not.toMatch(/ibx_|sk-|xai-/i);

    const memory = await client.startWorkspaceCommand({
      path: { projectId },
      body: {
        command: 'python3',
        args: ['-c', 'chunks=[]\nimport time\nwhile True:\n chunks.append(bytearray(8*1024*1024))\n time.sleep(0.01)'],
        timeoutMs: 20_000,
      },
    });
    const memoryLogs = await client.getWorkspaceCommandLogs({
      path: { projectId, commandId: memory.command.commandId },
    });
    expect(memory.command.exitCode).not.toBe(0);
    expect(memoryLogs.logs).not.toContain('MemoryError');

    const pids = await client.startWorkspaceCommand({
      path: { projectId },
      body: {
        command: 'python3',
        args: ['-c', 'import os,sys\nlive=[]; refused=0\nfor _ in range(80):\n try: pid=os.fork()\n except OSError: refused=1; break\n if pid==0: os.execv("/bin/sleep",["sleep","20"])\n live.append(pid)\nprint("REFUSED:%d" % refused)\nfor pid in live:\n os.kill(pid,9)\nsys.exit(0 if refused else 1)'],
        timeoutMs: 20_000,
      },
    });
    const pidLogs = await client.getWorkspaceCommandLogs({
      path: { projectId, commandId: pids.command.commandId },
    });
    expect(pids.command.exitCode).toBe(0);
    expect(pidLogs.logs).toContain('REFUSED:1');

    const timed = await client.startWorkspaceCommand({
      path: { projectId },
      body: { command: 'sleep', args: ['30'], timeoutMs: 3_000 },
    });
    expect(timed.command.exitCode).not.toBe(0);

    const background = await client.startWorkspaceCommand({
      path: { projectId },
      body: { command: 'bash', args: ['-lc', 'trap "" TERM; sleep 40 & wait'], timeoutMs: 50_000, background: true },
    });
    expect(background.command.state).toBe('running');
    const terminated = await client.terminateWorkspaceCommand({
      path: { projectId, commandId: background.command.commandId },
    });
    expect(terminated.command.state).toBe('terminated');
    const gone = await client.startWorkspaceCommand({
      path: { projectId },
      body: { command: 'bash', args: ['-lc', 'pgrep -af "sleep 40" || echo TREE-GONE'], timeoutMs: 15_000 },
    });
    const goneLogs = await client.getWorkspaceCommandLogs({
      path: { projectId, commandId: gone.command.commandId },
    });
    expect(goneLogs.logs).toContain('TREE-GONE');

    // Marker app first: it serves both the changing-desktop interaction and
    // the private preview below. The write goes through the repaired trusted
    // launcher as workload uid1100.
    const marker = '<h1 id="x">RANGER-PRIVATE-APP</h1>';
    await client.writeWorkspaceFile({
      path: { projectId },
      body: { path: 'index.html', contentBase64: Buffer.from(`<html><body>${marker}</body></html>`).toString('base64') },
    });
    const appCommand = await client.startWorkspaceCommand({
      path: { projectId },
      body: {
        command: 'bash',
        args: ['-lc', 'python3 -m http.server 8080 --bind 127.0.0.1'],
        timeoutMs: 30_000,
        background: true,
      },
    });
    expect(appCommand.command.state).toBe('running');

    // Real changing desktop through the public API: the guest browser loading
    // the marker page is the interaction (SDK desktop control is provider
    // test tooling; the product surface stays the gateway below).
    const beforeShot = await client.captureWorkspaceScreenshot({ path: { projectId }, body: {} });
    const beforePng = Buffer.from(beforeShot.contentBase64, 'base64');
    expect(beforePng.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

    const desktop = await client.createDesktopSession({ path: { projectId }, body: { ttlSeconds: 60 } });
    expect(desktop.session.gatewayPath).toContain('/desktop/sessions/');
    expect(JSON.stringify(desktop)).not.toContain('http');
    const ticket = await client.createConnectionTicket({
      body: { projectId, purpose: 'desktop-stream' },
    });
    const sessionName = '894a48a8f4fc';
    const viewUrl = `http://127.0.0.1:${previewPort}${desktop.session.gatewayPath.replace('/stream', '/view')}?ticket=${encodeURIComponent(ticket.ticket)}`;
    execFileSync('agent-browser', ['--session', sessionName, 'open', viewUrl], { env: browserEnv, timeout: 30_000 });
    execFileSync('agent-browser', ['--session', sessionName, 'wait', '--load', 'networkidle'], { env: browserEnv, timeout: 20_000 });
    const viewer1Path = path.join(tmpdir(), 'ranger-live-desktop-1.png');
    execFileSync('agent-browser', ['--session', sessionName, 'screenshot', viewer1Path], { env: browserEnv, timeout: 20_000 });
    const viewer1 = readFileSync(viewer1Path);
    expect(viewer1.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(viewer1.toString('latin1')).not.toContain('dashboard.instabox');

    // Interaction on the real guest desktop, then the viewer must show it.
    const sandboxConn = await Sandbox.connect(machineId, { apiKey: providerKey, resume: false });
    await sandboxConn.desktop.open('http://127.0.0.1:8080/');
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const viewer2Path = path.join(tmpdir(), 'ranger-live-desktop-2.png');
    execFileSync('agent-browser', ['--session', sessionName, 'screenshot', viewer2Path], { env: browserEnv, timeout: 20_000 });
    const viewer2 = readFileSync(viewer2Path);
    expect(viewer2.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(viewer2.equals(viewer1)).toBe(false);

    // The authorized API screenshot after the interaction also reflects the
    // changed desktop state.
    const afterShot = await client.captureWorkspaceScreenshot({ path: { projectId }, body: {} });
    const afterPng = Buffer.from(afterShot.contentBase64, 'base64');
    expect(afterPng.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(afterPng.equals(beforePng)).toBe(false);

    await client.revokeDesktopSession({ path: { projectId, sessionId: desktop.session.sessionId } });
    execFileSync('agent-browser', ['--session', sessionName, 'reload'], { env: browserEnv, timeout: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const afterRevoke = execFileSync('agent-browser', ['--session', sessionName, 'snapshot'], { env: browserEnv,
      timeout: 20_000,
      encoding: 'utf8',
    });
    expect(afterRevoke.toLowerCase()).toMatch(/revoked|unauthorized|not active|closed/);
    execFileSync('agent-browser', ['--session', sessionName, 'close'], { env: browserEnv, timeout: 15_000 });
    rmSync(viewer1Path, { force: true });
    rmSync(viewer2Path, { force: true });

    const previewSession = await client.createPreviewSession({
      path: { projectId },
      body: { guestPort: 8080 },
    });
    const appTicket = await client.createConnectionTicket({
      body: { projectId, purpose: 'app-preview' },
    });
    const appResponse = await fetch(
      `http://127.0.0.1:${previewPort}${previewSession.session.gatewayPath}?ticket=${encodeURIComponent(appTicket.ticket)}`,
    );
    expect(appResponse.status).toBe(200);
    expect(await appResponse.text()).toContain('RANGER-PRIVATE-APP');
    const rejected = await fetch(
      `http://127.0.0.1:${previewPort}${previewSession.session.gatewayPath}?target=http://example.com`,
    );
    expect(rejected.status).toBeGreaterThanOrEqual(400);

    await client.destroyWorkspace({ path: { projectId } });
    const after = await Sandbox.list({ apiKey: providerKey });
    expect(after.some((item) => item.sandboxId === machineId)).toBe(false);
    const status = await client.getWorkspaceStatus({ path: { projectId } });
    expect(status.workspace.observedState).toBe('destroyed');
    const saved = readFileSync(path.join(dataDir, 'ranger.db'));
    expect(saved.includes(Buffer.from('live = 1'))).toBe(true);
    const ledger = readLedger(config.liveBudgetFile!);
    expect(ledger.instabox.additionalCreations).toBe(ledgerBefore.instabox.additionalCreations + 1);
    if (ledger.instabox.maxAdditionalCreations !== null) {
      expect(ledger.instabox.additionalCreations).toBeLessThanOrEqual(ledger.instabox.maxAdditionalCreations);
    }
    expect(ledger.instabox.pendingReservations ?? []).toHaveLength(0);
    expect(ledger.instabox.machines.filter((item) => item.releasedAt == null)).toHaveLength(0);
    const recorded = ledger.instabox.machines.find((item) => item.machineId === machineId);
    expect(recorded?.killTimeoutMs).toBe(600000);
    expect(recorded?.releasedAt ?? null).not.toBeNull();
  }, 540_000);
});
