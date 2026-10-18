import { Sandbox, type SandboxInfo } from '@insforge/instabox-sdk';
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

/**
 * Real Instabox SDK adapter. One implementation, no second backend.
 * The API key is passed per call and never written into guest env or metadata.
 */

function fromInfo(info: SandboxInfo, timeoutMs: number | null): ProviderMachine {
  return {
    machineId: info.sandboxId,
    state: info.state,
    vault: info.vault,
    onTimeout: info.onTimeout,
    timeoutMs,
    metadata: info.metadata,
  };
}

export class SdkInstaboxProvider implements InstaboxProvider {
  async create(request: ProviderCreateRequest): Promise<ProviderMachine> {
    if (request.vault !== false) {
      throw new Error('Instabox create refused: vault must be false');
    }
    if (request.envs !== undefined && Object.keys(request.envs).length > 0) {
      throw new Error('Instabox create refused: guest env injection is not allowed');
    }
    const sandbox = await Sandbox.create(request.template, {
      apiKey: request.apiKey,
      vault: false,
      timeoutMs: request.timeoutMs,
      onTimeout: 'kill',
      autoSuspendMs: 0,
      metadata: request.metadata,
    });
    const info = await sandbox.getInfo();
    const endAt = info.endAt?.getTime();
    const timeoutMs = endAt === undefined ? request.timeoutMs : Math.max(0, endAt - Date.now());
    return fromInfo(info, timeoutMs);
  }

  async get(machineId: string): Promise<ProviderMachine | null> {
    const listed = await Sandbox.list();
    const found = listed.find((item) => item.sandboxId === machineId);
    if (found === undefined) return null;
    const endAt = found.endAt?.getTime();
    return fromInfo(found, endAt === undefined ? null : Math.max(0, endAt - Date.now()));
  }

  async listByOperation(operationKey: string): Promise<ProviderMachine | null> {
    const listed = await Sandbox.list({ metadata: { rangerOperation: operationKey } });
    const found = listed[0];
    if (found === undefined) return null;
    const endAt = found.endAt?.getTime();
    return fromInfo(found, endAt === undefined ? null : Math.max(0, endAt - Date.now()));
  }

  async kill(machineId: string): Promise<boolean> {
    return Sandbox.kill(machineId);
  }

  async exec(request: ProviderCommandRequest): Promise<ProviderCommandResult> {
    const sandbox = await Sandbox.connect(request.machineId, { resume: false });
    if (request.background === true) {
      const handle = await sandbox.commands.run(request.command, {
        cwd: request.cwd,
        envs: request.envs,
        timeoutMs: request.timeoutMs,
        background: true,
      });
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, pid: handle.pid };
    }
    try {
      const result = await sandbox.commands.run(request.command, {
        cwd: request.cwd,
        envs: request.envs,
        timeoutMs: request.timeoutMs,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
      };
    } catch (cause) {
      const exited = cause as { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean; truncated?: boolean; name?: string };
      if (exited.name === 'CommandExitError' && typeof exited.exitCode === 'number') {
        return {
          stdout: exited.stdout ?? '',
          stderr: exited.stderr ?? '',
          exitCode: exited.exitCode,
          timedOut: exited.timedOut === true,
          truncated: exited.truncated === true,
        };
      }
      throw cause;
    }
  }

  async signal(request: ProviderSignal): Promise<boolean> {
    const sandbox = await Sandbox.connect(request.machineId, { resume: false });
    const result = await sandbox.commands.exec(`kill -${request.signal} -${request.pid}`, { timeoutMs: 10_000 });
    return result.exitCode === 0;
  }

  async livePids(machineId: string, leaderPid: number): Promise<number[]> {
    const sandbox = await Sandbox.connect(machineId, { resume: false });
    const result = await sandbox.commands.exec(`ps -o pid= -g ${leaderPid}`, { timeoutMs: 10_000 });
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  }

  async screenshot(machineId: string): Promise<Uint8Array> {
    const sandbox = await Sandbox.connect(machineId, { resume: false });
    return sandbox.desktop.screenshot();
  }

  async streamUrl(machineId: string, ttlSeconds: number): Promise<ProviderDesktopStream> {
    const sandbox = await Sandbox.connect(machineId, { resume: false });
    await sandbox.desktop.start();
    const stream = await sandbox.desktop.streamUrl({ viewOnly: true, ttlSeconds });
    return { url: stream.url, expiresAtMs: stream.expiresAt.getTime() };
  }

  async revokeStreams(machineId: string): Promise<void> {
    const sandbox = await Sandbox.connect(machineId, { resume: false });
    await sandbox.desktop.revokeStreamUrls();
  }

  async sshCredentials(machineId: string, publicKey: string, ttlSeconds: number): Promise<ProviderSshCredentials> {
    const sandbox = await Sandbox.connect(machineId, { resume: false });
    const creds = await sandbox.sshCredentials(publicKey, { ttlSeconds });
    return {
      host: creds.host,
      port: creds.port,
      username: creds.username,
      certificate: creds.certificate,
      knownHostsLine: creds.knownHostsLine,
      expiresAtMs: creds.expiresAt.getTime(),
      connectionId: creds.connectionId,
    };
  }
}
