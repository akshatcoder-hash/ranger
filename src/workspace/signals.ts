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

/** Fixed generated command id: the only shape the discovery marker accepts. */
function validCommandId(commandId: string): boolean {
  return /^cmd_[0-9a-f-]{36}$/.test(commandId);
}

/**
 * Fixed pgrep for one supervised foreground command's marker. Found pids
 * are the launcher-chain processes of that command; their process groups
 * are resolved next (processGroupIdsCommand). Null for an invalid id.
 */
export function foregroundPidsCommand(commandId: string): string | null {
  if (!validCommandId(commandId)) return null;
  return `pgrep -f -- ${foregroundMarkerPattern(commandId)}`;
}

/** Read-only pgid listing for validated pids, or null for any invalid pid. */
export function processGroupIdsCommand(pids: number[]): string | null {
  if (pids.length === 0 || !pids.every(validPid)) return null;
  return `ps -o pid=,pgid= -p ${pids.join(',')}`;
}

/** Marker match pattern — the id is fixed-charset, so it is literal-safe. */
function foregroundMarkerPattern(commandId: string): string {
  return `'RANGER_CCMD=${commandId}'`;
}
