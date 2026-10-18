import type {
  InstaboxProvider,
  ProviderCommandRequest,
  ProviderCommandResult,
  ProviderCreateRequest,
  ProviderDesktopStream,
  ProviderMachine,
  ProviderSignal,
  ProviderSshCredentials,
} from './provider.js';
import { MAX_STDIN_BYTES } from '@insforge/instabox-sdk';
import { parseWriteTargetFromPayload } from './guest-write.js';
import { LAUNCHER_STAGE_CGROUP_ENTER, LAUNCHER_STAGE_CGROUP_MISSING, splitFencedCommand } from './limits.js';
import { sanitizeProviderError } from './diagnostics.js';

interface FakeProcess {
  pid: number;
  machineId: string;
  ignoresTerm: boolean;
  alive: boolean;
  command: string;
}

/**
 * Cwd values the template user can actually traverse. The project path is
 * owned by the workload identity, so a provider-level cwd there models the
 * real pre-privilege chdir denial.
 */
const TEMPLATE_ACCESSIBLE_CWDS = new Set(['/data/home', '/tmp', '/data', '/']);

/**
 * In-memory Instabox stand-in for deterministic tests.
 * It records the provider wire, models the real cwd and write protocol,
 * and never dials the network. Unknown commands fail closed.
 */
export class FakeInstabox implements InstaboxProvider {
  readonly creates: ProviderCreateRequest[] = [];
  readonly commands: ProviderCommandRequest[] = [];
  readonly signals: ProviderSignal[] = [];
  readonly kills: string[] = [];
  readonly pauses: string[] = [];
  readonly resumes: string[] = [];

  private nextId = 1;
  private nextPid = 4000;
  private machines = new Map<string, ProviderMachine>();
  private processes: FakeProcess[] = [];
  private files = new Map<string, Map<string, string>>();
  private symlinks = new Map<string, Map<string, string>>();
  private failAmbiguous: string | null = null;
  private failDefinite = false;
  private writeFailure: ProviderCommandResult | null = null;
  private operationToMachine = new Map<string, string>();

  failNextCreateAmbiguous(machineId: string): void {
    this.failAmbiguous = machineId;
  }

  failNextCreateDefinite(): void {
    this.failDefinite = true;
  }

  /** Make the next guest write fail with this bounded, secret-safe reason. */
  failNextWrite(reason: string): void {
    this.writeFailure = { stdout: '', stderr: `${reason}\n`, exitCode: 4, timedOut: false, truncated: false };
  }

  /**
   * Model a write killed by the guest agent at the command deadline: a
   * non-zero exit with empty streams and timedOut=true. The kill exit-code
   * convention belongs to the real server (124 is the modeled stand-in);
   * what the write path must preserve is the timedOut flag itself.
   */
  failNextWriteTimedOut(): void {
    this.writeFailure = { stdout: '', stderr: '', exitCode: 124, timedOut: true, truncated: false };
  }

  /**
   * Model the window1 evidence shape: a silent non-zero exit from the
   * trusted launcher with both streams empty and timedOut=false.
   */
  failNextWriteSilentExit(exitCode: number): void {
    this.writeFailure = { stdout: '', stderr: '', exitCode, timedOut: false, truncated: false };
  }

  /** Model a trusted-launcher check/setup stage failure: the fixed stage
   * marker on stderr and the stage's fixed exit code. */
  failNextWriteLauncherStage(stage: 'cgroup_missing' | 'cgroup_enter'): void {
    this.writeFailure =
      stage === 'cgroup_missing'
        ? { stdout: '', stderr: `${LAUNCHER_STAGE_CGROUP_MISSING}\n`, exitCode: 10, timedOut: false, truncated: false }
        : { stdout: '', stderr: `${LAUNCHER_STAGE_CGROUP_ENTER}\n`, exitCode: 11, timedOut: false, truncated: false };
  }

  /** Plant a workload-planted symlink at a project-relative path. */
  plantSymlink(machineId: string, relativePath: string, absoluteTarget: string): void {
    let map = this.symlinks.get(machineId);
    if (map === undefined) {
      map = new Map();
      this.symlinks.set(machineId, map);
    }
    map.set(relativePath, absoluteTarget);
  }

  markTermIgnoring(pid: number): void {
    const proc = this.processes.find((item) => item.pid === pid);
    if (proc !== undefined) proc.ignoresTerm = true;
  }

  lastBackgroundPid(): number | null {
    return this.processes.at(-1)?.pid ?? null;
  }

  livePidsSync(leaderPid: number): number[] {
    return this.processes.filter((item) => item.pid === leaderPid && item.alive).map((item) => item.pid);
  }

