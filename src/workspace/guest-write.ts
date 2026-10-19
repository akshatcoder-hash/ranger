import { createHash } from 'node:crypto';
import { WORKLOAD_PROJECT, GUEST_TRANSPORT_CAP_BYTES, fencedWorkloadCommand, scanQuotedToken } from './limits.js';
import type { ProviderCommandResult } from './provider.js';

/** Environment field carrying the project-relative write target. */
export const WRITE_PATH_ENV = 'RANGER_WRITE_PATH';

/**
 * Guest-side safe write, executed only after the workload privilege drop.
 * Input is length-framed: an exec transport may keep stdin open, so waiting
 * for EOF would hang after all bytes arrived. Validate length and digest
 * before touching the destination, then atomically replace and read it back.
 * Directory traversal and both read/write opens refuse symlinks. Only fixed
 * failure markers or errno values leave the guest; file bytes never do.
 */
const GUEST_WRITE_PY = [
  'import os,sys,base64,binascii,hashlib,stat,uuid',
  "def refuse(stage):",
  "    sys.stderr.write('guest-write-refused stage=%s\\n' % stage); sys.exit(3)",
  "rel=os.environ.get('RANGER_WRITE_PATH','')",
  "parts=[p for p in rel.split('/') if p not in ('','.')]",
  "if rel.startswith('/') or not parts or '..' in parts or '\\x00' in rel:",
  "    refuse('path')",
  "try:",
  "    size=int(os.environ.get('RANGER_WRITE_SIZE','-1'))",
  "except ValueError:",
  "    refuse('size')",
  `if not 0 <= size <= ${GUEST_TRANSPORT_CAP_BYTES}:`,
  "    refuse('size')",
  "expected=os.environ.get('RANGER_WRITE_SHA256','')",
  "encoded_size=((size+2)//3)*4",
  "encoded=sys.stdin.buffer.read(encoded_size)",
  "if len(encoded) != encoded_size:",
  "    refuse('input_length')",
  "try:",
  "    data=base64.b64decode(encoded,validate=True)",
  "except binascii.Error:",
  "    refuse('input_encoding')",
  "if len(data) != size or hashlib.sha256(data).hexdigest() != expected:",
  "    refuse('input_digest')",
  'fd=None; temp=None',
  'try:',
  "    fd=os.open('.',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)",
  '    for comp in parts[:-1]:',
  '        try:',
  '            os.mkdir(comp,0o750,dir_fd=fd)',
  '        except FileExistsError:',
  '            pass',
  '        nxt=os.open(comp,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)',
  '        os.close(fd); fd=nxt',
  '    try:',
  '        existing=os.stat(parts[-1],dir_fd=fd,follow_symlinks=False)',
  '    except FileNotFoundError:',
  '        existing=None',
  '    if existing is not None and not stat.S_ISREG(existing.st_mode):',
  "        refuse('target_type')",
  "    temp='.ranger-write-'+uuid.uuid4().hex",
  '    out=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)',
  '    try:',
  '        remaining=memoryview(data)',
  '        while remaining:',
  '            n=os.write(out,remaining)',
  '            if n <= 0:',
  "                refuse('write')",
  '            remaining=remaining[n:]',
  '        if existing is not None:',
  '            os.fchmod(out,stat.S_IMODE(existing.st_mode) & 0o777)',
  '        os.fsync(out)',
  '    finally:',
  '        os.close(out)',
  '    os.replace(temp,parts[-1],src_dir_fd=fd,dst_dir_fd=fd)',
  '    temp=None',
  '    check=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)',
  '    try:',
  '        info=os.fstat(check)',
  '        if not stat.S_ISREG(info.st_mode) or info.st_size != size:',
  "            refuse('readback_size')",
  '        digest=hashlib.sha256(); read_size=0',
  '        while read_size <= size:',
  '            chunk=os.read(check,min(65536,size+1-read_size))',
  '            if not chunk:',
  '                break',
  '            digest.update(chunk); read_size+=len(chunk)',
  '        if read_size != size or digest.hexdigest() != expected:',
  "            refuse('readback_digest')",
  '    finally:',
  '        os.close(check)',
  "    print('guest-write-ok bytes=%d sha256=%s' % (size,digest.hexdigest()))",
  'except OSError as e:',
  "    sys.stderr.write('guest-write-refused errno=%d\\n' % e.errno)",
  '    sys.exit(4)',
  'finally:',
  '    if fd is not None:',
  '        if temp is not None:',
  '            try:',
  '                os.unlink(temp,dir_fd=fd)',
  '            except OSError:',
  '                pass',
  '        os.close(fd)',
].join('\n');

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function digest(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Expected receipt, emitted only after the guest reopened and hashed the file. */
export function guestWriteReceipt(content: Uint8Array): string {
  return `guest-write-ok bytes=${content.byteLength} sha256=${digest(content)}`;
}

/** A quiet exit, a partial response or a stale receipt never proves a write. */
export function guestWriteVerified(result: ProviderCommandResult, content: Uint8Array): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.truncated
    && result.stdout.trim() === guestWriteReceipt(content);
}

/**
 * Path and framing metadata ride the post-drop payload, independent of sudo
 * env_reset. Only the base64 bytes ride stdin; no source bytes enter argv.
 * The fence chdirs after dropping privileges, never at provider level.
 */
export function guestWriteCommand(relativePath: string, content: Uint8Array): string {
  const assignment = `${WRITE_PATH_ENV}=${shellQuote(relativePath)} RANGER_WRITE_SIZE=${shellQuote(String(content.byteLength))} RANGER_WRITE_SHA256=${shellQuote(digest(content))}`;
  return fencedWorkloadCommand(`${assignment} python3 -c ${shellQuote(GUEST_WRITE_PY)}`);
}

/** Extract the embedded target, exactly as the post-drop shell parses it. */
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
