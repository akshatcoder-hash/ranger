import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { SecretResolver } from '../../src/secrets.js';
import { Sandbox } from '@insforge/instabox-sdk';
import { WorkspaceService } from '../../src/workspace/service.js';
import { createPrincipal } from '../../src/auth/principals.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { isolationProbeScript } from '../../src/workspace/bootstrap.js';
import { SdkInstaboxProvider } from '../../src/workspace/sdk-provider.js';
import { WORKLOAD_USER } from '../../src/workspace/limits.js';

/**
 * LIVE Instabox evidence. Not part of npm test.
 * One VM for lifecycle, isolation, command, screenshot and cleanup.
 * Requires RANGER_LIVE_INSTABOX=1, RANGER_SECRET_FILE and RANGER_LIVE_BUDGET_FILE.
 */

const enabled = process.env['RANGER_LIVE_INSTABOX'] === '1';
const describeLive = enabled ? describe : describe.skip;

describeLive('live Instabox workspace (one VM)', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-live-ws-'));
  let projectId = '';
  let service: WorkspaceService | null = null;

  afterAll(async () => {
    if (service !== null && projectId !== '') {
      try {
        await service.destroy(projectId);
      } catch {
        // Cleanup is also attempted inside the test. A second destroy is safe.
      }
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates, probes isolation, screenshots, and deletes the machine', async () => {
    const config = await loadConfig(process.env);
    const db = openDatabase(dataDir);
    runMigrations(db, path.join(process.cwd(), 'migrations'));
    const principal = createPrincipal(db, 'Live');
    const project = createProjectRecord(db, {
      name: 'Live workspace',
      engineerDisplayName: 'Ranger',
      principalId: principal.id,
    });
    projectId = project.id;
    service = new WorkspaceService({ db, config, secrets: new SecretResolver(config.secretFile) });
    const created = await service.create(projectId, 'live', 'req-live');
    expect(created.observedState).toBe('running');
    expect(created.machineId).toBeTruthy();
    expect(created.vault).toBe(false);
    expect(created.killTimeoutMs).toBeLessThanOrEqual(600_000);

    const provider = new SdkInstaboxProvider();
    const probe = await provider.exec({
      machineId: created.machineId!,
      command: `runuser -u ${WORKLOAD_USER} -- bash -lc ${JSON.stringify(isolationProbeScript())}`,
      timeoutMs: 60_000,
      user: WORKLOAD_USER,
    });
    expect(probe.stdout).toContain('UID=1100');
    expect(probe.stdout).toContain('SUDO=1');
    expect(probe.stdout).toContain('SECRET_KEYS=0');
    expect(probe.stdout).toContain('META=1');

    const shot = await service.screenshot(projectId);
    expect(shot.contentBase64.length).toBeGreaterThan(16);

    await service.destroy(projectId);
    const listed = await Sandbox.list();
    expect(listed.some((item) => item.sandboxId === created.machineId)).toBe(false);
    const status = service.status(projectId);
    expect(status.observedState).toBe('destroyed');
  });
});
