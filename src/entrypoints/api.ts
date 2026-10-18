import { loadConfig } from '../config.js';
import { openDatabase } from '../db/db.js';
import { migrationsDirFromCwd, runMigrations } from '../db/migrate.js';
import { buildApiServer } from '../http/app.js';
import { installGracefulShutdown } from './lifecycle.js';

/**
 * Ranger API entrypoint (control service, default 127.0.0.1:3100).
 * Runs migrations from a fresh data directory and serves the v1 contract.
 */
export async function main(): Promise<void> {
  const config = await loadConfig(process.env);
  const db = openDatabase(config.dataDir);
  const migrations = runMigrations(db, migrationsDirFromCwd());
  const app = await buildApiServer({ config, db });
  // Same ordering as the worker: the handler exists before listen returns,
  // so a SIGTERM in the window between bind and the listening line still
  // runs cleanup instead of the default disposition.
  installGracefulShutdown('ranger api', async () => {
    await app.close();
    db.close();
  });
  await app.listen({ host: config.host, port: config.port });
  process.stdout.write(
    `{"msg":"ranger api listening","host":"${config.host}","port":${config.port},"migrationsApplied":${migrations.length}}\n`,
  );
}

main().catch((cause) => {
  process.stderr.write(`{"msg":"ranger api failed to start","err":${JSON.stringify(String(cause))}}\n`);
  process.exit(1);
});
