import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Sandbox } from '@insforge/instabox-sdk';
import { describe, expect, it } from 'vitest';
import { readLedger, recordInstaboxRelease } from '../../src/budget/ledger.js';
import { RangerClient } from '../../src/clients/ranger-client.js';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApiServer } from '../../src/http/app.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { SecretResolver } from '../../src/secrets.js';
import { WORKLOAD_CGROUP, WORKLOAD_MEMORY_BYTES, WORKLOAD_PIDS_MAX, WORKLOAD_UID } from '../../src/workspace/limits.js';
import { SdkInstaboxProvider } from '../../src/workspace/sdk-provider.js';
import { getCommand, getWorkspace } from '../../src/workspace/store.js';

/**
 * Explicitly opt-in, browser-free LIVE public API core validation. Creates
 * exactly one VM via the existing API/ledger, never a replacement. Uses only
 * synthetic source; no xAI, desktop, screenshots, or stress benchmarks.
 * Parent/operator must authorize provider use before setting this flag.
 */
const describeLive = process.env['RANGER_LIVE_INSTABOX_CORE'] === '1' ? describe : describe.skip;

describeLive('live Instabox public API core (one owned VM, no browser)', () => {
  it('verifies real guest source, execution, isolation, cancellation and cleanup', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-live-core-'));
    let db: DatabaseSync | null = null;
    let api: Awaited<ReturnType<typeof buildApiServer>> | null = null;
    let client: RangerClient | null = null;
    let projectId = '';
    let machineId = '';
    let providerKey: string | undefined;
    let ledgerFile: string | null = null;
    let attemptedCreate = false;
    let apiDestroyed = false;
    const evidence: Record<string, boolean> = {};
    try {
      const config = await loadConfig({ ...process.env, RANGER_DATA_DIR: dataDir, RANGER_HOST: '127.0.0.1', RANGER_LOG_LEVEL: 'error' });
      ledgerFile = config.liveBudgetFile;
      if (ledgerFile === null) throw new Error('An existing shared live budget ledger is required');
      providerKey = SecretResolver.fromConfig(config).get('INSTABOX_API_KEY');
      if (providerKey === undefined) throw new Error('Instabox is not configured');
      const before = await Sandbox.list({ apiKey: providerKey });
      expect(before.length).toBeLessThan(5);
      const beforeCreations = readLedger(ledgerFile).instabox.additionalCreations;
      db = openDatabase(dataDir);
      runMigrations(db, path.join(process.cwd(), 'migrations'));
      const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Live core' });
      const credentialLine = readFileSync(owner.credentialPath, 'utf8').trim();
      const separator = credentialLine.indexOf('=');
      if (separator === -1) throw new Error('Missing bootstrap credential');
      const credential = credentialLine.slice(separator + 1);
      projectId = createProjectRecord(db, { name: 'Live core synthetic source', engineerDisplayName: 'Ranger', principalId: owner.principalId }).id;
      api = await buildApiServer({ config, db });
      const baseUrl = await api.listen({ host: '127.0.0.1', port: 0 });
      client = new RangerClient({ baseUrl, headers: { authorization: `Bearer ${credential}` } });
      const activeClient = client;

      attemptedCreate = true;
      const created = await activeClient.createWorkspace({ path: { projectId }, body: { sourceRevision: 'synthetic-live-core' } });
      expect(created.workspace.observedState).toBe('running');
      machineId = getWorkspace(db, projectId)?.machineId ?? '';
      expect(machineId).not.toBe('');
      const account = await Sandbox.list({ apiKey: providerKey });
      const owned = account.filter((item) => item.metadata['rangerProject'] === projectId);
      expect(owned).toHaveLength(1);
      expect(owned[0]).toMatchObject({ sandboxId: machineId, vault: false, onTimeout: 'kill' });
      expect(readLedger(ledgerFile).instabox.additionalCreations).toBe(beforeCreations + 1);
      evidence['apiCreateAndBootstrap'] = true;

      async function command(executable: string, args: string[]) {
        const started = await activeClient.startWorkspaceCommand({ path: { projectId }, body: { command: executable, args, timeoutMs: 10_000 } });
        const logs = await activeClient.getWorkspaceCommandLogs({ path: { projectId, commandId: started.command.commandId } });
        expect(started.command.state).toBe('succeeded');
        expect(started.command.exitCode).toBe(0);
        expect(logs.truncated).toBe(false);
        return logs.logs;
      }
      const source = Buffer.from('export function add(a, b) { return a + b; }\n');
      const sourceHash = createHash('sha256').update(source).digest('hex');
      const written = await activeClient.writeWorkspaceFile({ path: { projectId }, body: { path: 'src/math.mjs', contentBase64: source.toString('base64') } });
      expect(written.sizeBytes).toBe(source.length);
      const read = await activeClient.readWorkspaceFile({ path: { projectId }, query: { path: 'src/math.mjs' } });
      expect(Buffer.from(read.contentBase64, 'base64')).toEqual(source);
      evidence['apiSourceReadback'] = true;

      // The API read above is persisted source. This separate command reads
      // the actual VM file, checks its hash, imports it and checks behavior.
      await command('node', ['--check', 'src/math.mjs']);
      const actual = await command('node', ['--input-type=module', '-e', `import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; import {add} from './src/math.mjs'; if(createHash('sha256').update(readFileSync('src/math.mjs')).digest('hex')!=='${sourceHash}') throw new Error('guest hash mismatch'); if(add(2,3)!==5) throw new Error('behavior mismatch'); console.log('RANGER_CORE_GUEST_VERIFIED');`]);
      expect(actual).toContain('RANGER_CORE_GUEST_VERIFIED');
      evidence['guestHashSyntaxAndBehavior'] = true;

      const isolated = await command('bash', ['-c', [
        'set -eu',
        `test "$(id -u)" = "${WORKLOAD_UID}"`,
        "grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status",
        "grep -q '/ranger-workload' /proc/self/cgroup",
        `test "$(cat ${WORKLOAD_CGROUP}/memory.max)" = "${WORKLOAD_MEMORY_BYTES}"`,
        `test "$(cat ${WORKLOAD_CGROUP}/pids.max)" = "${WORKLOAD_PIDS_MAX}"`,
        'test ! -r /etc/ranger/provider-marker',
        'test ! -w /var/run/docker.sock',
        'if sudo -n true >/dev/null 2>&1; then exit 1; fi',
        "printf 'RANGER_CORE_ISOLATION_VERIFIED\\n'",
      ].join('; ')]);
      expect(isolated).toContain('RANGER_CORE_ISOLATION_VERIFIED');
      evidence['workloadIdentityAndLimits'] = true;

      const background = await activeClient.startWorkspaceCommand({ path: { projectId }, body: { command: 'sleep', args: ['30'], timeoutMs: 40_000, background: true } });
      expect(background.command.state).toBe('running');
      const pid = getCommand(db, projectId, background.command.commandId)?.pid;
      if (pid == null) throw new Error('Background command has no recorded PID');
      const stopped = await activeClient.terminateWorkspaceCommand({ path: { projectId, commandId: background.command.commandId } });
      expect(stopped.command.state).toBe('terminated');
      // A failed process-list command must not look like an empty process
      // group. Require a complete, successful independent control query.
      const processes = await new SdkInstaboxProvider(providerKey).exec({ machineId, command: 'ps -eo pid=,pgid=', timeoutMs: 10_000 });
      expect(processes.exitCode).toBe(0);
      expect(processes.timedOut).toBe(false);
      expect(processes.truncated).toBe(false);
      const processRows = processes.stdout.trim().split('\n');
      expect(processRows.length).toBeGreaterThan(0);
      for (const row of processRows) {
        expect(row).toMatch(/^\s*\d+\s+\d+\s*$/);
        expect(Number(row.trim().split(/\s+/)[1])).not.toBe(pid);
      }
      evidence['backgroundCancellationVerified'] = true;

      const finalControl = await command('printf', ['RANGER_CORE_STILL_READY\n']);
      expect(finalControl).toContain('RANGER_CORE_STILL_READY');
      const destroyed = await activeClient.destroyWorkspace({ path: { projectId } });
      expect(destroyed.workspace.observedState).toBe('destroyed');
      apiDestroyed = true;
      evidence['apiDestroy'] = true;
    } finally {
      try {
        if (attemptedCreate && client !== null && !apiDestroyed) {
          await client.destroyWorkspace({ path: { projectId } }).catch(() => undefined);
        }
        if (attemptedCreate && providerKey !== undefined) {
          // Only this test's project metadata is eligible for fallback
          // cleanup; never kill another account machine or retry creation.
          const remaining = await Sandbox.list({ apiKey: providerKey });
          const own = remaining.filter((item) => item.metadata['rangerProject'] === projectId);
          for (const item of own) await Sandbox.kill(item.sandboxId, { apiKey: providerKey });
          const after = await Sandbox.list({ apiKey: providerKey });
          expect(after.some((item) => item.metadata['rangerProject'] === projectId)).toBe(false);
          expect(machineId === '' || after.every((item) => item.sandboxId !== machineId)).toBe(true);
          if (ledgerFile !== null) {
            for (const item of own) recordInstaboxRelease(ledgerFile, item.sandboxId);
            if (machineId !== '') {
              const recorded = readLedger(ledgerFile).instabox.machines.find((item) => item.machineId === machineId);
              expect(recorded?.releasedAt).toBeTypeOf('number');
            }
          }
          evidence['providerCleanupVerified'] = true;
        }
      } finally {
        await api?.close();
        db?.close();
        rmSync(dataDir, { recursive: true, force: true });
        process.stdout.write(`instabox-core-evidence ${JSON.stringify(evidence)}\n`);
      }
    }
  });
});
