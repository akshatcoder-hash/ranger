import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RangerConfig } from '../config.js';
import type { SecretResolver } from '../secrets.js';
import { AppError, Errors } from '../errors.js';
import {
  confirmInstaboxCreation,
  releaseInstaboxReservation,
  reserveInstaboxCreation,
  recordInstaboxRelease,
} from '../budget/ledger.js';
import { withTransaction } from '../db/db.js';
import {
  COMMAND_OUTPUT_CAP_BYTES,
  FIXED_PREVIEW_PORTS,
  GUEST_TRANSPORT_CAP_BYTES,
  VM_KILL_TIMEOUT_MS,
  WORKLOAD_USER,
  fencedWorkloadCommand,
  isFixedPreviewPort,
} from './limits.js';
import { guestWriteCommand } from './guest-write.js';
import { guestWriteDetail } from './diagnostics.js';
import { bootstrapWorkload } from './bootstrap.js';
import { armWorkspaceWatchdog, destroyFailedBootstrap, destroyRecordedWorkspace } from './cleanup.js';
import { SdkInstaboxProvider } from './sdk-provider.js';
import { rememberDesktopStream, forgetDesktopStream } from './viewing.js';
import { mintPreviewKeypair, openPreviewTunnel, type TunnelHandle } from './preview-tunnel.js';
import { workspaceProviderForTests } from './runtime.js';
import type { InstaboxProvider, ProviderCreateRequest } from './provider.js';
import {
  getArtifact,
  getCommand,
  getPreviewSession,
  getWorkspace,
  insertArtifact,
  insertCommand,
  insertDesktopSession,
  insertPreviewSession,
  insertWorkspace,
  listArtifacts,
  listSourceFiles,
  listTestCommandRows,
  markCommandTerminated,
  markWorkspaceDestroyed,
  markWorkspaceRunning,
  markWorkspaceUncertain,
  readSourceFile,
  revokeDesktopSession,
  saveSourceFile,
  setPreviewLocalPort,
  stopPreviewSession,
  type CommandRow,
  type WorkspaceRow,
} from './store.js';

const FEATURE = 'lean-instabox-workspace-viewing';
const previewTunnels = new Map<string, TunnelHandle>();

export interface WorkspaceServiceOptions {
  db: DatabaseSync;
  config: RangerConfig;
  secrets: SecretResolver;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function providerFor(options: WorkspaceServiceOptions): InstaboxProvider {
  return workspaceProviderForTests() ?? new SdkInstaboxProvider(apiKeyFor(options));
}

function apiKeyFor(options: WorkspaceServiceOptions): string {
  if (workspaceProviderForTests() !== null) return 'deterministic-test-key';
  return options.secrets.get('INSTABOX_API_KEY');
}

function requireLedger(config: RangerConfig): string {
  if (config.liveBudgetFile === null) {
    throw Errors.notConfigured('Live budget ledger is not configured', { reason: 'ledger_unset' });
  }
  return config.liveBudgetFile;
}

function assertSafeRelative(relativePath: string): void {
  if (relativePath.length === 0 || relativePath.startsWith('/') || relativePath.includes('..') || relativePath.includes('\0')) {
    throw Errors.validation('Workspace path is outside the project root', { reason: 'path_escape' });
  }
}

function workloadShell(argv: string[]): string {
  return fencedWorkloadCommand(argv.map(shellQuote).join(' '));
}

export class WorkspaceService {
  constructor(private readonly options: WorkspaceServiceOptions) {}

  status(projectId: string): WorkspaceRow {
    const row = getWorkspace(this.options.db, projectId);
    if (row === null) throw Errors.notFound('No workspace for this project');
    return row;
  }

