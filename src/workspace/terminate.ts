import { foregroundPidsCommand, processGroupIdsCommand, processListCommand } from './signals.js';
import type { InstaboxProvider } from './provider.js';

/**
 * Real termination for recorded commands.
 *
 * Background launches carry the SDK process-group pid. Supervised
 * foreground commands have no pid (the SDK foreground result does not
 * report one), so their launcher-chain process groups are discovered by
 * the fixed RANGER_CCMD marker through pgrep. Every kill is the fixed
 * elevated group signal, followed by a liveness check, and KILL only when
 * something survived TERM.
 */

/** Live pids of the launcher chain for one supervised foreground command. */
async function foregroundGroupPids(provider: InstaboxProvider, machineId: string, commandId: string): Promise<number[]> {
  const command = foregroundPidsCommand(commandId);
  if (command === null) return [];
  const found = await provider.exec({ machineId, command, timeoutMs: 10_000 });
  if (found.exitCode !== 0) return [];
  return found.stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Distinct process groups of the discovered launcher-chain pids. */
async function processGroupIds(provider: InstaboxProvider, machineId: string, pids: number[]): Promise<number[]> {
  const command = processGroupIdsCommand(pids);
  if (command === null) return [];
  const found = await provider.exec({ machineId, command, timeoutMs: 10_000 });
  if (found.exitCode !== 0) return [];
  const pgids = new Set<number>();
  for (const line of found.stdout.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const pgid = Number.parseInt(fields[1] ?? '', 10);
    if (Number.isInteger(pgid) && pgid > 0) pgids.add(pgid);
  }
  return [...pgids];
}

/**
 * TERM every discovered group of one supervised foreground command, then
 * liveness-check and KILL survivors. Idempotent; safe when the command
 * already exited (nothing is discovered).
 */
export async function terminateForegroundGroups(provider: InstaboxProvider, machineId: string, commandId: string): Promise<void> {
  const pids = await foregroundGroupPids(provider, machineId, commandId);
  if (pids.length === 0) return;
  const pgids = await processGroupIds(provider, machineId, pids);
  for (const pgid of pgids) {
    await provider.signal({ machineId, pid: pgid, signal: 'TERM' });
  }
  for (const pgid of pgids) {
    if (processListCommand(pgid) === null) continue;
    const live = await provider.livePids(machineId, pgid);
    if (live.length > 0) {
      await provider.signal({ machineId, pid: pgid, signal: 'KILL' });
    }
  }
}

/**
 * Terminate one recorded command row: by its recorded pid for background
 * launches, by the fixed discovery marker for supervised foreground
 * commands. Exactly the primitive public cancel and cleanup rely on.
 */
export async function terminateCommandRow(provider: InstaboxProvider, machineId: string, row: { id: string; pid: number | null }): Promise<void> {
  if (row.pid !== null) {
    await provider.signal({ machineId, pid: row.pid, signal: 'TERM' });
    const live = await provider.livePids(machineId, row.pid);
    if (live.length > 0) {
      await provider.signal({ machineId, pid: row.pid, signal: 'KILL' });
    }
    return;
  }
  await terminateForegroundGroups(provider, machineId, row.id);
}
