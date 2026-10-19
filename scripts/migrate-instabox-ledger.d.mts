import type { BudgetLedgerData } from '../src/budget/ledger.js';

export interface LedgerModule {
  withLedgerLock<T>(ledgerFile: string, fn: () => T): T;
  readLedger(ledgerFile: string): BudgetLedgerData;
  writeLedger(ledgerFile: string, data: BudgetLedgerData): void;
}

export function migrateInstaboxLedger(
  ledgerFile: string,
  ledger: LedgerModule,
): { before: number | null; after: null };
