import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** Explicit operator action. Preserve accounting, reservations and unknown fields. */
export function removePrototypeLimits(ledgerFile, ledger) {
  return ledger.withLedgerLock(ledgerFile, () => {
    const data = ledger.readLedger(ledgerFile);
    if (!data.xai || !data.instabox) throw new Error('Both provider sections are required');
    const limits = () => ({
      limitUsd: data.xai.limitUsd,
      softAdmissionUsd: data.xai.softAdmissionUsd,
      maxConcurrent: data.instabox.maxConcurrent,
      maxLifetimeSeconds: data.instabox.maxLifetimeSeconds,
      maxAdditionalCreations: data.instabox.maxAdditionalCreations,
    });
    const before = limits();
    data.xai.limitUsd = null;
    data.xai.softAdmissionUsd = null;
    data.instabox.maxConcurrent = ledger.INSTABOX_MAX_ACCOUNT_CONCURRENT;
    data.instabox.maxLifetimeSeconds = null;
    data.instabox.maxAdditionalCreations = null;
    ledger.writeLedger(ledgerFile, data);
    return { before, after: limits() };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ledger = await import(pathToFileURL(path.join(here, '../dist/src/budget/ledger.js')).href);
  const result = removePrototypeLimits(process.env.RANGER_LIVE_BUDGET_FILE ?? '/data/provider-budget.json', ledger);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
