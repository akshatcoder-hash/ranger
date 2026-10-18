import type { DatabaseSync } from 'node:sqlite';
import { recordInstaboxRelease } from '../budget/ledger.js';
import type { InstaboxProvider } from './provider.js';
import { forgetDesktopStream } from './viewing.js';
import { stopPreviewTunnel } from './preview-tunnel.js';
import {
  clearFailedWorkspace,
  getWorkspace,
  listOpenDesktopSessions,
  listOpenPreviewSessions,
  markWorkspaceDestroyed,
  revokeDesktopSession,
  stopPreviewSession,
} from './store.js';

/**
 * Close every recorded desktop/preview session BEFORE the machine dies:
 * revoke the persisted desktop grants, drop the in-memory bearer stream
 * handles, stop the preview tunnels, and persist the close state so a
 * destroyed workspace observably leaves no live stream or forward.
 */
export async function closeRecordedSessions(input: { db: DatabaseSync; provider: InstaboxProvider; projectId: string }): Promise<void> {
  const row = getWorkspace(input.db, input.projectId);
  if (row === null || row.machineId === null) return;
  let desktopOpen = false;
  for (const session of listOpenDesktopSessions(input.db, input.projectId)) {
    desktopOpen = true;
    revokeDesktopSession(input.db, input.projectId, session.id);
    forgetDesktopStream(session.id);
  }
  for (const session of listOpenPreviewSessions(input.db, input.projectId)) {
    await stopPreviewTunnel(session.id);
    stopPreviewSession(input.db, input.projectId, session.id);
  }
  if (desktopOpen) {
    try {
      await input.provider.revokeStreams(row.machineId);
    } catch {
      // Best effort: the machine kill below is the backstop.
    }
  }
}

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
    await closeRecordedSessions({ db: input.db, provider: input.provider, projectId: input.projectId });
    await input.provider.kill(row.machineId);
    if (input.ledgerFile !== null) recordInstaboxRelease(input.ledgerFile, row.machineId);
  }
  markWorkspaceDestroyed(input.db, input.projectId);
}

/** Destroy a machine whose bootstrap failed, then forget the row. */
export async function destroyFailedBootstrap(input: {
  db: DatabaseSync;
  provider: InstaboxProvider;
  ledgerFile: string | null;
  projectId: string;
}): Promise<void> {
  await destroyRecordedWorkspace(input);
  clearFailedWorkspace(input.db, input.projectId);
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
