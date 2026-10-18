import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError, Errors } from '../errors.js';
import {
  confirmInstaboxCreation,
  readLedger,
  recordInstaboxRelease,
  releaseInstaboxReservation,
  reserveInstaboxCreation,
} from '../budget/ledger.js';
import {
  COMMAND_OUTPUT_CAP_BYTES,
  VM_KILL_TIMEOUT_MS,
  WORKLOAD_PROJECT,
  WORKLOAD_USER,
  fencedWorkloadCommand,
} from './limits.js';
import { FakeInstabox } from './fake-provider.js';
import type { InstaboxProvider, ProviderCreateRequest } from './provider.js';

export { FakeInstabox };
export type { InstaboxProvider, ProviderCreateRequest };

export class UncertainCreateError extends AppError {
  readonly operationKey: string;
  constructor(operationKey: string) {
    super('conflict', `Uncertain Instabox create for ${operationKey}; refusing a second create`, {
      details: { reason: 'uncertain_create', operationKey },
    });
    this.name = 'UncertainCreateError';
    this.operationKey = operationKey;
  }
}

export interface WorkspaceCreateInput {
  projectId: string;
  operationKey: string;
}

export interface CreatedWorkspace {
  machineId: string;
  vault: false;
  killTimeoutMs: number;
  onTimeout: 'kill';
}

export interface CommandRunInput {
  projectId: string;
  commandId: string;
  argv: string[];
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

export interface FinishedCommand {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface BackgroundHandle {
  pid: number;
  machineId: string;
}

export interface CancelOutcome {
  state: 'terminated';
  pid: number;
}

export interface PersistedSource {
  files: string[];
}

export interface DesktopSessionRecord {
  sessionId: string;
  gatewayPath: string;
  expiresAtMs: number;
}

export interface PreviewSessionRecord {
  sessionId: string;
  gatewayPath: string;
  bindHost: '127.0.0.1';
  guestPort: number;
  expiresAtMs: number;
}

export interface InstaboxWorkspaceOptions {
  provider: InstaboxProvider;
  ledgerFile: string;
  feature: string;
  sourceRoot?: string;
  now?: () => number;
  apiKey?: string;
}

interface LiveWorkspace {
  projectId: string;
  operationKey: string;
  machineId: string;
  reservationId: string;
  files: Map<string, string>;
  commands: Map<string, { pid: number; logs: string; state: string; exitCode: number | null }>;
}

const uncertain = new Map<string, { machineId: string | null }>();

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function bound(text: string): string {
  const bytes = Buffer.byteLength(text);
  if (bytes <= COMMAND_OUTPUT_CAP_BYTES) return text;
  return text.slice(0, COMMAND_OUTPUT_CAP_BYTES);
}

/**
 * One Instabox workspace lifecycle: create, work, preview, destroy.
 * Pause/resume/restart are rejected. No local execution fallback.
 */
export class InstaboxWorkspace {
  private readonly live = new Map<string, LiveWorkspace>();

  constructor(private readonly options: InstaboxWorkspaceOptions) {}

  async create(input: WorkspaceCreateInput): Promise<CreatedWorkspace> {
    if (uncertain.has(input.operationKey)) {
      throw new UncertainCreateError(input.operationKey);
    }
    const reservation = reserveInstaboxCreation(this.options.ledgerFile, {
      feature: this.options.feature,
      purpose: input.projectId,
      killTimeoutMs: VM_KILL_TIMEOUT_MS,
    });
    const request: ProviderCreateRequest = {
      template: 'agent-browser',
      vault: false,
      timeoutMs: reservation.killTimeoutMs,
      onTimeout: 'kill',
      autoSuspendMs: 0,
      metadata: {
        rangerProject: input.projectId,
        rangerOperation: input.operationKey,
        rangerFeature: this.options.feature,
      },
      apiKey: this.options.apiKey ?? 'test-not-a-provider-key',
    };
    try {
      const machine = await this.options.provider.create(request);
      confirmInstaboxCreation(this.options.ledgerFile, {
        reservationId: reservation.reservationId,
        machineId: machine.machineId,
        purpose: input.projectId,
      });
      this.live.set(input.projectId, {
        projectId: input.projectId,
        operationKey: input.operationKey,
        machineId: machine.machineId,
        reservationId: reservation.reservationId,
        files: new Map(),
        commands: new Map(),
      });
      return {
        machineId: machine.machineId,
        vault: false,
        killTimeoutMs: reservation.killTimeoutMs,
        onTimeout: 'kill',
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/uncertain/i.test(message)) {
        const recorded = await this.options.provider.listByOperation(input.operationKey);
        uncertain.set(input.operationKey, { machineId: recorded?.machineId ?? null });
        throw new UncertainCreateError(input.operationKey);
      }
      releaseInstaboxReservation(this.options.ledgerFile, reservation.reservationId);
      throw new AppError('not_configured', 'Instabox provider unavailable', {
        details: { reason: 'provider_unavailable' },
      });
    }
  }

  async resolveUncertain(operationKey: string): Promise<{ machineId: string } | null> {
    const recorded = uncertain.get(operationKey);
    if (recorded === undefined) return null;
    if (recorded.machineId !== null) return { machineId: recorded.machineId };
    return null;
  }

