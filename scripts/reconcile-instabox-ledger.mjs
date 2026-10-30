import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Explicit operator action for the deployed Machine: free the concurrent-VM
 * admission slots held by ledger records whose Instabox machine no longer
 * exists (killed outside Ranger, expired, or lost with an earlier machine),
 * and drop pending reservations whose create never completed.
 *
 * Accounting history is preserved: a released machine keeps its record and
 * gains `releasedAt` (the same field the normal destroy path writes), and the
 * operation history is appended to. Nothing is deleted and no counter resets.
 */

const RESERVATION_STALE_MS = 15 * 60_000;

/** Machines recorded as live but absent from the provider, plus stale reservations. */
export function staleEntries(ledger, liveMachineIds, now, staleMs = RESERVATION_STALE_MS) {
  const instabox = ledger.instabox;
  const machines = (instabox.machines ?? []).filter(
    (machine) => (machine.releasedAt === undefined || machine.releasedAt === null) && !liveMachineIds.has(machine.machineId),
  );
  const reservations = (instabox.pendingReservations ?? []).filter((reservation) => now - reservation.ts > staleMs);
  return { machines, reservations };
}

/** Apply the releases through the running ledger implementation (same lock, same shape). */
export function reconcileInstaboxLedger(ledgerFile, ledger, liveMachineIds, now = Date.now()) {
  return ledger.withLedgerLock(ledgerFile, () => {
    const data = ledger.readLedger(ledgerFile);
    const stale = staleEntries(data, liveMachineIds, now);
    if (stale.machines.length === 0 && stale.reservations.length === 0) {
      return { releasedMachines: [], droppedReservations: 0 };
    }
    for (const machine of stale.machines) machine.releasedAt = now;
    if (stale.reservations.length > 0) {
      const dropped = new Set(stale.reservations.map((reservation) => reservation.reservationId));
      data.instabox.pendingReservations = (data.instabox.pendingReservations ?? []).filter(
        (reservation) => !dropped.has(reservation.reservationId),
      );
    }
    ledger.writeLedger(ledgerFile, data);
    return {
      releasedMachines: stale.machines.map((machine) => machine.machineId),
      droppedReservations: stale.reservations.length,
    };
  });
}

async function main() {
  const root = process.env.RANGER_APP_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const load = (rel) => import(pathToFileURL(path.join(root, 'dist/src', rel)).href);
  const [{ loadConfig }, { SecretResolver }, ledgerModule, { Sandbox }] = await Promise.all([
    load('config.js'),
    load('secrets.js'),
    load('budget/ledger.js'),
    import('@insforge/instabox-sdk'),
  ]);
  const config = await loadConfig(process.env);
  if (config.liveBudgetFile === null) throw new Error('RANGER_LIVE_BUDGET_FILE is required');
  const apiKey = SecretResolver.fromConfig(config, process.env).get('INSTABOX_API_KEY');
  const live = new Set((await Sandbox.list({ apiKey })).map((machine) => machine.sandboxId));
  const result = reconcileInstaboxLedger(config.liveBudgetFile, ledgerModule, live);
  process.stdout.write(`${JSON.stringify({ liveMachines: live.size, ...result }, null, 2)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`reconcile-instabox-ledger failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
