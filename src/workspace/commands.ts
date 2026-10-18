import type { DatabaseSync } from 'node:sqlite';
import { COMMAND_OUTPUT_CAP_BYTES, WORKLOAD_PROJECT, WORKLOAD_USER } from './limits.js';
import type { InstaboxProvider } from './provider.js';
import { getCommand, insertCommand, markCommandTerminated, type CommandRow } from './store.js';

export interface CommandSupervisor {
  start(input: {
    projectId: string;
    machineId: string;
    argv: string[];
    timeoutMs: number;
    background: boolean;
  }): Promise<CommandRow>;
  cancel(projectId: string, commandId: string): Promise<CommandRow>;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function workloadCommand(argv: string[]): string {
  return `runuser -u ${WORKLOAD_USER} -- ${argv.map(shellQuote).join(' ')}`;
}

/**
 * Tracks real guest process groups. HTTP abort is not cancellation: only
 * cancel() sends TERM and then KILL to descendants that ignore TERM.
 */
export function createCommandSupervisor(db: DatabaseSync, provider: InstaboxProvider): CommandSupervisor {
  const leaders = new Map<string, { machineId: string; pid: number }>();

  return {
    async start(input) {
      const result = await provider.exec({
        machineId: input.machineId,
        command: workloadCommand(input.argv),
        user: WORKLOAD_USER,
        cwd: WORKLOAD_PROJECT,
        timeoutMs: input.timeoutMs,
        background: input.background,
      });
      const logs = (result.stdout + result.stderr).slice(0, COMMAND_OUTPUT_CAP_BYTES);
      const row = insertCommand(db, {
        projectId: input.projectId,
        argv: input.argv,
        state: input.background ? 'running' : result.exitCode === 0 ? 'succeeded' : 'failed',
        pid: result.pid ?? null,
        logs,
        exitCode: input.background ? null : result.exitCode,
        timedOut: result.timedOut,
      });
      if (result.pid !== undefined) leaders.set(row.id, { machineId: input.machineId, pid: result.pid });
      return row;
    },
    async cancel(projectId, commandId) {
      const row = getCommand(db, projectId, commandId);
      if (row === null) throw new Error('command not found');
      const leader = leaders.get(commandId) ?? (row.pid === null ? null : { machineId: '', pid: row.pid });
      if (leader !== null && leader.machineId !== '') {
        await provider.signal({ machineId: leader.machineId, pid: leader.pid, signal: 'TERM' });
        const live = await provider.livePids(leader.machineId, leader.pid);
        if (live.length > 0) {
          await provider.signal({ machineId: leader.machineId, pid: leader.pid, signal: 'KILL' });
        }
      }
      markCommandTerminated(db, projectId, commandId);
      const updated = getCommand(db, projectId, commandId);
      if (updated === null) throw new Error('command vanished');
      return updated;
    },
  };
}

/** Exposed for the later run service: cancel by durable command id. */
export async function cancelWorkspaceCommand(
  supervisor: CommandSupervisor,
  projectId: string,
  commandId: string,
): Promise<CommandRow> {
  return supervisor.cancel(projectId, commandId);
}
