import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as ledgerModule from '../../src/budget/ledger.js';
import { migrateInstaboxLedger } from '../../scripts/migrate-instabox-ledger.mjs';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempLedger(contents?: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ranger-ledger-migrate-'));
  dirs.push(dir);
  const file = path.join(dir, 'provider-budget.json');
  if (contents !== undefined) writeFileSync(file, `${JSON.stringify(contents, null, 2)}\n`);
  return file;
}

describe('migrate-instabox-ledger', () => {
  it('nulls only the cumulative creation cap and preserves everything else', () => {
    const original = {
      version: 1,
      operatorNote: { keep: ['unknown', 'top-level', 'field'] },
      xai: {
        limitUsd: 5,
        softAdmissionUsd: 4,
        observedUsd: 1.25,
        reservedUsd: 0.5,
        operations: [{ id: 'xai_1', kind: 'voice', usd: 0.25 }],
      },
      instabox: {
        maxAdditionalCreations: 9,
        maxConcurrent: 1,
        maxLifetimeSeconds: 600,
        additionalCreations: 3,
        machines: [{ machineId: 'm_1', createdAt: 1_700_000_000_000, releasedAt: null }],
        pendingReservations: [{ id: 'res_1', createdAt: 1_700_000_000_001 }],
      },
    };
    const file = tempLedger(original);

    const result = migrateInstaboxLedger(file, ledgerModule);

    expect(result).toEqual({ before: 9, after: null });
    const migrated = JSON.parse(readFileSync(file, 'utf8')) as typeof original;
    const expected = structuredClone(original) as Record<string, unknown> & { instabox: Record<string, unknown> };
    expected.instabox.maxAdditionalCreations = null;
    expect(migrated).toEqual(expected);
    expect(existsSync(`${file}.lock`)).toBe(false);

    // Idempotent: a second run reports null -> null and changes nothing.
    expect(migrateInstaboxLedger(file, ledgerModule)).toEqual({ before: null, after: null });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(expected);
  });

  it('fails loudly when the ledger file is missing and does not create it', () => {
    const file = tempLedger();
    expect(() => migrateInstaboxLedger(file, ledgerModule)).toThrow(/missing/);
    expect(existsSync(file)).toBe(false);
  });
});