  async create(request: ProviderCreateRequest): Promise<ProviderMachine> {
    this.creates.push({ ...request, metadata: { ...request.metadata } });
    if (this.failDefinite) {
      this.failDefinite = false;
      throw new Error('provider unavailable');
    }
    if (this.failAmbiguous !== null) {
      const machineId = this.failAmbiguous;
      this.failAmbiguous = null;
      const machine = this.remember(machineId, request);
      this.operationToMachine.set(request.metadata['rangerOperation'] ?? '', machineId);
      throw new Error(`uncertain create: machine ${machine.machineId} may exist`);
    }
    const machineId = `m_fake_${this.nextId}`;
    this.nextId += 1;
    const machine = this.remember(machineId, request);
    this.operationToMachine.set(request.metadata['rangerOperation'] ?? '', machineId);
    this.files.set(machineId, new Map());
    return machine;
  }

  private remember(machineId: string, request: ProviderCreateRequest): ProviderMachine {
    const machine: ProviderMachine = {
      machineId,
      state: 'running',
      vault: request.vault,
      onTimeout: request.onTimeout,
      timeoutMs: request.timeoutMs,
      metadata: { ...request.metadata },
    };
    this.machines.set(machineId, machine);
    if (!this.files.has(machineId)) this.files.set(machineId, new Map());
    return machine;
  }

  async get(machineId: string): Promise<ProviderMachine | null> {
    return this.machines.get(machineId) ?? null;
  }

  async listByOperation(operationKey: string): Promise<ProviderMachine | null> {
    const machineId = this.operationToMachine.get(operationKey);
    if (machineId === undefined) return null;
    return this.machines.get(machineId) ?? null;
  }

  async kill(machineId: string): Promise<boolean> {
    this.kills.push(machineId);
    const existed = this.machines.delete(machineId);
    this.processes = this.processes.filter((item) => item.machineId !== machineId);
    return existed;
  }

