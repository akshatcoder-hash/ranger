import { loadConfig } from '../config.js';
import { openDatabase } from '../db/db.js';
import { migrationsDirFromCwd, runMigrations } from '../db/migrate.js';
import { WorkerLoop, type JobHandler } from '../worker/loop.js';
import { engineeringRunHandler } from '../runs/executor.js';
import { reconcileInterruptedRuns } from '../runs/reconcile.js';
import { RUN_JOB_TYPE } from '../runs/service.js';
import { RetrievalService } from '../retrieval/service.js';
import { PREPARE_JOB_TYPE, projectWorkspacePrepHandler } from '../workspace/prepare.js';
import { TEXT_TURN_JOB_TYPE, failInterruptedTextTurns, textAssistantHandler } from '../conversations/text-assistant.js';
import { SecretResolver } from '../secrets.js';
import { FakeInstabox } from '../workspace/instabox.js';
import { setWorkspaceProviderForTests, workspaceProviderForTests } from '../workspace/runtime.js';
import { SdkInstaboxProvider } from '../workspace/sdk-provider.js';
import type { InstaboxProvider } from '../workspace/provider.js';
import { scriptedTransportFromEnv } from '../agent/scripted-transport.js';
import { installGracefulShutdown } from './lifecycle.js';

/**
 * Ranger worker entrypoint (durable engineering work; never in API requests).
 *
 * Registers the project-workspace preparation handler (read-only voice
 * preparation: one VM + real Trace index, see workspace/prepare.ts) and the
 * engineering-run job handler: one durable run executes one
 * approved plan version on one ephemeral Instabox workspace with the real
 * xAI/Trace tool loop. At startup and every 30s the reconciliation
 * controller fails runs whose worker lease expired (interrupted control
 * worker) with cleanup — never resuming model/tool work.
 *
 * Deterministic test seams (never active in production): when
 * RANGER_WORKSPACE_PROVIDER=deterministic the Instabox wire model is the
 * in-repo fake, and RANGER_AGENT_SCRIPT_FILE loads a scripted Responses
 * protocol transport. Both exist ONLY so fault-path tests can run real
 * worker processes without provider accounts; a live run ignores them.
 */
export async function main(): Promise<void> {
  const config = await loadConfig(process.env);
  const db = openDatabase(config.dataDir);
  const migrations = runMigrations(db, migrationsDirFromCwd());

  // Deterministic-provider test seams (see module doc): fail closed unless
  // explicitly requested via environment for a test process.
  if (process.env.RANGER_WORKSPACE_PROVIDER === 'deterministic') {
    setWorkspaceProviderForTests(new FakeInstabox());
  }
  const scriptTransport = scriptedTransportFromEnv(process.env);

  const secrets = SecretResolver.fromConfig(config);
  const retrieval = new RetrievalService({ db, config });
  const handlers = new Map<string, JobHandler>();
  handlers.set(RUN_JOB_TYPE, engineeringRunHandler({ db, config, retrieval, transportFactory: scriptTransport ?? undefined }));
  handlers.set(PREPARE_JOB_TYPE, projectWorkspacePrepHandler({ db, config, retrieval }));
  // Typed-message turns get their own loop: the main loop is serial, so a long
  // run or preparation would otherwise leave status questions unanswered. The
  // run-script test seam is deliberately not shared: it would consume run steps.
  const textHandlers = new Map<string, JobHandler>([
    [TEXT_TURN_JOB_TYPE, textAssistantHandler({ db, config, retrieval })],
  ]);

  // Interrupted-run reconciliation at startup and on a fixed sweep. The
  // provider resolves lazily so a worker without provider credentials still
  // starts; an unresolvable sweep is reported by the next one, never retried.
  let cachedProvider: InstaboxProvider | null = null;
  const providerForReconcile = (): InstaboxProvider => {
    const testProvider = workspaceProviderForTests();
    if (testProvider !== null) return testProvider;
    if (cachedProvider === null) cachedProvider = new SdkInstaboxProvider(secrets.get('INSTABOX_API_KEY'));
    return cachedProvider;
  };
  const reconcile = (): void => {
    void reconcileInterruptedRuns({ db, provider: providerForReconcile, ledgerFile: config.liveBudgetFile }).catch(() => {
      // Accounting uncertainty is reported by the next sweep; never a retry loop.
    });
  };
  const sweepTextTurns = (): void => {
    try {
      failInterruptedTextTurns(db);
    } catch {
      // The next sweep retries the bookkeeping; no model work is ever resumed.
    }
  };
  reconcile();
  sweepTextTurns();
  const reconcileTimer = setInterval(() => {
    reconcile();
    sweepTextTurns();
  }, 30_000);

  const logLine = (sink: NodeJS.WriteStream, msg: string, obj: Record<string, unknown>): void => {
    const fields = Object.entries(obj)
      .map(([k, v]) => `"${k}":${JSON.stringify(v)}`)
      .join(',');
    sink.write(`{"msg":"${msg}"${fields !== '' ? ',' + fields : ''}}\n`);
  };

  const loopOptions = {
    pollMs: config.limits.workerPollMs,
    leaseMs: config.limits.jobLeaseMs,
    logger: {
      info: (obj: unknown, msg: string) => logLine(process.stdout, msg, obj as Record<string, unknown>),
      error: (obj: unknown, msg: string) => logLine(process.stderr, msg, obj as Record<string, unknown>),
    },
  };
  const loop = new WorkerLoop(db, handlers, loopOptions);
  const textLoop = new WorkerLoop(db, textHandlers, loopOptions);
  // SIGTERM handling must be installed before readiness is visible. A parent
  // that signals as soon as it reads the started line otherwise hits Node's
  // default disposition and the process dies by signal instead of cleanup.
  installGracefulShutdown('ranger worker', async () => {
    clearInterval(reconcileTimer);
    await loop.stop();
    await textLoop.stop();
    if (retrieval !== null) await retrieval.closeAll();
    db.close();
  });
  loop.start();
  textLoop.start();
  process.stdout.write(
    `{"msg":"ranger worker started","migrationsApplied":${migrations.length}}\n`,
  );
}

main().catch((cause) => {
  process.stderr.write(`{"msg":"ranger worker failed to start","err":${JSON.stringify(String(cause))}}\n`);
  process.exit(1);
});
