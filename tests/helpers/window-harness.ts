/**
 * Deterministic first-failure halt for live-window step sequences.
 *
 * The window2 lesson: a first failed assertion or live command failure must
 * halt every remaining step and promptly cancel the owned public run (via
 * the failure hook, before the caller's bounded cleanup/delete-verify) —
 * never let later steps cascade against a still-running agent and never
 * create a replacement. This runner encodes that discipline as plain code so
 * it can be rehearsed deterministically (no provider, no VM).
 */
export type WindowStepFn = () => Promise<void>;

export interface WindowRunner {
  /**
   * Run one step. After a first failure, every further step throws a halt
   * error WITHOUT executing the step body. The first failure itself is
   * rethrown after the failure hook ran, so the harness reports the real
   * cause.
   */
  step: (fn: WindowStepFn) => Promise<void>;
  /** The first failure, or null while every executed step has succeeded. */
  failure: () => unknown;
  /** True once the window has halted (no further step bodies may run). */
  halted: () => boolean;
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function createWindowRunner(onFailure: (cause: unknown) => Promise<void>): WindowRunner {
  let failure: unknown = null;
  return {
    step: async (fn) => {
      if (failure !== null) {
        throw new Error(`window halted after the first failure: ${describeCause(failure)}`);
      }
      try {
        await fn();
      } catch (cause) {
        failure = cause;
        // The hook runs BEFORE the rethrow so the owned run is cancelled
        // promptly at failure time; the harness cleanup (delete + verify)
        // still runs afterwards and never creates anything.
        await onFailure(cause);
        throw cause;
      }
    },
    failure: () => failure,
    halted: () => failure !== null,
  };
}
