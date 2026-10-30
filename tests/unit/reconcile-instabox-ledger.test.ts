import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as ledgerModule from '../../src/budget/ledger.js';
import { reconcileInstaboxLedger, staleEntries } from '../../scripts/reconcile-instabox-ledger.mjs';

const dirs: string[] = [];
const NOW = 1_800_000_000_000;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempLedger(contents: unknown): { file: string; data: Record<string, unknown> } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ranger-ledger-reconcile-'));
  dirs.push(dir);
  const file = path.join(dir, 'provider-budget.json');
  writeFileSync(file, `${JSON.stringify(contents, null, 2)}\n`);
  return { file, data: contents as Record<string, unknown> };
}

const ledgerWith = (machines: unknown[], reservations: unknown[]) => ({
  version: 1,
  operatorNote: { keep: true },
  xai: { limitUsd: null, softAdmissionUsd: null, observedUsd: 0.4, reservedUsd: 0, operations: [{ id: 'xai_1' }] },
  instabox: {
    maxConcurrent: 5,
    maxLifetimeSeconds: null,
    maxAdditionalCreations: null,
    additionalCreations: 7,
    machines,
    pendingReservations: reservations,
    history: [{ id: 'ibx_1' }],
  },
});

describe('reconcile-instabox-ledger', () => {
  it('releases only recorded machines the provider no longer reports, preserving history', () => {
    const original = ledgerWith(
      [
        { machineId: 'm_alive', createdAt: 1, releasedAt: null },
        { machineId: 'm_gone', createdAt: 2, releasedAt: null },
        { machineId: 'm_released', createdAt: 3, releasedAt: 4 },
      ],
      [],
    );
    const { file } = tempLedger(original);
    const result = reconcileInstaboxLedger(file, ledgerModule, new Set(['m_alive']), NOW);
    expect(result).toEqual({ releasedMachines: ['m_gone'], droppedReservations: 0 });
    const written = JSON.parse(readFileSync(file, 'utf8')) as typeof original;
    expect(written.instabox.machines).toEqual([
      { machineId: 'm_alive', createdAt: 1, releasedAt: null },
      { machineId: 'm_gone', createdAt: 2, releasedAt: NOW },
      { machineId: 'm_released', createdAt: 3, releasedAt: 4 },
    ]);
    expect(written.instabox.history).toEqual([{ id: 'ibx_1' }]);
    expect(written.instabox.additionalCreations).toBe(7);
    expect(written.operatorNote).toEqual({ keep: true });
  });

  it('drops only reservations older than the stale window', () => {
    const stale = { reservationId: 'r_stale', ts: NOW - 16 * 60_000, feature: 'workspace', killTimeoutMs: null };
    const fresh = { reservationId: 'r_fresh', ts: NOW - 60_000, feature: 'workspace', killTimeoutMs: null };
    const { file } = tempLedger(ledgerWith([], [stale, fresh]));
    expect(reconcileInstaboxLedger(file, ledgerModule, new Set(), NOW)).toEqual({
      releasedMachines: [],
      droppedReservations: 1,
    });
    const written = JSON.parse(readFileSync(file, 'utf8')) as { instabox: { pendingReservations: unknown[] } };
    expect(written.instabox.pendingReservations).toEqual([fresh]);
  });

  it('is a no-op when every recorded machine is live and no reservation is stale', () => {
    const live = { machineId: 'm_alive', createdAt: 1, releasedAt: null };
    const { file, data } = tempLedger(ledgerWith([live], [{ reservationId: 'r', ts: NOW, feature: 'workspace' }]));
    expect(reconcileInstaboxLedger(file, ledgerModule, new Set(['m_alive']), NOW)).toEqual({
      releasedMachines: [],
      droppedReservations: 0,
    });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(data);
  });

  it('reports stale entries without mutating the ledger it was given', () => {
    const original = ledgerWith([{ machineId: 'm_gone', createdAt: 2, releasedAt: null }], []);
    const stale = staleEntries(original as never, new Set(), NOW);
    expect(stale.machines.map((machine) => machine.machineId)).toEqual(['m_gone']);
    expect(original.instabox.machines[0]).toEqual({ machineId: 'm_gone', createdAt: 2, releasedAt: null });
  });
});
