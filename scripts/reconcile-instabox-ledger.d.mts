import type { BudgetLedgerData, LedgerMachine, InstaboxPendingReservation } from '../src/budget/ledger.js';

export interface LedgerModule {
  withLedgerLock<T>(ledgerFile: string, fn: () => T): T;
  readLedger(ledgerFile: string): BudgetLedgerData;
  writeLedger(ledgerFile: string, data: BudgetLedgerData): void;
}

export function staleEntries(
  ledger: BudgetLedgerData,
  liveMachineIds: Set<string>,
  now: number,
  staleMs?: number,
): { machines: LedgerMachine[]; reservations: InstaboxPendingReservation[] };

export function reconcileInstaboxLedger(
  ledgerFile: string,
  ledger: LedgerModule,
  liveMachineIds: Set<string>,
  now?: number,
): { releasedMachines: string[]; droppedReservations: number };
