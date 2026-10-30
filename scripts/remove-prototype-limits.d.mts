import type { LedgerModule } from './migrate-instabox-ledger.mjs';

type Limits = {
  limitUsd: number | null;
  softAdmissionUsd: number | null;
  maxConcurrent: number;
  maxLifetimeSeconds: number | null;
  maxAdditionalCreations: number | null;
};
export function removePrototypeLimits(
  ledgerFile: string,
  ledger: LedgerModule & { INSTABOX_MAX_ACCOUNT_CONCURRENT: number },
): { before: Limits; after: Limits };
