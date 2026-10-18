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

/**
 * LIVE Instabox evidence. Not part of npm test.
 * One VM covers lifecycle, isolation, cancellation, desktop and private preview.
 * Requires RANGER_LIVE_INSTABOX=1, RANGER_SECRET_FILE and RANGER_LIVE_BUDGET_FILE.
 * Evidence records statuses and counts only. No stream URLs, tickets or keys.
 */

const enabled = process.env['RANGER_LIVE_INSTABOX'] === '1';
const describeLive = enabled ? describe : describe.skip;

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
    const providerKey = new SecretResolver(config.secretFile).get('INSTABOX_API_KEY');
    const before = await Sandbox.list({ apiKey: providerKey });
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

    const beforeShot = await client.captureWorkspaceScreenshot({ path: { projectId }, body: {} });
    const beforePng = Buffer.from(beforeShot.contentBase64, 'base64');
    expect(beforePng.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    await client.startWorkspaceCommand({
      path: { projectId },
      body: { command: 'bash', args: ['-lc', 'DISPLAY=:1 xterm -geometry 80x24+40+40 -e "printf RANGER-LIVE-MARKER; sleep 30" &'], timeoutMs: 15_000 },
    });
    const afterShot = await client.captureWorkspaceScreenshot({ path: { projectId }, body: {} });
    const afterPng = Buffer.from(afterShot.contentBase64, 'base64');
    expect(afterPng.equals(beforePng)).toBe(false);

    const desktop = await client.createDesktopSession({ path: { projectId }, body: { ttlSeconds: 60 } });
    expect(desktop.session.gatewayPath).toContain('/desktop/sessions/');
    expect(JSON.stringify(desktop)).not.toContain('http');
    const ticket = await client.createConnectionTicket({
      body: { projectId, purpose: 'desktop-stream' },
    });
    const sessionName = '6511e41069d1';
    const streamUrl = `http://127.0.0.1:${previewPort}${desktop.session.gatewayPath.replace('/stream', '/view')}?ticket=${encodeURIComponent(ticket.ticket)}`;
    execFileSync('agent-browser', ['--session', sessionName, 'open', streamUrl], { timeout: 30_000 });
    execFileSync('agent-browser', ['--session', sessionName, 'wait', '--load', 'networkidle'], { timeout: 20_000 });
    const beforeView = execFileSync('agent-browser', ['--session', sessionName, 'screenshot', '--annotate'], {
      timeout: 20_000,
      encoding: 'utf8',
    });
    expect(beforeView.toLowerCase()).not.toContain('revoked');
    const shotPath = path.join(tmpdir(), 'ranger-live-desktop-before.png');
    execFileSync('agent-browser', ['--session', sessionName, 'screenshot', shotPath], { timeout: 20_000 });
    const viewerPng = readFileSync(shotPath);
    expect(viewerPng.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(viewerPng.equals(afterPng)).toBe(false);

    await client.revokeDesktopSession({ path: { projectId, sessionId: desktop.session.sessionId } });
    execFileSync('agent-browser', ['--session', sessionName, 'reload'], { timeout: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const afterRevoke = execFileSync('agent-browser', ['--session', sessionName, 'snapshot'], {
      timeout: 20_000,
      encoding: 'utf8',
    });
    expect(afterRevoke.toLowerCase()).toMatch(/revoked|unauthorized|not active|closed/);
    execFileSync('agent-browser', ['--session', sessionName, 'close'], { timeout: 15_000 });
    rmSync(shotPath, { force: true });

    const marker = '<h1 id="x">RANGER-PRIVATE-APP</h1>';
    await client.writeWorkspaceFile({
      path: { projectId },
      body: { path: 'index.html', contentBase64: Buffer.from(`<html><body>${marker}</body></html>`).toString('base64') },
    });
    const appCommand = await client.startWorkspaceCommand({
      path: { projectId },
      body: {
        command: 'bash',
        args: ['-lc', 'cd /data/ranger/project && python3 -m http.server 8080 --bind 127.0.0.1'],
        timeoutMs: 30_000,
        background: true,
      },
    });
    expect(appCommand.command.state).toBe('running');
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
    expect(ledger.instabox.additionalCreations).toBe(1);
    expect(ledger.instabox.pendingReservations ?? []).toHaveLength(0);
    expect(ledger.instabox.machines.filter((item) => item.releasedAt == null)).toHaveLength(0);
  }, 540_000);
});