  async runCommand(input: CommandRunInput): Promise<FinishedCommand> {
    const current = this.requireLive(input.projectId);
    const command = this.workloadCommand(input.argv);
    const result = await this.options.provider.exec({
      machineId: current.machineId,
      command,
      user: WORKLOAD_USER,
      cwd: WORKLOAD_PROJECT,
      timeoutMs: input.timeoutMs,
    });
    const stdout = bound(result.stdout);
    current.commands.set(input.commandId, {
      pid: 0,
      logs: stdout,
      state: result.exitCode === 0 ? 'succeeded' : 'failed',
      exitCode: result.exitCode,
    });
    return { exitCode: result.exitCode, stdout, stderr: bound(result.stderr), timedOut: result.timedOut };
  }

  async startBackground(input: CommandRunInput): Promise<BackgroundHandle> {
    const current = this.requireLive(input.projectId);
    void input.abortSignal;
    const result = await this.options.provider.exec({
      machineId: current.machineId,
      command: this.workloadCommand(input.argv),
      user: WORKLOAD_USER,
      cwd: WORKLOAD_PROJECT,
      timeoutMs: input.timeoutMs,
      background: true,
    });
    const pid = result.pid ?? 0;
    current.commands.set(input.commandId, { pid, logs: '', state: 'running', exitCode: null });
    return { pid, machineId: current.machineId };
  }

  async cancelCommand(projectId: string, commandId: string): Promise<CancelOutcome> {
    const current = this.requireLive(projectId);
    const command = current.commands.get(commandId);
    if (command === undefined) throw Errors.notFound('Command not found');
    await this.options.provider.signal({ machineId: current.machineId, pid: command.pid, signal: 'TERM' });
    const still = await this.options.provider.livePids(current.machineId, command.pid);
    if (still.length > 0) {
      await this.options.provider.signal({ machineId: current.machineId, pid: command.pid, signal: 'KILL' });
    }
    command.state = 'terminated';
    command.exitCode = null;
    return { state: 'terminated', pid: command.pid };
  }

  async writeFile(projectId: string, relativePath: string, content: string): Promise<void> {
    const current = this.requireLive(projectId);
    if (relativePath.includes('..') || relativePath.startsWith('/')) {
      throw Errors.validation('Workspace path escapes the project root', { reason: 'path_escape' });
    }
    current.files.set(relativePath, content);
    await this.options.provider.exec({
      machineId: current.machineId,
      command: `ranger-write ${relativePath} ${Buffer.byteLength(content)}`,
      user: WORKLOAD_USER,
      cwd: WORKLOAD_PROJECT,
      envs: { RANGER_B64: Buffer.from(content).toString('base64') },
      timeoutMs: 30_000,
    });
  }

  async persistSource(projectId: string): Promise<PersistedSource> {
    const current = this.requireLive(projectId);
    const root = this.options.sourceRoot;
    if (root === undefined) return { files: [...current.files.keys()] };
    const dest = path.join(root, projectId);
    for (const [relativePath, content] of current.files) {
      const abs = path.join(dest, relativePath);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content, { mode: 0o600 });
    }
    return { files: [...current.files.keys()].sort() };
  }

  async destroy(projectId: string): Promise<void> {
    const current = this.live.get(projectId);
    if (current === undefined) return;
    await this.persistSource(projectId);
    await this.options.provider.kill(current.machineId);
    recordInstaboxRelease(this.options.ledgerFile, current.machineId);
    this.live.delete(projectId);
  }

  async openDesktop(projectId: string, ttlMs: number): Promise<DesktopSessionRecord> {
    const current = this.requireLive(projectId);
    const ttlSeconds = Math.max(60, Math.floor(ttlMs / 1000));
    await this.options.provider.streamUrl(current.machineId, ttlSeconds);
    const sessionId = `dsk_${projectId.slice(4, 12)}`;
    return {
      sessionId,
      gatewayPath: `/v1/projects/${projectId}/desktop/sessions/${sessionId}/stream`,
      expiresAtMs: (this.options.now ?? Date.now)() + ttlMs,
    };
  }

  async openPreview(projectId: string, guestPort: number, ttlMs: number): Promise<PreviewSessionRecord> {
    const current = this.requireLive(projectId);
    void current;
    const sessionId = `pvs_${projectId.slice(4, 12)}`;
    return {
      sessionId,
      gatewayPath: `/v1/projects/${projectId}/preview/sessions/${sessionId}/app`,
      bindHost: '127.0.0.1',
      guestPort,
      expiresAtMs: (this.options.now ?? Date.now)() + ttlMs,
    };
  }

  async pause(projectId: string): Promise<never> {
    void projectId;
    throw new AppError('unsupported_operation', 'VM pause is not a supported capability', {
      details: { operation: 'pause' },
    });
  }

  async resume(projectId: string): Promise<never> {
    void projectId;
    throw new AppError('unsupported_operation', 'VM resume is not a supported capability', {
      details: { operation: 'resume' },
    });
  }

  ledgerSnapshot(): ReturnType<typeof readLedger> {
    return readLedger(this.options.ledgerFile);
  }

  private requireLive(projectId: string): LiveWorkspace {
    const current = this.live.get(projectId);
    if (current === undefined) throw Errors.notFound('No live workspace for this project');
    return current;
  }

  private workloadCommand(argv: string[]): string {
    const inner = shellQuote(argv.map(shellQuote).join(' '));
    return fencedWorkloadCommand(inner);
  }
}
