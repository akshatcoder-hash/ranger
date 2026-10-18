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

interface FakeProcess {
  pid: number;
  machineId: string;
  ignoresTerm: boolean;
  alive: boolean;
  command: string;
}

/**
 * In-memory Instabox stand-in for deterministic tests.
 * It records the provider wire and never dials the network.
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
  private failAmbiguous: string | null = null;
  private failDefinite = false;
  private operationToMachine = new Map<string, string>();

  failNextCreateAmbiguous(machineId: string): void {
    this.failAmbiguous = machineId;
  }

  failNextCreateDefinite(): void {
    this.failDefinite = true;
  }

  markTermIgnoring(pid: number): void {
    const proc = this.processes.find((item) => item.pid === pid);
    if (proc !== undefined) proc.ignoresTerm = true;
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
    if (request.background === true) {
      const pid = this.nextPid;
      this.nextPid += 1;
      this.processes.push({ pid, machineId: request.machineId, ignoresTerm: false, alive: true, command: request.command });
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, pid };
    }
    return this.interpret(request);
  }

  private interpret(request: ProviderCommandRequest): ProviderCommandResult {
    const files = this.files.get(request.machineId) ?? new Map<string, string>();
    this.files.set(request.machineId, files);
    const write = /^ranger-write (\S+) (\d+)$/.exec(request.command);
    if (write !== null) {
      const encoded = request.envs?.['RANGER_B64'] ?? '';
      files.set(write[1]!, Buffer.from(encoded, 'base64').toString('utf8'));
      return { stdout: 'ok\n', stderr: '', exitCode: 0, timedOut: false, truncated: false };
    }
    if (request.command.startsWith('ranger-list ')) {
      const prefix = request.command.slice('ranger-list '.length);
      const names = [...files.keys()].filter((name) => name.startsWith(prefix));
      return { stdout: names.join('\n'), stderr: '', exitCode: 0, timedOut: false, truncated: false };
    }
    if (request.command.startsWith('ranger-read ')) {
      const rel = request.command.slice('ranger-read '.length);
      const body = files.get(rel);
      if (body === undefined) return { stdout: '', stderr: 'missing\n', exitCode: 1, timedOut: false, truncated: false };
      return { stdout: Buffer.from(body).toString('base64'), stderr: '', exitCode: 0, timedOut: false, truncated: false };
    }
    if (request.command.includes('echo')) {
      const quoted = [...request.command.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '');
      const text = quoted.filter((part) => part !== 'echo').at(-1) ?? 'hello';
      return { stdout: `${text}\n`, stderr: '', exitCode: 0, timedOut: false, truncated: false };
    }
    if (request.command.includes('useradd') || request.command.includes('bootstrap-complete')) {
      return { stdout: 'bootstrap-complete\n', stderr: '', exitCode: 0, timedOut: false, truncated: false };
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
    return { stdout: 'ok\n', stderr: '', exitCode: 0, timedOut: false, truncated: false };
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
