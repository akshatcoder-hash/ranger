import { describe, expect, it } from 'vitest';
import { createWindowRunner } from '../helpers/window-harness.js';

/**
 * Deterministic rehearsal of the live-window first-failure discipline: the
 * first failed assertion or live command failure halts every remaining step
 * and trips the failure hook exactly once (which cancels the owned run and
 * empties resources in the live wiring). No provider, no VM.
 */
describe('window runner first-failure halt (deterministic rehearsal)', () => {
  it('executes steps in order and halts all remaining steps after the first failure', async () => {
    const executed: string[] = [];
    const cleanups: string[] = [];
    const runner = createWindowRunner(async () => {
      cleanups.push('cancel-owned-run');
    });

    await runner.step(async () => {
      executed.push('preconditions');
    });
    await expect(
      runner.step(async () => {
        executed.push('first-failing-step');
        throw new Error('first failed assertion');
      }),
    ).rejects.toThrow('first failed assertion');

    // Every later step is halted without executing its body: zero additional
    // steps run after the first failure.
    for (const name of ['step-3', 'step-4', 'step-5']) {
      await expect(runner.step(async () => { executed.push(name); })).rejects.toThrow(/halted after the first failure/);
    }

    expect(executed).toEqual(['preconditions', 'first-failing-step']);
    expect(runner.halted()).toBe(true);
  });

  it('runs the failure hook (prompt owned-run cancel) exactly once, before any later step attempt', async () => {
    const hookCalls: unknown[] = [];
    let laterStepAttempted = false;
    const runner = createWindowRunner(async (cause) => {
      hookCalls.push(cause);
    });

    await expect(
      runner.step(async () => {
        throw new Error('live command failed');
      }),
    ).rejects.toThrow('live command failed');

    await expect(runner.step(async () => { laterStepAttempted = true; })).rejects.toThrow(/halted/);

    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]).toBeInstanceOf(Error);
    expect(laterStepAttempted).toBe(false);
  });

  it('keeps executing while every step succeeds and reports no failure', async () => {
    const runner = createWindowRunner(async () => {
      throw new Error('failure hook must not run');
    });
    await runner.step(async () => undefined);
    await runner.step(async () => undefined);
    expect(runner.halted()).toBe(false);
    expect(runner.failure()).toBeNull();
  });

  it('rethrows the original cause, not the halt message, for the first failure', async () => {
    const runner = createWindowRunner(async () => undefined);
    const original = new Error('the real failure');
    await expect(
      runner.step(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });
});
