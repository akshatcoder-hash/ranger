import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BudgetLedgerError,
  confirmInstaboxCreation,
  observeXaiSpend,
  readLedger,
  recordInstaboxRelease,
  releaseInstaboxReservation,
  releaseXaiReservation,
  reserveInstaboxCreation,
  reserveXaiSpend,
  withLedgerLock,
} from '../../src/budget/ledger.js';

/**
 * Budget ledger tests run on TEMP COPIES of the mission-wide ledger. They
 * must never touch or reset the real provider-budget.json, and every
 * temporary directory created here is removed again after each test.
 */

type LedgerFixture = Record<string, unknown>;

function fixtureLedger(): LedgerFixture {
  return {
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
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeTempLedger(raw: string): { file: string; raw: string } {
  const dir = makeTempDir('ranger-ledger-');
  const file = path.join(dir, 'provider-budget.json');
  writeFileSync(file, raw);
  return { file, raw };
}

function tempLedger(mutate?: (fixture: LedgerFixture) => void): { file: string; raw: string } {
  const fixture = fixtureLedger();
  mutate?.(fixture);
  return writeTempLedger(JSON.stringify(fixture));
}

/** Patch the serialized fixture directly (for values JSON.stringify cannot hold, e.g. 1e999). */
function tempLedgerPatched(find: string, replace: string): { file: string; raw: string } {
  const base = JSON.stringify(fixtureLedger());
  if (!base.includes(find)) throw new Error(`fixture patch target not found: ${find}`);
  return writeTempLedger(base.replace(find, replace));
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

  it('fails closed when a configured xai limit is missing, negative or above the approved ceiling', () => {
    const mutations: Array<(fixture: LedgerFixture) => void> = [
      (fixture) => {
        delete (fixture.xai as Record<string, unknown>).softAdmissionUsd;
      },
      (fixture) => {
        (fixture.xai as Record<string, unknown>).softAdmissionUsd = 4.01;
      },
      (fixture) => {
        (fixture.xai as Record<string, unknown>).limitUsd = 6;
      },
      (fixture) => {
        (fixture.xai as Record<string, unknown>).limitUsd = -1;
      },
      (fixture) => {
        (fixture.xai as Record<string, unknown>).observedUsd = -0.5;
      },
    ];
    for (const mutate of mutations) {
      const { file, raw } = tempLedger(mutate);
      expect(() => reserveXaiSpend(file, { feature: 'test', estimateUsd: 0.1 })).toThrow(/malformed/i);
      // Refusal wrote nothing.
      expect(readFileSync(file, 'utf8')).toBe(raw);
    }
  });

  it('fails closed when a non-finite xai limit parses out of the file (1e999 -> Infinity)', () => {
    const { file, raw } = tempLedgerPatched('"softAdmissionUsd":4', '"softAdmissionUsd":1e999');
    expect(() => reserveXaiSpend(file, { feature: 'test', estimateUsd: 0.1 })).toThrow(/malformed/i);
    expect(readFileSync(file, 'utf8')).toBe(raw);
  });

  it('honors a lowered limit but never admits past it', () => {
    const { file } = tempLedger((fixture) => {
      (fixture.xai as Record<string, unknown>).softAdmissionUsd = 2;
    });
    reserveXaiSpend(file, { feature: 'test', estimateUsd: 0.1 });
    expect(() => reserveXaiSpend(file, { feature: 'test', estimateUsd: 2.0 })).toThrow(/admission stop/i);
  });
});

describe('xAI settle-once semantics', () => {
  it('observe-observe: a second observation of the same reservation is refused and never double counts usage', () => {
    const { file } = tempLedger();
    const admission = reserveXaiSpend(file, { feature: 'test', estimateUsd: 0.5 });
    observeXaiSpend(file, { reservationId: admission.reservationId, observedUsd: 0.2 });
    expect(() =>
      observeXaiSpend(file, { reservationId: admission.reservationId, observedUsd: 0.2 }),
    ).toThrow(BudgetLedgerError);
    const data = readLedger(file);
    expect(data.xai.observedUsd).toBeCloseTo(0.2);
    expect(data.xai.reservedUsd).toBeCloseTo(0);
    expect(data.xai.operations.filter((o) => o.kind === 'observe')).toHaveLength(1);
  });

  it('observe-release: releasing an already-observed reservation is an idempotent no-op that never frees another reservation', () => {
    const { file } = tempLedger();
    const a = reserveXaiSpend(file, { feature: 'test', estimateUsd: 0.5 });
    reserveXaiSpend(file, { feature: 'test', estimateUsd: 0.5 });
    observeXaiSpend(file, { reservationId: a.reservationId, observedUsd: 0.2 });
    releaseXaiReservation(file, a.reservationId);
    const data = readLedger(file);
    // Regression (round 2): the second free used to subtract from the shared
    // reservedUsd pool and silently erased b's outstanding reservation.
    expect(data.xai.reservedUsd).toBeCloseTo(0.5);
    expect(data.xai.observedUsd).toBeCloseTo(0.2);
    expect(data.xai.operations.filter((o) => o.kind === 'release')).toHaveLength(0);
  });

  it('release-observe: a released reservation cannot accrue observed spend afterwards', () => {
    const { file } = tempLedger();
    const admission = reserveXaiSpend(file, { feature: 'test', estimateUsd: 0.5 });
    releaseXaiReservation(file, admission.reservationId);
    expect(() =>
      observeXaiSpend(file, { reservationId: admission.reservationId, observedUsd: 0.3 }),
    ).toThrow(BudgetLedgerError);
    const data = readLedger(file);
    expect(data.xai.observedUsd).toBeCloseTo(0);
    expect(data.xai.reservedUsd).toBeCloseTo(0);
  });

  it('release-release: a second release of the same reservation is a no-op single free', () => {
    const { file } = tempLedger();
    const admission = reserveXaiSpend(file, { feature: 'test', estimateUsd: 0.5 });
    releaseXaiReservation(file, admission.reservationId);
    releaseXaiReservation(file, admission.reservationId);
    const data = readLedger(file);
    expect(data.xai.reservedUsd).toBeCloseTo(0);
    expect(data.xai.operations.filter((o) => o.kind === 'release')).toHaveLength(1);
  });

  it('unknown reservations: observe refuses and release is a no-op; neither writes the ledger', () => {
    const { file, raw } = tempLedger();
    expect(() => observeXaiSpend(file, { reservationId: 'xai-none', observedUsd: 0.1 })).toThrow(BudgetLedgerError);
    expect(readFileSync(file, 'utf8')).toBe(raw);
    releaseXaiReservation(file, 'xai-none');
    expect(readFileSync(file, 'utf8')).toBe(raw);
  });

  it('a settled reservation can no longer admit spend past the soft stop while another is outstanding', () => {
    // Reproduces the round-2 review: observe A then release A double-freed
    // the shared reservedUsd pool, letting admission ignore B's outstanding
    // reservation and admit past the cap.
    const { file } = tempLedger();
    const a = reserveXaiSpend(file, { feature: 'test', estimateUsd: 0.4 });
    reserveXaiSpend(file, { feature: 'test', estimateUsd: 0.4 });
    observeXaiSpend(file, { reservationId: a.reservationId, observedUsd: 0.4 });
    releaseXaiReservation(file, a.reservationId);
    // b is still outstanding: observed 0.4 + reserved 0.4 leaves 3.2 to the stop.
    expect(() => reserveXaiSpend(file, { feature: 'test', estimateUsd: 3.3 })).toThrow(/admission stop/i);
    reserveXaiSpend(file, { feature: 'test', estimateUsd: 3.2 });
  });
});

describe('Instabox creation allowance', () => {
  it('records a creation against the allowance with the reserved kill timeout', () => {
    const { file } = tempLedger();
    const reservation = reserveInstaboxCreation(file, { feature: 'test', purpose: 'lifecycle', killTimeoutMs: 600000 });
    const instabox = confirmInstaboxCreation(file, {
      reservationId: reservation.reservationId,
      machineId: 'm_test_machine',
    });
    expect(instabox.additionalCreations).toBe(1);
    expect(instabox.machines).toHaveLength(1);
    expect(instabox.machines[0]?.killTimeoutMs).toBe(600000);
    // The reservation is settled: nothing pending remains.
    expect(instabox.pendingReservations).toHaveLength(0);
  });

  it('refuses a creation beyond the six-machine allowance', () => {
    const { file } = tempLedger();
    for (let i = 0; i < 6; i += 1) {
      const reservation = reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 600000 });
      confirmInstaboxCreation(file, {
        reservationId: reservation.reservationId,
        machineId: `m_test_${i}`,
      });
      recordInstaboxRelease(file, `m_test_${i}`);
    }
    expect(() => reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 600000 })).toThrow(/allowance/i);
  });

  it('enforces one concurrent machine', () => {
    const { file } = tempLedger();
    const first = reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 600000 });
    confirmInstaboxCreation(file, {
      reservationId: first.reservationId,
      machineId: 'm_active',
    });
    expect(() => reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 600000 })).toThrow(/one at a time/i);
    recordInstaboxRelease(file, 'm_active');
    const second = reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 600000 });
    expect(second.reservationId).toBeTruthy();
  });

  it('validates the requested kill timeout at reserve time, before any provider create', () => {
    const { file, raw } = tempLedger();
    expect(() => reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 700000 })).toThrow(/kill timeout/i);
    expect(() => reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: Number.NaN })).toThrow(/kill timeout/i);
    expect(() => reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 0 })).toThrow(/kill timeout/i);
    expect(() => reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: -600000 })).toThrow(/kill timeout/i);
    // Every refusal wrote nothing: no pending reservation, no operation recorded.
    expect(readFileSync(file, 'utf8')).toBe(raw);
    // The ledger still admits a compliant request afterwards.
    const reservation = reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 600000 });
    expect(reservation.killTimeoutMs).toBe(600000);
  });

  it('counts an outstanding reservation against the one-active cap', () => {
    const { file } = tempLedger();
    const first = reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 600000 });
    expect(readLedger(file).instabox.pendingReservations).toHaveLength(1);
    // A second outstanding reservation must not bypass one-at-a-time.
    expect(() => reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 600000 })).toThrow(/one at a time/i);
    expect(readLedger(file).instabox.pendingReservations).toHaveLength(1);
    // Releasing the unused reservation frees the concurrency slot.
    releaseInstaboxReservation(file, first.reservationId);
    expect(readLedger(file).instabox.pendingReservations).toHaveLength(0);
    const second = reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 600000 });
    expect(second.reservationId).toBeTruthy();
  });

  it('counts an outstanding reservation against the six-total cap (seven-of-six regression)', () => {
    const { file } = tempLedger();
    for (let i = 0; i < 5; i += 1) {
      const reservation = reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 600000 });
      confirmInstaboxCreation(file, {
        reservationId: reservation.reservationId,
        machineId: `m_${i}`,
      });
      recordInstaboxRelease(file, `m_${i}`);
    }
    // The 6th slot can be reserved exactly once; a second outstanding
    // reservation is refused (it violates one-at-a-time while pending and
    // would project a 7th creation).
    const sixth = reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 600000 });
    expect(() => reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 600000 })).toThrow(
      /one at a time|allowance/i,
    );
    confirmInstaboxCreation(file, { reservationId: sixth.reservationId, machineId: 'm_5' });
    recordInstaboxRelease(file, 'm_5');
    expect(readLedger(file).instabox.additionalCreations).toBe(6);
    // With nothing pending and no machine active, the exhausted total allowance is the gate.
    expect(() => reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 600000 })).toThrow(/allowance/i);
    expect(readLedger(file).instabox.additionalCreations).toBe(6);
  });

  it('rejects an unknown reservation confirmation instead of fabricating a creation', () => {
    const { file, raw } = tempLedger();
    expect(() =>
      confirmInstaboxCreation(file, { reservationId: 'ibx-never-reserved', machineId: 'm_ghost' }),
    ).toThrow(/reservation/i);
    const data = readLedger(file);
    expect(data.instabox.additionalCreations).toBe(0);
    expect(data.instabox.machines).toHaveLength(0);
    expect(readFileSync(file, 'utf8')).toBe(raw);
  });

  it('rejects a duplicate confirmation instead of double counting the creation', () => {
    const { file } = tempLedger();
    const reservation = reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 600000 });
    confirmInstaboxCreation(file, { reservationId: reservation.reservationId, machineId: 'm_once' });
    expect(() =>
      confirmInstaboxCreation(file, { reservationId: reservation.reservationId, machineId: 'm_twice' }),
    ).toThrow(/reservation/i);
    const data = readLedger(file);
    expect(data.instabox.additionalCreations).toBe(1);
    expect(data.instabox.machines).toHaveLength(1);
    expect(data.instabox.machines[0]?.machineId).toBe('m_once');
  });

  it('rejects confirmation after the reservation was released without creation', () => {
    const { file } = tempLedger();
    const reservation = reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 600000 });
    releaseInstaboxReservation(file, reservation.reservationId);
    expect(() =>
      confirmInstaboxCreation(file, { reservationId: reservation.reservationId, machineId: 'm_late' }),
    ).toThrow(/reservation/i);
    expect(readLedger(file).instabox.additionalCreations).toBe(0);
  });

  it('releasing a reservation without creation does not consume the allowance', () => {
    const { file } = tempLedger();
    const reservation = reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 600000 });
    releaseInstaboxReservation(file, reservation.reservationId);
    expect(readLedger(file).instabox.additionalCreations).toBe(0);
  });

  it('fails closed when an instabox limit is missing, non-numeric or above the approved ceiling', () => {
    const mutations: Array<(fixture: LedgerFixture) => void> = [
      (fixture) => {
        delete (fixture.instabox as Record<string, unknown>).maxAdditionalCreations;
      },
      (fixture) => {
        (fixture.instabox as Record<string, unknown>).maxAdditionalCreations = 7;
      },
      (fixture) => {
        delete (fixture.instabox as Record<string, unknown>).maxConcurrent;
      },
      (fixture) => {
        (fixture.instabox as Record<string, unknown>).maxConcurrent = 2;
      },
      (fixture) => {
        delete (fixture.instabox as Record<string, unknown>).maxLifetimeSeconds;
      },
      (fixture) => {
        (fixture.instabox as Record<string, unknown>).maxLifetimeSeconds = 601;
      },
      (fixture) => {
        (fixture.instabox as Record<string, unknown>).additionalCreations = -1;
      },
      (fixture) => {
        (fixture.instabox as Record<string, unknown>).machines = 'not-an-array';
      },
    ];
    for (const mutate of mutations) {
      const { file, raw } = tempLedger(mutate);
      expect(() => reserveInstaboxCreation(file, { feature: 'test', killTimeoutMs: 600000 })).toThrow(/malformed/i);
      // Refusal wrote nothing.
      expect(readFileSync(file, 'utf8')).toBe(raw);
    }
  });
});

describe('ledger integrity', () => {
  it('fails closed when the ledger file is missing', () => {
    const dir = makeTempDir('ranger-ledger-missing-');
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
