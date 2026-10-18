/** Shared process lifecycle helpers for all Ranger entrypoints. */

export function installGracefulShutdown(
  label: string,
  onSignal: () => Promise<void>,
  opts: { timeoutMs?: number } = {},
): void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`{"msg":"${label} shutting down","signal":"${signal}"}\n`);
    const timeout = setTimeout(() => {
      process.stderr.write(`{"msg":"${label} forced exit after timeout"}\n`);
      process.exit(1);
    }, opts.timeoutMs ?? 8000);
    timeout.unref();
    onSignal()
      .then(() => process.exit(0))
      .catch((cause) => {
        process.stderr.write(`{"msg":"${label} shutdown error","err":${JSON.stringify(String(cause))}}\n`);
        process.exit(1);
      });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
