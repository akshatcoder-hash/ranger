import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  confirmInstaboxCreation,
  observeXaiSpend,
  readLedger,
  releaseInstaboxReservation,
  releaseXaiReservation,
  reserveInstaboxCreation,
  reserveXaiSpend,
  recordInstaboxRelease,
  withLedgerLock,
} from '../../src/budget/ledger.js';

/**
 * Budget ledger tests run on TEMP COPIES of the mission-wide ledger. They
 * must never touch or reset the real provider-budget.json.
 */

function fixtureLedger(): string {
  return JSON.stringify({
    version: 1,
    xai: {
      limitUsd: 5,
      softAdmissionUsd: 4,
      observedUsd: 0,
      reservedUsd: 0,
      operations: [],
    },
    instabox: {
      maxAdditionalCreations: 6,
      maxConcurrent: 1,
      maxLifetimeSeconds: 600,
      additionalCreations: 0,
      machines: [],
    },
    readinessExcluded: {
      instaboxMachineId: 'm_agqu6fspotgus2f4qzy3m6gtia',
      deleted: true,
      runningSeconds: 181,
      monetaryCost: null,
      xaiInferenceSpendUsd: 0,
    },
  });
}

function tempLedger(): { file: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ranger-ledger-'));
  const file = path.join(dir, 'provider-budget.json');
  writeFileSync(file, fixtureLedger());
  return { file, dir };
}

describe('xAI budget admission', () => {
  it('admits a reserved operation below the $4 soft stop and records the reservation', () => {
    const { file } = tempLedger();
    const admission = reserveXaiSpend(file, { feature: 'test', estimateUsd: 0.1, model: 'grok-4.3' });
    const data = readLedger(file);
    expect(data.xai.reservedUsd).toBeCloseTo(0.1);
    expect(data.xai.observedUsd).toBe(0);
    expect(data.xai.operations.some((o) => o.id === admission.reservationId && o.kind === 'reserve')).toBe(true);
  });

  it('refuses with a budget error (zero dials) when the estimate would cross the soft stop', () => {
    const { file } = tempLedger();
    reserveXaiSpend(file, { feature: 'test', estimateUsd: 3.5 });
    expect(() => reserveXaiSpend(file, { feature: 'test', estimateUsd: 0.6 })).toThrow(/admission stop/i);
    // Refusal wrote nothing new.
    const data = readLedger(file);
    expect(data.xai.reservedUsd).toBeCloseTo(3.5);
    expect(data.xai.operations.filter((o) => o.kind === 'reserve')).toHaveLength(1);
  });

  it('refuses uncertain accounting (non-finite or non-positive estimates)', () => {
    const { file } = tempLedger();
    expect(() => reserveXaiSpend(file, { feature: 'test', estimateUsd: Number.NaN })).toThrow(/estimate/i);
    expect(() => reserveXaiSpend(file, { feature: 'test', estimateUsd: 0 })).toThrow(/estimate/i);
  });

  it('observing spend moves the reservation into recorded spend', () => {
    const { file } = tempLedger();
    const admission = reserveXaiSpend(file, { feature: 'test', estimateUsd: 0.2 });
    observeXaiSpend(file, { reservationId: admission.reservationId, observedUsd: 0.15 });
    const data = readLedger(file);
    expect(data.xai.observedUsd).toBeCloseTo(0.15);
    expect(data.xai.reservedUsd).toBeCloseTo(0);
  });

  it('releasing a reservation frees the reserve with no recorded spend', () => {
    const { file } = tempLedger();
    const admission = reserveXaiSpend(file, { feature: 'test', estimateUsd: 0.2 });
    releaseXaiReservation(file, admission.reservationId);
    const data = readLedger(file);
    expect(data.xai.reservedUsd).toBeCloseTo(0);
    expect(data.xai.observedUsd).toBe(0);
  });

  it('preserves unknown top-level fields (never resets the shared ledger)', () => {
    const { file } = tempLedger();
    reserveXaiSpend(file, { feature: 'test', estimateUsd: 0.1 });
    const data = readLedger(file) as Record<string, unknown>;
    expect(data['readinessExcluded']).toBeDefined();
  });
});

describe('Instabox creation allowance', () => {
  it('records a creation against the allowance with the kill timeout', () => {
    const { file } = tempLedger();
    const reservation = reserveInstaboxCreation(file, { feature: 'test', purpose: 'lifecycle' });
    const instabox = confirmInstaboxCreation(file, {
      reservationId: reservation.reservationId,
      machineId: 'm_test_machine',
      killTimeoutMs: 600000,
    });
    expect(instabox.additionalCreations).toBe(1);
    expect(instabox.machines).toHaveLength(1);
    expect(instabox.machines[0]?.killTimeoutMs).toBe(600000);
  });

  it('refuses a creation beyond the six-machine allowance', () => {
    const { file } = tempLedger();
    for (let i = 0; i < 6; i += 1) {
      const reservation = reserveInstaboxCreation(file, { feature: 'test' });
      confirmInstaboxCreation(file, {
        reservationId: reservation.reservationId,
        machineId: `m_test_${i}`,
        killTimeoutMs: 600000,
      });
      recordInstaboxRelease(file, `m_test_${i}`);
    }
    expect(() => reserveInstaboxCreation(file, { feature: 'test' })).toThrow(/allowance/i);
  });

  it('enforces one concurrent machine', () => {
    const { file } = tempLedger();
    const first = reserveInstaboxCreation(file, { feature: 'test' });
    confirmInstaboxCreation(file, {
      reservationId: first.reservationId,
      machineId: 'm_active',
      killTimeoutMs: 600000,
    });
    expect(() => reserveInstaboxCreation(file, { feature: 'test' })).toThrow(/one at a time/i);
    recordInstaboxRelease(file, 'm_active');
    const second = reserveInstaboxCreation(file, { feature: 'test' });
    expect(second.reservationId).toBeTruthy();
  });

  it('rejects kill timeouts beyond the 600 s bound', () => {
    const { file } = tempLedger();
    const reservation = reserveInstaboxCreation(file, { feature: 'test' });
    expect(() =>
      confirmInstaboxCreation(file, {
        reservationId: reservation.reservationId,
        machineId: 'm_long',
        killTimeoutMs: 700000,
      }),
    ).toThrow(/kill timeout/i);
  });

  it('releasing a reservation without creation does not consume the allowance', () => {
    const { file } = tempLedger();
    const reservation = reserveInstaboxCreation(file, { feature: 'test' });
    releaseInstaboxReservation(file, reservation.reservationId);
    expect(readLedger(file).instabox.additionalCreations).toBe(0);
  });
});

describe('ledger integrity', () => {
  it('fails closed when the ledger file is missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-ledger-missing-'));
    const file = path.join(dir, 'absent.json');
    expect(() => reserveXaiSpend(file, { feature: 'test', estimateUsd: 0.1 })).toThrow(/missing/i);
    expect(existsSync(file)).toBe(false);
  });

  it('supports sequential lock acquisition and release', () => {
    const { file } = tempLedger();
    withLedgerLock(file, () => undefined);
    withLedgerLock(file, () => undefined);
    // Lock file removed after release, so later writers are not blocked.
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('writes are atomic JSON readable again', () => {
    const { file } = tempLedger();
    reserveXaiSpend(file, { feature: 'test', estimateUsd: 0.25 });
    const raw = readFileSync(file, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