  async exec(request: ProviderCommandRequest): Promise<ProviderCommandResult> {
    this.commands.push(request);
    // The real SDK rejects stdin above its cap before the HTTP call; model
    // the same rule using the SDK's own constant so wire tests are faithful.
    if (request.stdin !== undefined && Buffer.byteLength(request.stdin, 'utf8') > MAX_STDIN_BYTES) {
      throw new Error(`stdin is longer than ${MAX_STDIN_BYTES} bytes`);
    }
    if (request.background === true) {
      const pid = this.nextPid;
      this.nextPid += 1;
      this.processes.push({ pid, machineId: request.machineId, ignoresTerm: false, alive: true, command: request.command });
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, pid };
    }
    const cwdDenial = this.cwdDenial(request);
    if (cwdDenial !== null) return cwdDenial;
    const fenced = splitFencedCommand(request.command);
    if (fenced !== null) return this.interpretWorkload(request, fenced.payload);
    return this.interpret(request);
  }

  /**
   * The SDK guest agent applies cwd as the template user before the command
   * runs. A cwd the template user cannot traverse fails the launch before
   * any shell starts, with the diagnosis on the server error field.
   */
  private cwdDenial(request: ProviderCommandRequest): ProviderCommandResult | null {
    if (request.cwd === undefined || TEMPLATE_ACCESSIBLE_CWDS.has(request.cwd)) return null;
    const raw = `failed to start command: chdir ${request.cwd}: permission denied`;
    const detail = sanitizeProviderError(raw, request.command);
    return { stdout: '', stderr: detail, exitCode: 126, timedOut: false, truncated: false, error: detail };
  }

  /**
   * Interpret the post-drop payload of a fenced workload command. The fake
   * models the identity boundary: inside the fence the caller is the
   * restricted user, so payload-side sudo fails even though the trusted
   * launcher itself used sudo for the setup.
   */
  private interpretWorkload(request: ProviderCommandRequest, payload: string): ProviderCommandResult {
    const machineId = request.machineId;
    const files = this.files.get(machineId) ?? new Map<string, string>();
    this.files.set(machineId, files);
    const planted = this.symlinks.get(machineId) ?? new Map<string, string>();

    // Real guest write protocol: no-follow script, target as a post-drop
    // assignment, payload on stdin. Modeled with the same refusals as the
    // guest script.
    const writeTarget = parseWriteTargetFromPayload(payload);
    if (writeTarget !== null && payload.includes('python3 -c')) {
      return this.interpretWrite(request, files, planted, writeTarget);
    }
    if (payload.includes('echo')) {
      const tokens = [...payload.matchAll(/'([^'\\]+)'/g)].map((match) => match[1] ?? '');
      const text = tokens.filter((token) => token !== 'echo').at(-1) ?? 'hello';
      return { stdout: `${text}\n`, stderr: '', exitCode: 0, timedOut: false, truncated: false };
    }
    if (payload.includes('id -u')) {
      return { stdout: '1100\n', stderr: '', exitCode: 0, timedOut: false, truncated: false };
    }
    if (payload.includes('sudo -n')) {
      return { stdout: '', stderr: 'sudo: a password is required\n', exitCode: 1, timedOut: false, truncated: false };
    }
    if (payload.includes('docker')) {
      return { stdout: '', stderr: 'permission denied\n', exitCode: 1, timedOut: false, truncated: false };
    }
    // Fail closed: an unmodeled command must not look like a quiet success.
    return {
      stdout: '',
      stderr: 'fake-provider-unsupported-command\n',
      exitCode: 127,
      timedOut: false,
      truncated: false,
      error: 'fake-provider-unsupported-command',
    };
  }

  private interpret(request: ProviderCommandRequest): ProviderCommandResult {
    const machineId = request.machineId;
    const files = this.files.get(machineId) ?? new Map<string, string>();
    this.files.set(machineId, files);
    if (request.command.includes('useradd') || request.command.includes('bootstrap-complete')) {
      return { stdout: 'bootstrap-complete\n', stderr: '', exitCode: 0, timedOut: false, truncated: false };
    }
    if (request.command.includes('echo')) {
      const tokens = [...request.command.matchAll(/'([^'\\]+)'/g)].map((match) => match[1] ?? '');
      const text = tokens.filter((token) => token !== 'echo').at(-1) ?? 'hello';
      return { stdout: `${text}\n`, stderr: '', exitCode: 0, timedOut: false, truncated: false };
    }
    if (request.command.includes('id -u')) {
      return { stdout: '1100\n', stderr: '', exitCode: 0, timedOut: false, truncated: false };
    }
    if (request.command.includes('sudo -n')) {
      return { stdout: '', stderr: 'sudo: a password is required\n', exitCode: 1, timedOut: false, truncated: false };
    }
    if (request.command.includes('docker')) {
      return { stdout: '', stderr: 'permission denied\n', exitCode: 1, timedOut: false, truncated: false };
    }
    // Fail closed: an unmodeled command must not look like a quiet success.
    return {
      stdout: '',
      stderr: 'fake-provider-unsupported-command\n',
      exitCode: 127,
      timedOut: false,
      truncated: false,
      error: 'fake-provider-unsupported-command',
    };
  }

  private interpretWrite(
    request: ProviderCommandRequest,
    files: Map<string, string>,
    planted: Map<string, string>,
    relativePath: string,
  ): ProviderCommandResult {
    const refused = (errno: number): ProviderCommandResult => ({
      stdout: '',
      stderr: `guest-write-refused errno=${errno}\n`,
      exitCode: 4,
      timedOut: false,
      truncated: false,
    });
    if (this.writeFailure !== null) {
      const failure = this.writeFailure;
      this.writeFailure = null;
      return failure;
    }
    const parts = relativePath.split('/').filter((part) => part !== '' && part !== '.');
    if (relativePath.startsWith('/') || parts.length === 0 || parts.includes('..')) return refused(0);
    // O_NOFOLLOW parity: any workload-planted symlink on the path is
    // refused, never followed, including intermediate directories.
    for (let depth = 1; depth <= parts.length; depth += 1) {
      if (planted.has(parts.slice(0, depth).join('/'))) return refused(40);
    }
    const payload = Buffer.from(request.stdin ?? '', 'base64').toString('utf8');
    files.set(parts.join('/'), payload);
    return { stdout: 'guest-write-ok\n', stderr: '', exitCode: 0, timedOut: false, truncated: false };
  }

  async signal(request: ProviderSignal): Promise<boolean> {
    this.signals.push(request);
    const proc = this.processes.find((item) => item.pid === request.pid && item.machineId === request.machineId);
    if (proc === undefined || !proc.alive) return false;
    if (request.signal === 'TERM' && proc.ignoresTerm) return true;
    proc.alive = false;
    return true;
  }

  async livePids(machineId: string, leaderPid: number): Promise<number[]> {
    return this.processes
      .filter((item) => item.machineId === machineId && item.pid === leaderPid && item.alive)
      .map((item) => item.pid);
  }

  async screenshot(machineId: string): Promise<Uint8Array> {
    void machineId;
    return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
  }

  async streamUrl(machineId: string, ttlSeconds: number): Promise<ProviderDesktopStream> {
    return {
      url: `https://stream.example/desktop/${machineId}?token=bearer-secret`,
      expiresAtMs: Date.now() + ttlSeconds * 1000,
    };
  }

  async revokeStreams(_machineId: string): Promise<void> {
    return;
  }

  async sshCredentials(machineId: string, _publicKey: string, ttlSeconds: number): Promise<ProviderSshCredentials> {
    return {
      host: 'ssh.example',
      port: 2222,
      username: machineId,
      certificate: 'ssh-ed25519-cert-v01@openssh.com BEGIN CERT secret',
      knownHostsLine: `@cert-authority [ssh.example]:2222 ssh-ed25519 AAAA`,
      expiresAtMs: Date.now() + ttlSeconds * 1000,
      connectionId: `conn_${machineId}`,
    };
  }
}
