import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
  localPort?: number;
  /** PKCS8 PEM for the public key that was signed. Required for a real tunnel. */
  privateKeyPem: string;
}

/** OpenSSH authorized_keys line for an Ed25519 public key. Not PEM. */
export function opensshEd25519PublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const raw = der.subarray(der.length - 32);
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from('ssh-ed25519'),
    Buffer.from([0, 0, 0, 32]),
    raw,
  ]);
  return `ssh-ed25519 ${blob.toString('base64')} ranger-preview`;
}

export function mintPreviewKeypair(): { publicKey: string; privateKeyPem: string } {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: opensshEd25519PublicKey(pair.publicKey),
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
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
  const localPort = input.localPort ?? (await reserveLoopbackPort());
  writeFileSync(keyPath, input.privateKeyPem, { mode: SECRET_FILE_MODE });
  writeFileSync(certPath, input.certificate.endsWith('\n') ? input.certificate : `${input.certificate}\n`, {
    mode: SECRET_FILE_MODE,
  });
  writeFileSync(knownHosts, input.knownHostsLine.endsWith('\n') ? input.knownHostsLine : `${input.knownHostsLine}\n`, {
    mode: SECRET_FILE_MODE,
  });
  const forward = `127.0.0.1:${localPort}:127.0.0.1:${input.guestPort}`;
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
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-L',
      forward,
      `${input.username}@${input.host}`,
    ],
    { stdio: 'ignore' },
  );
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
    rmSync(dir, { recursive: true, force: true });
  };
  await waitForForward(child, localPort);
  return {
    localPort,
    bindHost: '127.0.0.1',
    guestPort: input.guestPort,
    pid: child.pid ?? -1,
    stop,
  };
}

function waitForForward(child: ChildProcess, localPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const finish = (error: Error | null): void => {
      clearInterval(timer);
      if (error === null) resolve();
      else reject(error);
    };
    const timer = setInterval(() => {
      if (child.exitCode !== null) {
        finish(new Error('preview ssh forward exited before it was ready'));
        return;
      }
      if (Date.now() - started > 20_000) {
        finish(new Error('preview ssh forward did not bind'));
        return;
      }
      const probe = createServer();
      probe.once('error', (cause: NodeJS.ErrnoException) => {
        if (cause.code === 'EADDRINUSE') finish(null);
      });
      probe.listen(localPort, '127.0.0.1', () => {
        probe.close();
      });
    }, 200);
  });
}
