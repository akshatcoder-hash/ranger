import { loadConfig } from '../config.js';
import { openDatabase } from '../db/db.js';
import { migrationsDirFromCwd, runMigrations } from '../db/migrate.js';
import { WorkerLoop, type JobHandler } from '../worker/loop.js';
import { installGracefulShutdown } from './lifecycle.js';

/**
 * Ranger worker entrypoint (durable engineering work; never in API requests).
 * Foundation: migrations + claim/lease loop with an empty handler registry.
 */
export async function main(): Promise<void> {
  const config = await loadConfig(process.env);
  const db = openDatabase(config.dataDir);
  const migrations = runMigrations(db, migrationsDirFromCwd());

  // Job handlers are registered by the milestones that implement them; the
  // foundation worker idles cleanly with zero handlers.
  const handlers = new Map<string, JobHandler>();

  const logLine = (sink: NodeJS.WriteStream, msg: string, obj: Record<string, unknown>): void => {
    const fields = Object.entries(obj)
      .map(([k, v]) => `"${k}":${JSON.stringify(v)}`)
      .join(',');
    sink.write(`{"msg":"${msg}"${fields !== '' ? ',' + fields : ''}}\n`);
  };

  const loop = new WorkerLoop(db, handlers, {
    pollMs: config.limits.workerPollMs,
    leaseMs: config.limits.jobLeaseMs,
    logger: {
      info: (obj, msg) => logLine(process.stdout, msg, obj as Record<string, unknown>),
      error: (obj, msg) => logLine(process.stderr, msg, obj as Record<string, unknown>),
    },
  });
  // SIGTERM handling must be installed before readiness is visible. A parent
  // that signals as soon as it reads the started line otherwise hits Node's
  // default disposition and the process dies by signal instead of cleanup.
  installGracefulShutdown('ranger worker', async () => {
    await loop.stop();
    db.close();
  });
  loop.start();
  process.stdout.write(
    `{"msg":"ranger worker started","migrationsApplied":${migrations.length}}\n`,
  );
}

main().catch((cause) => {
  process.stderr.write(`{"msg":"ranger worker failed to start","err":${JSON.stringify(String(cause))}}\n`);
  process.exit(1);
});