  async create(projectId: string, sourceRevision: string | null, _requestId: string): Promise<WorkspaceRow> {
    const existing = getWorkspace(this.options.db, projectId);
    if (existing?.uncertain === true) {
      throw new AppError('conflict', 'An earlier Instabox create is uncertain; refusing another create', {
        details: { reason: 'uncertain_create' },
      });
    }
    if (existing !== null && existing.observedState === 'running' && existing.destroyedAt === null) {
      return existing;
    }
    if (existing !== null && existing.observedState !== 'destroyed') {
      throw new AppError('conflict', 'A workspace create is already recorded for this project', {
        details: { reason: 'workspace_create_in_progress', observedState: existing.observedState },
      });
    }
    const operationKey = `ws-${projectId}-${randomUUID()}`;
    if (this.options.db.isTransaction) {
      insertWorkspace(this.options.db, { projectId, operationKey, sourceRevision });
    } else {
      withTransaction(this.options.db, () => {
        insertWorkspace(this.options.db, { projectId, operationKey, sourceRevision });
      });
    }
    const ledgerFile = requireLedger(this.options.config);
    const reservation = reserveInstaboxCreation(ledgerFile, {
      feature: FEATURE,
      purpose: projectId,
      killTimeoutMs: VM_KILL_TIMEOUT_MS,
    });
    const request: ProviderCreateRequest = {
      template: 'agent-browser',
      vault: false,
      timeoutMs: reservation.killTimeoutMs,
      onTimeout: 'kill',
      autoSuspendMs: 0,
      metadata: {
        rangerProject: projectId,
        rangerOperation: operationKey,
        rangerFeature: FEATURE,
      },
      apiKey: apiKeyFor(this.options),
    };
    try {
      const machine = await providerFor(this.options).create(request);
      confirmInstaboxCreation(ledgerFile, {
        reservationId: reservation.reservationId,
        machineId: machine.machineId,
        purpose: projectId,
      });
      const deadlineAt = Date.now() + reservation.killTimeoutMs;
      markWorkspaceRunning(this.options.db, {
        projectId,
        machineId: machine.machineId,
        reservationId: reservation.reservationId,
        killTimeoutMs: reservation.killTimeoutMs,
        deadlineAt,
      });
      try {
        await bootstrapWorkload(providerFor(this.options), machine.machineId);
      } catch (cause) {
        await destroyFailedBootstrap({
          db: this.options.db,
          provider: providerFor(this.options),
          ledgerFile: this.options.config.liveBudgetFile,
          projectId,
        });
        throw cause;
      }
      armWorkspaceWatchdog({
        deadlineAt,
        onDeadline: () =>
          destroyRecordedWorkspace({
            db: this.options.db,
            provider: providerFor(this.options),
            ledgerFile: this.options.config.liveBudgetFile,
            projectId,
          }),
      });
      return this.status(projectId);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/uncertain/i.test(message)) {
        markWorkspaceUncertain(this.options.db, projectId, reservation.reservationId);
        throw new AppError('conflict', 'Instabox create outcome is uncertain; not creating again', {
          details: { reason: 'uncertain_create' },
        });
      }
      if (cause instanceof AppError) throw cause;
      if (/bootstrap/i.test(message)) {
        throw Errors.conflict('Workload bootstrap failed; the machine was destroyed', {
          reason: 'bootstrap_failed',
          detail: message.slice(0, 400),
        });
      }
      releaseInstaboxReservation(ledgerFile, reservation.reservationId);
      throw Errors.notConfigured('Instabox provider is not available', { reason: 'provider_unavailable' });
    }
  }

  async writeFile(projectId: string, relativePath: string, content: Buffer): Promise<{ path: string; sizeBytes: number }> {
    assertSafeRelative(relativePath);
    // Derived from the SDK stdin rule: base64 of a raw payload larger than
    // this would exceed MAX_STDIN_BYTES and fail the SDK call. Refuse before
    // exec so oversized writes can never surface as a provider 500.
    if (content.byteLength > GUEST_TRANSPORT_CAP_BYTES) {
      throw Errors.validation(
        `Workspace file exceeds the guest transport cap of ${GUEST_TRANSPORT_CAP_BYTES} bytes`,
        { reason: 'file_too_large' },
      );
    }
    const workspace = this.requireRunning(projectId);
    // Real guest write: fenced workload identity with a trusted sudo'd
    // launcher, no provider-level cwd, the no-follow script refuses
    // workload-planted symlinks. The target rides the fenced payload (not
    // ambient env) and the payload bytes ride stdin. The source is recorded
    // only after the guest write succeeded, so a failed write is never
    // presented as saved source.
    const written = await providerFor(this.options).exec({
      machineId: workspace.machineId!,
      command: guestWriteCommand(relativePath),
      user: WORKLOAD_USER,
      stdin: content.toString('base64'),
      timeoutMs: 30_000,
    });
    if (written.exitCode !== 0) {
      // Preserve the SDK failure fields through guest_write_failed: the
      // numeric exitCode and the timedOut/truncated flags distinguish a
      // kill-at-deadline from an instant silent exit (the window1 evidence
      // shape). The detail text stays redacted and bounded; the fields
      // are structured values, so no payload or secret can ride them.
      throw Errors.conflict('Workspace file was not written in the guest', {
        reason: 'guest_write_failed',
        detail: guestWriteDetail(written.stderr, written.stdout),
        exitCode: written.exitCode,
        timedOut: written.timedOut,
        truncated: written.truncated,
      });
    }
    saveSourceFile(this.options.db, projectId, relativePath, content);
    return { path: relativePath, sizeBytes: content.byteLength };
  }

