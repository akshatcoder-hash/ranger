import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * One-off operation for the deployed Machine: remove the cumulative Instabox
 * creation cap (`instabox.maxAdditionalCreations = null`) from the persisted
 * budget ledger. Only that field changes; every counter, reservation, machine
 * record and unknown top-level field is written back exactly as read. Uses the
 * same compiled ledger module and lock as the running API/worker, so it is
 * safe while they are up. A missing or unreadable ledger fails loudly.
 */

export function migrateInstaboxLedger(ledgerFile, ledger) {
  return ledger.withLedgerLock(ledgerFile, () => {
    const data = ledger.readLedger(ledgerFile);
    const instabox = data?.instabox;
    if (instabox === null || typeof instabox !== 'object') {
      throw new Error('Ledger has no instabox section; nothing was changed');
    }
    const before = instabox.maxAdditionalCreations;
    instabox.maxAdditionalCreations = null;
    ledger.writeLedger(ledgerFile, data);
    return { before: before === undefined ? null : before, after: null };
  });
}

async function main() {
  const ledgerFile = process.env.RANGER_LIVE_BUDGET_FILE ?? '/data/provider-budget.json';
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ledger = await import(pathToFileURL(path.join(here, '../dist/src/budget/ledger.js')).href);
  const { before, after } = migrateInstaboxLedger(ledgerFile, ledger);
  process.stdout.write(`instabox.maxAdditionalCreations: ${JSON.stringify(before)} -> ${JSON.stringify(after)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`migrate-instabox-ledger failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
