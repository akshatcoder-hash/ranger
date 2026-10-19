import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Sandbox } from '@insforge/instabox-sdk';
import { describe, expect, it } from 'vitest';
import { readLedger, recordInstaboxRelease } from '../../src/budget/ledger.js';
import { RangerClient } from '../../src/clients/ranger-client.js';
import { loadConfig } from '../../src/config.js';
import type { Run } from '../../src/contracts/types.js';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApiServer } from '../../src/http/app.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { SecretResolver } from '../../src/secrets.js';
import { getWorkspace } from '../../src/workspace/store.js';

/**
 * One opt-in live public approved run, real worker process, xAI and Instabox.
 * Only a new synthetic project/plan is approved. No production plan, browser,
 * preview, Trace dependency, provider mocks, second run or replacement VM.
 * Requires a fresh npm run build and the existing shared live budget ledger.
 * Driver cancellation: 180 seconds or eight new coding reservations (polled);
 * the production loop's independent hard ceiling remains 24 turns.
 */
const describeLive = process.env['RANGER_LIVE_APPROVED_RUN_CORE'] === '1' ? describe : describe.skip;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its deadline`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopWorker(worker: ChildProcess | null): Promise<void> {
  if (worker === null || worker.pid === undefined || worker.exitCode !== null || worker.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => worker.kill('SIGKILL'), 5000);
    worker.once('exit', () => { clearTimeout(timer); resolve(); });
    worker.kill('SIGTERM');
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

describeLive('live approved coding run (one synthetic project, one VM)', () => {
  it('executes the public approval through the real worker and saves verified edits/tests', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ranger-live-approved-core-'));
    const dataDir = path.join(root, 'data');
    const fixture = path.join(root, 'fixture');
    let db: DatabaseSync | null = null;
    let api: Awaited<ReturnType<typeof buildApiServer>> | null = null;
    let worker: ChildProcess | null = null;
    let client: RangerClient | null = null;
    let projectId = '';
    let runId = '';
    let machineId = '';
    let providerKey: string | undefined;
    let ledgerFile: string | null = null;
    const evidence: Record<string, boolean | number | string> = {};
    try {
      if (process.env['RANGER_WORKSPACE_PROVIDER'] === 'deterministic' || process.env['RANGER_AGENT_SCRIPT_FILE']) {
        throw new Error('Live approved-run evidence refuses deterministic provider/transport overrides');
      }
      mkdirSync(path.join(fixture, 'src'), { recursive: true });
      const broken = 'export function add(a, b) { return a - b; }\n';
      const testSource = "import assert from 'node:assert/strict';\nimport { add } from './src/math.mjs';\nfor (const [a,b,want] of [[2,3,5],[-4,7,3],[0,0,0],[1.5,2.25,3.75]]) assert.equal(add(a,b),want);\nconsole.log('RANGER_APPROVED_CORE_TESTS_PASSED');\n";
      writeFileSync(path.join(fixture, 'src/math.mjs'), broken);
      writeFileSync(path.join(fixture, 'test.mjs'), testSource);
      const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: fixture, stdio: 'ignore', timeout: 10_000 });
      git(['init', '-b', 'main']);
      git(['add', 'src/math.mjs', 'test.mjs']);
      git(['-c', 'user.name=Ranger Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic addition regression']);

      const baseEnv = { ...process.env, RANGER_DATA_DIR: dataDir, RANGER_HOST: '127.0.0.1', RANGER_LOG_LEVEL: 'error', RANGER_APPROVED_SNAPSHOT_ROOTS: fixture };
      const inherited = await loadConfig(baseEnv);
      const configFile = path.join(root, 'config.json');
      writeFileSync(configFile, JSON.stringify({
        providers: { ...inherited.providers, traceRoot: path.join(root, 'trace-unconfigured') },
        limits: { ...inherited.limits, workerPollMs: 100, jobLeaseMs: 4000 },
      }));
      const childEnv = { ...baseEnv, RANGER_CONFIG_FILE: configFile };
      const config = await loadConfig(childEnv);
      ledgerFile = config.liveBudgetFile;
      if (ledgerFile === null) throw new Error('Existing shared live budget ledger is required');
      const secrets = SecretResolver.fromConfig(config);
      providerKey = secrets.get('INSTABOX_API_KEY');
      if (!secrets.presentNames().includes('XAI_API_KEY')) throw new Error('xAI is not configured');
      const ledgerBefore = readLedger(ledgerFile);
      const beforeIds = new Set(ledgerBefore.xai.operations.map((item) => item.id));
      const beforeCreations = ledgerBefore.instabox.additionalCreations;
      expect((await Sandbox.list({ apiKey: providerKey })).length).toBeLessThan(5);
      db = openDatabase(dataDir);
      runMigrations(db, path.join(process.cwd(), 'migrations'));
      const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Synthetic approved-run test' });
      const credential = readFileSync(owner.credentialPath, 'utf8').trim().split('=')[1]!;
      api = await buildApiServer({ config, db });
      client = new RangerClient({ baseUrl: await api.listen({ host: '127.0.0.1', port: 0 }), headers: { authorization: `Bearer ${credential}` } });
      const activeClient = client;
      projectId = (await client.createProject({ body: { name: 'Synthetic addition regression', engineerDisplayName: 'Ranger' } })).project.projectId;
      const connected = await client.connectRepository({ path: { projectId }, body: { url: fixture, ref: 'main' } });
      expect(connected.repository.commit).toMatch(/^[0-9a-f]{40}$/);
      const conversationId = (await client.createConversation({ path: { projectId }, body: { title: 'Synthetic addition fix' } })).conversation.conversationId;
      const request = 'Fix src/math.mjs: add(a,b) currently subtracts and must return the sum. Inspect the file, use edit_file to save only that source file, then use run_tests with command node and args ["test.mjs"]. Do not change tests, install dependencies, launch apps or collect screenshots. Finish promptly after the tests pass. This tiny synthetic fixture needs no Trace search; inspect_file is sufficient.';
      await client.postMessage({ path: { projectId, conversationId }, body: { role: 'user', content: request } });
      const scope = ['edit:src/math.mjs', 'command'];
      const plan = await client.createPlanVersion({ path: { projectId }, body: {
        items: [request], acceptanceCriteria: ['add returns the mathematical sum, including negatives and fractions', 'Existing node test.mjs passes without modifying test.mjs'],
        permittedScope: scope, repositoryCommit: connected.repository.commit,
        impactedPaths: ['src/math.mjs'], impactedTests: ['test.mjs'],
      } });
      const approval = await client.approvePlan({ path: { projectId, planId: plan.plan.planId }, body: { permittedScope: scope } });
      expect(approval.approval.status).toBe('active');
      const started = await client.startRun({ path: { projectId }, body: { conversationId, approvalId: approval.approval.approvalId } });
      runId = started.run.runId;
      expect(started.run.state).toBe('queued');
      evidence['publicSyntheticApprovalAndQueue'] = true;

      worker = spawn(process.execPath, ['dist/src/entrypoints/worker.js'], { cwd: process.cwd(), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      // Drain logs without copying potentially sensitive provider diagnostics.
      worker.stdout?.resume();
      worker.stderr?.resume();
      let spawnFailed = false;
      worker.once('error', () => { spawnFailed = true; });
      const deadline = Date.now() + 180_000;
      let terminal: Run | null = null;
      while (terminal === null) {
        if (spawnFailed || worker.exitCode !== null || worker.signalCode !== null) throw new Error('Real worker exited before run completion');
        const row = (await bounded(activeClient.getRun({ path: { projectId, runId } }), 10_000, 'run status')).run;
        machineId = getWorkspace(db, projectId)?.machineId ?? machineId;
        if (['succeeded', 'failed', 'cancelled'].includes(row.state)) { terminal = row; break; }
        const codingCalls = readLedger(ledgerFile).xai.operations.filter((item) => !beforeIds.has(item.id) && item.kind === 'reserve' && item.feature === 'lean-approved-run-workflow').length;
        if (Date.now() >= deadline || codingCalls >= 8) throw new Error('Bounded live run reached its driver time/turn cancellation threshold');
        await sleep(500);
      }
      evidence['runState'] = terminal.state;
      evidence['runFailureCode'] = terminal.failureCode ?? '';
      expect(terminal.state, `run failure code: ${terminal.failureCode ?? 'none'}`).toBe('succeeded');
      expect(terminal.usage?.costUsd).toBeGreaterThan(0);
      expect(terminal.turns).toBeGreaterThan(0);
      expect(terminal.turns).toBeLessThanOrEqual(8);
      const outcomes = await client.listRunTools({ path: { projectId, runId } });
      expect(outcomes.tools.some((tool) => tool.name === 'edit_file' && tool.status === 'ok' && asRecord(tool.result)['saved'] === true)).toBe(true);
      const passed = outcomes.tools.find((tool) => tool.name === 'run_tests' && tool.status === 'ok' && asRecord(tool.result)['passed'] === true);
      expect(passed).toBeDefined();
      expect(asRecord(passed?.result)).toMatchObject({ state: 'succeeded', exitCode: 0, timedOut: false, logsTruncated: false });
      expect(String(asRecord(passed?.result)['logs'])).toContain('RANGER_APPROVED_CORE_TESTS_PASSED');
      evidence['realWorkerEditAndPassingTestOutcomes'] = true;
      evidence['turns'] = terminal.turns ?? 0;
      evidence['observedRunUsd'] = terminal.usage?.costUsd ?? 0;
      const completedLedger = readLedger(ledgerFile);
      expect(completedLedger.instabox.additionalCreations).toBe(beforeCreations + 1);
      const codingReservations = completedLedger.xai.operations.filter((item) => !beforeIds.has(item.id) && item.kind === 'reserve' && item.feature === 'lean-approved-run-workflow');
      expect(codingReservations).toHaveLength(terminal.turns!);
      for (const reservation of codingReservations) {
        expect(completedLedger.xai.operations.some((item) => item.id === `${reservation.id}-observe` && item.kind === 'observe')).toBe(true);
      }
      evidence['observedUsageSettledInSharedLedger'] = true;
      expect(machineId).not.toBe('');
      const own = (await Sandbox.list({ apiKey: providerKey })).filter((item) => item.metadata['rangerProject'] === projectId);
      expect(own).toHaveLength(1);
      expect(own[0]).toMatchObject({ sandboxId: machineId, vault: false, onTimeout: 'kill' });
      const saved = await client.readWorkspaceFile({ path: { projectId }, query: { path: 'src/math.mjs' } });
      const fixed = Buffer.from(saved.contentBase64, 'base64');
      expect(fixed.toString()).not.toBe(broken);
      const savedTests = await client.readWorkspaceFile({ path: { projectId }, query: { path: 'test.mjs' } });
      expect(Buffer.from(savedTests.contentBase64, 'base64').toString()).toBe(testSource);
      const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
      const independent = await client.startWorkspaceCommand({ path: { projectId }, body: {
        command: 'node', args: ['--input-type=module', '-e', `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; import {add} from './src/math.mjs'; const h=p=>createHash('sha256').update(readFileSync(p)).digest('hex'); assert.equal(h('src/math.mjs'),'${hash(fixed)}'); assert.equal(h('test.mjs'),'${hash(testSource)}'); for(const [a,b,w] of [[10,7,17],[-8,3,-5],[0.25,0.5,0.75]]) assert.equal(add(a,b),w); console.log('RANGER_APPROVED_CORE_INDEPENDENT_PASS');`], timeoutMs: 10_000,
      } });
      expect(independent.command.state).toBe('succeeded');
      expect(independent.command.exitCode).toBe(0);
      const logs = await client.getWorkspaceCommandLogs({ path: { projectId, commandId: independent.command.commandId } });
      expect(logs.truncated).toBe(false);
      expect(logs.logs).toContain('RANGER_APPROVED_CORE_INDEPENDENT_PASS');
      evidence['independentGuestBehaviorAndHashes'] = true;
      await client.destroyWorkspace({ path: { projectId } });
      expect((await client.getRun({ path: { projectId, runId } })).run.state).toBe('succeeded');
      expect((await client.listRunTools({ path: { projectId, runId } })).tools).toEqual(outcomes.tools);
      expect((await client.readWorkspaceFile({ path: { projectId }, query: { path: 'src/math.mjs' } })).contentBase64).toBe(saved.contentBase64);
      evidence['savedResultsSurviveVmDeletion'] = true;
    } finally {
      try {
        if (runId !== '' && client !== null) {
          await bounded(client.cancelRun({ path: { projectId, runId } }), 15_000, 'public run cancel').catch(() => undefined);
          // Give the real worker time to observe cancellation and settle its
          // in-flight xAI reservation before terminating that process.
          const cancelClient = client;
          await bounded((async () => {
            for (;;) {
              const current = (await cancelClient.getRun({ path: { projectId, runId } })).run;
              if (['succeeded', 'failed', 'cancelled'].includes(current.state)) return;
              await sleep(250);
            }
          })(), 15_000, 'run cancellation settlement').catch(() => undefined);
        }
        await stopWorker(worker);
        if (projectId !== '' && client !== null) {
          await bounded(client.destroyWorkspace({ path: { projectId } }), 20_000, 'workspace cleanup').catch(() => undefined);
        }
        if (projectId !== '' && providerKey !== undefined) {
          const own = (await Sandbox.list({ apiKey: providerKey })).filter((item) => item.metadata['rangerProject'] === projectId);
          for (const item of own) await Sandbox.kill(item.sandboxId, { apiKey: providerKey });
          const remaining = await Sandbox.list({ apiKey: providerKey });
          expect(remaining.some((item) => item.metadata['rangerProject'] === projectId)).toBe(false);
          if (ledgerFile !== null) {
            for (const item of own) recordInstaboxRelease(ledgerFile, item.sandboxId);
            if (machineId !== '') expect(readLedger(ledgerFile).instabox.machines.find((item) => item.machineId === machineId)?.releasedAt).toBeTypeOf('number');
          }
          evidence['ownedProviderCleanupVerified'] = true;
        }
      } finally {
        await api?.close();
        db?.close();
        rmSync(root, { recursive: true, force: true });
        process.stdout.write(`approved-run-core-evidence ${JSON.stringify(evidence)}\n`);
      }
    }
  }, 300_000);
});
