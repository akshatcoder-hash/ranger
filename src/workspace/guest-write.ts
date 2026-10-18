import { WORKLOAD_PROJECT, fencedWorkloadCommand, scanQuotedToken } from './limits.js';

/** Environment field carrying the project-relative write target. */
export const WRITE_PATH_ENV = 'RANGER_WRITE_PATH';

/**
 * Guest-side safe write. Runs as the workload identity inside the fence and
 * reads the target path from the environment and the payload bytes from
 * stdin (base64). Every path component is opened with O_NOFOLLOW through a
 * dir_fd chain, so a workload-planted symlink can never redirect the write
 * outside the project: a symlinked directory or file fails with ELOOP
 * instead of being followed.
 *
 * stderr stays secret-safe by construction: refusals report only an errno.
 */
const GUEST_WRITE_PY = [
  "import os,sys,base64",
  "rel=os.environ.get('RANGER_WRITE_PATH','')",
  "parts=[p for p in rel.split('/') if p not in ('','.')]",
  "if not parts or '..' in parts:",
  "    sys.stderr.write('guest-write-refused errno=0\\n'); sys.exit(3)",
  "try:",
  "    fd=os.open('.',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)",
  "    for comp in parts[:-1]:",
  "        try:",
  "            nxt=os.open(comp,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)",
  "        except FileNotFoundError:",
  "            os.mkdir(comp,0o750,dir_fd=fd)",
  "            nxt=os.open(comp,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)",
  "        os.close(fd); fd=nxt",
  "    data=base64.b64decode(sys.stdin.buffer.read())",
  "    out=os.open(parts[-1],os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600,dir_fd=fd)",
  "    try:",
  "        while data:",
  "            n=os.write(out,data)",
  "            data=data[n:]",
  "    finally:",
  "        os.close(out)",
  "except OSError as e:",
  "    sys.stderr.write('guest-write-refused errno=%d\\n' % e.errno)",
  "    sys.exit(4)",
].join('\n');

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The full fenced command for one project write. The target rides the
 * post-drop payload as a command-prefix assignment, so the post-drop shell
 * itself parses it and nothing depends on sudo preserving the caller's
 * environment (sudo env_reset strips ambient variables). The base64 payload
 * is delivered on stdin. No cwd is set at the provider level: the fence
 * chdirs after the privilege drop.
 */
export function guestWriteCommand(relativePath: string): string {
  const assignment = `${WRITE_PATH_ENV}=${shellQuote(relativePath)}`;
  return fencedWorkloadCommand(`${assignment} python3 -c ${shellQuote(GUEST_WRITE_PY)}`);
}

/**
 * Extract the embedded write target from a fenced payload. Used by the fake
 * provider to model the wire exactly as the post-drop shell would parse it.
 */
export function parseWriteTargetFromPayload(payload: string): string | null {
  const marker = `${WRITE_PATH_ENV}='`;
  const start = payload.indexOf(marker);
  if (start === -1) return null;
  const token = scanQuotedToken(payload, start + WRITE_PATH_ENV.length + 1);
  if (token === null || payload[token.end] !== ' ') return null;
  return token.value;
}

/** Command string written relative to the project root, for diagnostics. */
export function guestWriteTargetDir(): string {
  return WORKLOAD_PROJECT;
}