  listFiles(projectId: string, prefix: string): Array<{ path: string; type: 'file'; sizeBytes: number }> {
    this.requireKnown(projectId);
    return listSourceFiles(this.options.db, projectId, prefix).map((file) => ({
      path: file.path,
      type: 'file' as const,
      sizeBytes: file.sizeBytes,
    }));
  }

  readFile(projectId: string, relativePath: string): { path: string; contentBase64: string; sizeBytes: number } {
    assertSafeRelative(relativePath);
    this.requireKnown(projectId);
    const content = readSourceFile(this.options.db, projectId, relativePath);
    if (content === null) throw Errors.notFound('Workspace file not found');
    return { path: relativePath, contentBase64: content.toString('base64'), sizeBytes: content.byteLength };
  }

  async runCommand(
    projectId: string,
    argv: string[],
    timeoutMs: number,
    background = false,
    attribution?: { runId?: string; isTest?: boolean },
  ): Promise<CommandRow> {
    const workspace = this.requireRunning(projectId);
    const result = await providerFor(this.options).exec({
      machineId: workspace.machineId!,
      command: workloadShell(argv),
      user: WORKLOAD_USER,
      timeoutMs,
      background,
    });
    const logs = (result.stdout + result.stderr).slice(0, COMMAND_OUTPUT_CAP_BYTES);
    return insertCommand(this.options.db, {
      projectId,
      argv,
      state: background ? 'running' : result.exitCode === 0 ? 'succeeded' : 'failed',
      pid: result.pid ?? null,
      logs,
      exitCode: background ? null : result.exitCode,
      timedOut: result.timedOut,
      runId: attribution?.runId ?? null,
      isTest: attribution?.isTest === true,
    });
  }

  /** Persisted test-outcome commands (real exit codes) for the tests read. */
  testResults(projectId: string): CommandRow[] {
    this.requireKnown(projectId);
    return listTestCommandRows(this.options.db, projectId);
  }

  command(projectId: string, commandId: string): CommandRow {
    const row = getCommand(this.options.db, projectId, commandId);
    if (row === null) throw Errors.notFound('Command not found');
    return row;
  }

  logs(projectId: string, commandId: string, sinceByte: number): { logs: string; totalBytes: number; truncated: boolean } {
    const row = this.command(projectId, commandId);
    const sliced = row.logs.slice(sinceByte);
    return { logs: sliced, totalBytes: row.logBytes, truncated: row.truncated };
  }

  async terminate(projectId: string, commandId: string): Promise<CommandRow> {
    const workspace = this.requireRunning(projectId);
    const row = this.command(projectId, commandId);
    if (row.pid !== null) {
      await providerFor(this.options).signal({ machineId: workspace.machineId!, pid: row.pid, signal: 'TERM' });
      const live = await providerFor(this.options).livePids(workspace.machineId!, row.pid);
      if (live.length > 0) {
        await providerFor(this.options).signal({ machineId: workspace.machineId!, pid: row.pid, signal: 'KILL' });
      }
    }
    markCommandTerminated(this.options.db, projectId, commandId);
    return this.command(projectId, commandId);
  }

  async screenshot(projectId: string): Promise<{ artifactId: string; contentBase64: string }> {
    const workspace = this.requireRunning(projectId);
    const png = await providerFor(this.options).screenshot(workspace.machineId!);
    const content = Buffer.from(png);
    const artifact = insertArtifact(this.options.db, projectId, 'screenshot.png', content);
    return { artifactId: artifact.id, contentBase64: content.toString('base64') };
  }

  diff(projectId: string): { diff: string; changedFiles: string[] } {
    this.requireKnown(projectId);
    const files = listSourceFiles(this.options.db, projectId, '');
    return {
      diff: files.map((file) => `saved ${file.path}`).join('\n'),
      changedFiles: files.map((file) => file.path),
    };
  }

  artifacts(projectId: string): Array<{ id: string; name: string; sizeBytes: number; createdAt: number }> {
    this.requireKnown(projectId);
    return listArtifacts(this.options.db, projectId);
  }

  artifact(projectId: string, artifactId: string): { contentBase64: string } {
    this.requireKnown(projectId);
    const row = getArtifact(this.options.db, projectId, artifactId);
    if (row === null) throw Errors.notFound('Artifact not found');
    return { contentBase64: row.content.toString('base64') };
  }

