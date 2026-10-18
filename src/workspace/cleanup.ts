import type { DatabaseSync } from 'node:sqlite';
import { recordInstaboxRelease } from '../budget/ledger.js';
import type { InstaboxProvider } from './provider.js';
import { getWorkspace, markWorkspaceDestroyed } from './store.js';

/**
 * Destroy a recorded workspace. Called from the API and from the deadline
 * watchdog. Never creates a replacement machine.
 */
export async function destroyRecordedWorkspace(input: {
  db: DatabaseSync;
  provider: InstaboxProvider;
  ledgerFile: string | null;
  projectId: string;
}): Promise<void> {
  const row = getWorkspace(input.db, input.projectId);
  if (row === null || row.observedState === 'destroyed') return;
  if (row.machineId !== null) {
    await input.provider.kill(row.machineId);
    if (input.ledgerFile !== null) recordInstaboxRelease(input.ledgerFile, row.machineId);
  }
  markWorkspaceDestroyed(input.db, input.projectId);
}

/**
 * Independent cleanup watchdog. Fires at the recorded deadline and destroys
 * the machine if it is still recorded. One timer per live workspace.
 */
export function armWorkspaceWatchdog(input: {
  deadlineAt: number;
  onDeadline: () => Promise<void>;
  now?: () => number;
}): { cancel: () => void } {
  const now = input.now ?? Date.now;
  const delay = Math.max(0, input.deadlineAt - now());
  const timer = setTimeout(() => {
    void input.onDeadline();
  }, delay);
  timer.unref?.();
  return {
    cancel: () => clearTimeout(timer),
  };
}
