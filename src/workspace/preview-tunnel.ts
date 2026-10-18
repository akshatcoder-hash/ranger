import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

export interface TunnelHandle {
  localPort: number;
  bindHost: '127.0.0.1';
  guestPort: number;
  pid: number;
  stop: () => Promise<void>;
}

interface OpenTunnelInput {
  host: string;
  port: number;
  username: string;
  certificate: string;
  knownHostsLine: string;
  guestPort: number;
  localPort: number;
}

const SECRET_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;

/**
 * Private SSH local forward. Binds 127.0.0.1 only, trusts the provider CA
 * line, and deletes the key and certificate on stop.
 */
export async function openPreviewTunnel(input: OpenTunnelInput): Promise<TunnelHandle> {
  const dir = mkdtempSync(path.join(tmpdir(), 'ranger-preview-'));
  chmodSync(dir, SECRET_DIR_MODE);
  const keyPath = path.join(dir, 'id_ed25519');
  const certPath = path.join(dir, 'id_ed25519-cert.pub');
  const knownHosts = path.join(dir, 'known_hosts');
  const pair = generateKeyPairSync('ed25519');
  writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: SECRET_FILE_MODE });
  writeFileSync(certPath, input.certificate.endsWith('\n') ? input.certificate : `${input.certificate}\n`, {
    mode: SECRET_FILE_MODE,
  });
  writeFileSync(knownHosts, input.knownHostsLine.endsWith('\n') ? input.knownHostsLine : `${input.knownHostsLine}\n`, {
    mode: SECRET_FILE_MODE,
  });
  const forward = `127.0.0.1:${input.localPort}:127.0.0.1:${input.guestPort}`;
  const child: ChildProcess = spawn(
    'ssh',
    [
      '-N',
      '-p',
      String(input.port),
      '-i',
      keyPath,
      '-o',
      `CertificateFile=${certPath}`,
      '-o',
      `UserKnownHostsFile=${knownHosts}`,
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      forward,
      `${input.username}@${input.host}`,
    ],
    { stdio: 'ignore' },
  );
  const stop = async (): Promise<void> => {
    if (child.exitCode === null) child.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  };
  return {
    localPort: input.localPort,
    bindHost: '127.0.0.1',
    guestPort: input.guestPort,
    pid: child.pid ?? -1,
    stop,
  };
}
