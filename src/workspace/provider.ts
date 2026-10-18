/**
 * The one Instabox SDK surface Ranger uses.
 *
 * Methods match @insforge/instabox-sdk@0.5.3. Pause/resume exist on the SDK
 * and are deliberately not part of this interface: the product lifecycle is
 * create, work, preview, destroy.
 */

export interface ProviderCreateRequest {
  template: 'agent-browser';
  vault: false;
  timeoutMs: number;
  onTimeout: 'kill';
  /** 0 disables the provider idle pause. Ranger still destroys at its own deadline. */
  autoSuspendMs: 0;
  metadata: Record<string, string>;
  apiKey: string;
  /** Must stay unset. Provider keys never ride guest env. */
  envs?: Record<string, string>;
}

export interface ProviderMachine {
  machineId: string;
  state: string;
  vault: boolean;
  onTimeout: 'pause' | 'kill';
  timeoutMs: number | null;
  metadata: Record<string, string>;
}

export interface ProviderCommandRequest {
  machineId: string;
  command: string;
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
  background?: boolean;
  /** User the guest command must run as. Workload calls pass the restricted identity. */
  user?: string;
}

export interface ProviderCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  pid?: number;
}

export interface ProviderSignal {
  machineId: string;
  pid: number;
  signal: 'TERM' | 'KILL';
}

export interface ProviderDesktopStream {
  /** Bearer URL. Server-side only. Never returned to a client. */
  url: string;
  expiresAtMs: number;
}

export interface ProviderSshCredentials {
  host: string;
  port: number;
  username: string;
  certificate: string;
  knownHostsLine: string;
  expiresAtMs: number;
  connectionId: string;
}

export interface InstaboxProvider {
  create(request: ProviderCreateRequest): Promise<ProviderMachine>;
  get(machineId: string): Promise<ProviderMachine | null>;
  listByOperation(operationKey: string): Promise<ProviderMachine | null>;
  kill(machineId: string): Promise<boolean>;
  exec(request: ProviderCommandRequest): Promise<ProviderCommandResult>;
  signal(request: ProviderSignal): Promise<boolean>;
  /** Live descendant pids of a recorded command, including the leader. */
  livePids(machineId: string, leaderPid: number): Promise<number[]>;
  screenshot(machineId: string): Promise<Uint8Array>;
  streamUrl(machineId: string, ttlSeconds: number): Promise<ProviderDesktopStream>;
  revokeStreams(machineId: string): Promise<void>;
  sshCredentials(machineId: string, publicKey: string, ttlSeconds: number): Promise<ProviderSshCredentials>;
}