  async destroy(projectId: string): Promise<WorkspaceRow> {
    const workspace = this.requireKnown(projectId);
    if (workspace.machineId !== null && workspace.observedState !== 'destroyed') {
      await providerFor(this.options).kill(workspace.machineId);
      if (this.options.config.liveBudgetFile !== null) {
        recordInstaboxRelease(this.options.config.liveBudgetFile, workspace.machineId);
      }
    }
    markWorkspaceDestroyed(this.options.db, projectId);
    return this.status(projectId);
  }

  async openDesktop(projectId: string, ttlSeconds: number): Promise<{ sessionId: string; expiresAt: number; gatewayPath: string }> {
    const workspace = this.requireRunning(projectId);
    const bounded = Math.min(60, Math.max(5, ttlSeconds));
    const session = insertDesktopSession(this.options.db, projectId, bounded * 1000);
    const stream = await providerFor(this.options).streamUrl(workspace.machineId!, bounded);
    rememberDesktopStream(session.id, stream);
    return {
      sessionId: session.id,
      expiresAt: session.expiresAt,
      gatewayPath: `/v1/projects/${projectId}/desktop/sessions/${session.id}/stream`,
    };
  }

  revokeDesktop(projectId: string, sessionId: string): void {
    const workspace = this.requireKnown(projectId);
    revokeDesktopSession(this.options.db, projectId, sessionId);
    forgetDesktopStream(sessionId);
    if (workspace.machineId !== null) {
      void providerFor(this.options).revokeStreams(workspace.machineId);
    }
  }

  async openPreview(projectId: string, guestPort: number): Promise<{ sessionId: string; expiresAt: number; gatewayPath: string }> {
    if (!isFixedPreviewPort(guestPort)) {
      throw Errors.validation('Preview target must be a fixed authorized guest port', {
        reason: 'preview_target_rejected',
        allowed: [...FIXED_PREVIEW_PORTS],
      });
    }
    const workspace = this.requireRunning(projectId);
    const session = insertPreviewSession(this.options.db, projectId, guestPort, 60_000);
    if (workspaceProviderForTests() === null && workspace.machineId !== null) {
      const tunnel = await this.openFixedTunnel(workspace.machineId, guestPort);
      previewTunnels.set(session.id, tunnel);
      setPreviewLocalPort(this.options.db, projectId, session.id, tunnel.localPort);
    }
    return {
      sessionId: session.id,
      expiresAt: session.expiresAt,
      gatewayPath: `/v1/projects/${projectId}/preview/sessions/${session.id}/app`,
    };
  }

  async stopPreview(projectId: string, sessionId: string): Promise<void> {
    this.requireKnown(projectId);
    const tunnel = previewTunnels.get(sessionId);
    if (tunnel !== undefined) {
      previewTunnels.delete(sessionId);
      await tunnel.stop();
    }
    stopPreviewSession(this.options.db, projectId, sessionId);
  }

  /** Loopback bind of an already-open preview, for gateway proxying. */
  previewBind(projectId: string, sessionId: string): { host: '127.0.0.1'; port: number } | null {
    const row = getPreviewSession(this.options.db, projectId, sessionId);
    if (row === null || row.localPort === null) return null;
    return { host: '127.0.0.1', port: row.localPort };
  }

  private async openFixedTunnel(machineId: string, guestPort: number): Promise<TunnelHandle> {
    const key = mintPreviewKeypair();
    const creds = await providerFor(this.options).sshCredentials(machineId, key.publicKey, 120);
    return openPreviewTunnel({
      host: creds.host,
      port: creds.port,
      username: creds.username,
      certificate: creds.certificate,
      knownHostsLine: creds.knownHostsLine,
      guestPort,
      privateKeyPem: key.privateKeyPem,
    });
  }

  rejectDeferred(operation: string): never {
    throw Errors.unsupported(`${operation} is not a supported capability`, { operation });
  }

  private requireKnown(projectId: string): WorkspaceRow {
    const row = getWorkspace(this.options.db, projectId);
    if (row === null) throw Errors.notFound('No workspace for this project');
    return row;
  }

  private requireRunning(projectId: string): WorkspaceRow {
    const row = this.requireKnown(projectId);
    if (row.observedState !== 'running' || row.machineId === null) {
      throw Errors.conflict('Workspace is not running', { observedState: row.observedState });
    }
    if (row.deadlineAt !== null && Date.now() > row.deadlineAt) {
      throw Errors.conflict('Workspace deadline has passed', { reason: 'deadline_exceeded' });
    }
    return row;
  }
}
