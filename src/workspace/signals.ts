/**
 * Guest process signalling commands.
 *
 * The workload runs under its own UID, so the template identity the SDK
 * starts commands as cannot signal it: every kill is elevated with
 * non-interactive sudo. The commands are fixed server-generated strings
 * built over validated integers — no caller-controlled text is ever
 * interpolated — and the workload identity itself never gains sudo.
 */

export type GuestSignal = 'TERM' | 'KILL';

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

/** Fixed elevated kill for one process group, or null for an invalid pid. */
export function elevatedKillCommand(pid: number, signal: GuestSignal): string | null {
  if (!validPid(pid)) return null;
  const name = signal === 'KILL' ? 'KILL' : 'TERM';
  return `sudo -n /bin/kill -${name} -- -${pid}`;
}

/** Read-only descendant listing for one process group, or null if invalid. */
export function processListCommand(pid: number): string | null {
  if (!validPid(pid)) return null;
  return `ps -o pid= -g ${pid}`;
}
