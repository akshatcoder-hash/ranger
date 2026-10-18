/**
 * Workload limits enforced inside the guest, not claimed from configuration.
 *
 * Instabox exposes no egress-policy API and no per-command cgroup API. The
 * trusted bootstrap installs these limits for the non-sudo workload identity.
 * Provider control (root management exec) stays outside the workload UID.
 */

import { MAX_STDIN_BYTES } from '@insforge/instabox-sdk';

export const WORKLOAD_USER = 'ranger';
export const WORKLOAD_HOME = '/data/ranger';
export const WORKLOAD_PROJECT = '/data/ranger/project';
export const WORKLOAD_UID = 1100;

/**
 * Guest tools that exist only on root's PATH. Readiness found useradd, nft
 * and runuser under /usr/sbin, not in the default exec PATH. Used by the
 * trusted bootstrap only; workload commands pin their own PATH below.
 */
export const ROOT_PATH = 'export PATH="/usr/sbin:/usr/bin:/sbin:/bin:${PATH}"';

/**
 * Pinned PATH for the workload fence. Unlike ROOT_PATH it never appends the
 * caller's PATH: the elevated prefix must not inherit anything ambient.
 */
export const PINNED_ROOT_PATH = 'export PATH="/usr/sbin:/usr/bin:/sbin:/bin"';

/** Guest cgroup the workload is placed in. Root management stays outside it. */
export const WORKLOAD_CGROUP = '/sys/fs/cgroup/ranger-workload';

export const WORKLOAD_CPU_QUOTA_US = 100_000;
export const WORKLOAD_CPU_PERIOD_US = 100_000;
export const WORKLOAD_MEMORY_BYTES = 256 * 1024 * 1024;
export const WORKLOAD_PIDS_MAX = 32;
export const COMMAND_OUTPUT_CAP_BYTES = 256 * 1024;
export const VM_KILL_TIMEOUT_MS = 600_000;

/**
 * Largest raw file payload Ranger transports to the guest. File writes ride
 * command stdin base64-encoded, which grows the text by exactly 4/3, and the
 * SDK accepts at most MAX_STDIN_BYTES UTF-8 bytes of stdin (it rejects longer
 * input before the HTTP call). The safe raw cap is therefore derived from the
 * SDK constant: floor(MAX_STDIN_BYTES / 4) * 3. This is the effective file
 * size limit — there is no advertised 1 MiB file requirement and no chunking;
 * larger writes are refused with file_too_large before any exec.
 */
export const GUEST_TRANSPORT_CAP_BYTES = Math.floor(MAX_STDIN_BYTES / 4) * 3;

/**
 * Durable SQLite storage cap for saved source rows. The transport cap above
 * is smaller and is the binding limit for every public or workspace write.
 */
export const SOURCE_FILE_CAP_BYTES = 1024 * 1024;

/** Fixed guest app ports the private preview may forward. No arbitrary targets. */
export const FIXED_PREVIEW_PORTS = [4173, 3000, 8080] as const;
export type FixedPreviewPort = (typeof FIXED_PREVIEW_PORTS)[number];

export function isFixedPreviewPort(port: number): port is FixedPreviewPort {
  return (FIXED_PREVIEW_PORTS as readonly number[]).includes(port);
}

/**
 * Fixed failure-stage markers for the trusted launcher's own checks/setup.
 * They are static text: no payload, path argument, environment or secret
 * bytes can ever enter them. A launcher stage failure reaches the sanitized
 * write/command detail through stderr, so a silent non-zero exit no longer
 * hides which stage broke.
 */
export const LAUNCHER_STAGE_CGROUP_MISSING = 'ranger-launcher-failed stage=cgroup_missing';
export const LAUNCHER_STAGE_CGROUP_ENTER = 'ranger-launcher-failed stage=cgroup_enter';

/**
 * The fixed server-generated script that `sudo -n` runs for every workload
 * command. It contains no customer-controlled bytes: the untrusted payload
 * reaches it only as the $1 argument, executed after the drop.
 *
 * As root it fails closed on any setup error (`set -eu`), verifies and
 * enters the workload cgroup (the restricted identity itself cannot write
 * cgroup.procs), then irrevocably drops uid, gid, supplementary groups and
 * all capabilities with no-new-privileges in a single setpriv exec. Doing
 * the whole drop as root is required: an unprivileged runuser-then-setpriv
 * chain could not change the caps it had already lost. Each guarded stage
 * emits a fixed marker on stderr before its distinct fixed exit code, so a
 * failed check is diagnosable instead of a silent non-zero exit.
 */
export const TRUSTED_LAUNCHER = [
  'set -eu',
  PINNED_ROOT_PATH,
  `test -f ${WORKLOAD_CGROUP}/cgroup.procs || { echo '${LAUNCHER_STAGE_CGROUP_MISSING}' >&2; exit 10; }`,
  `echo $$ > ${WORKLOAD_CGROUP}/cgroup.procs || { echo '${LAUNCHER_STAGE_CGROUP_ENTER}' >&2; exit 11; }`,
  `exec setpriv --reuid ${WORKLOAD_UID} --regid ${WORKLOAD_UID} --init-groups --no-new-privs --inh-caps -all --ambient-caps -all --bounding-set -all -- /usr/bin/env -i HOME=${WORKLOAD_HOME} USER=${WORKLOAD_USER} LOGNAME=${WORKLOAD_USER} /bin/bash -lc "$1"`,
].join('\n');

/** argv0 label for the trusted launcher invocation. */
export const LAUNCHER_ARGV0 = 'ranger-trusted-launcher';

/**
 * Fence for every workload command and guest write.
 *
 * The SDK exec API has no user field: its guest agent starts every command
 * as the template user (sudo/docker-enabled, uid 1000) and applies `cwd`
 * before the command runs. The project is owned by the workload identity,
 * so a provider-level cwd is denied before any shell starts. Instead the
 * fence elevates exactly the fixed trusted launcher with non-interactive
 * sudo, moves its own process into the workload cgroup, drops to the
 * restricted identity, and only then chdirs into the project and runs the
 * untrusted payload. stdin flows through unchanged for payloads that need
 * it; the caller's environment is not inherited (`env -i` plus the explicit
 * workload identity). Nothing after the drop can re-elevate: the workload
 * never gains sudo or docker.
 */
export function fencedWorkloadCommand(inner: string): string {
  const payload = `cd -- ${shellQuote(WORKLOAD_PROJECT)} && ${inner}`;
  return [
    PINNED_ROOT_PATH,
    `exec sudo -n /bin/bash -c ${shellQuote(TRUSTED_LAUNCHER)} ${LAUNCHER_ARGV0} ${shellQuote(payload)}`,
  ].join('\n');
}

interface QuotedToken {
  value: string;
  end: number;
}

/** Scan one single-quoted shell token as produced by shellQuote. */
export function scanQuotedToken(text: string, from: number): QuotedToken | null {
  if (text[from] !== "'") return null;
  let value = '';
  let i = from + 1;
  while (i < text.length) {
    if (text.startsWith(`'\\''`, i)) {
      value += "'";
      i += 4;
      continue;
    }
    const ch = text[i]!;
    if (ch === "'") return { value, end: i + 1 };
    value += ch;
    i += 1;
  }
  return null;
}

/**
 * Split a fenced command into its fixed elevated script and the post-drop
 * payload. Returns null for anything that is not a fenced workload command.
 * The fake provider and the deterministic tests use this to model the real
 * wire exactly.
 */
export function splitFencedCommand(command: string): { trusted: string; payload: string } | null {
  const marker = 'exec sudo -n /bin/bash -c ';
  const start = command.indexOf(marker);
  if (start === -1) return null;
  const trusted = scanQuotedToken(command, start + marker.length);
  if (trusted === null) return null;
  const name = command.slice(trusted.end).match(`^ ${LAUNCHER_ARGV0} `);
  if (name === null) return null;
  const payloadFrom = trusted.end + name[0].length;
  const payload = scanQuotedToken(command, payloadFrom);
  if (payload === null || payload.end !== command.length) return null;
  return { trusted: trusted.value, payload: payload.value };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Default-deny egress for the workload UID. Loopback stays open so a fixed
 * guest app can be reached by the private SSH forward. Management UIDs are
 * not covered, so provider control keeps working. Runs during the trusted
 * bootstrap as root (nft lives in /usr/sbin).
 */
export const WORKLOAD_EGRESS_RULES = [
  ROOT_PATH,
  'nft delete table inet ranger >/dev/null 2>&1 || true',
  'nft add table inet ranger',
  'nft add chain inet ranger output \'{ type filter hook output priority 0; policy accept; }\'',
  `nft add rule inet ranger output meta skuid ${WORKLOAD_UID} ip daddr 169.254.169.254 drop`,
  `nft add rule inet ranger output meta skuid ${WORKLOAD_UID} ip6 daddr fe80::/10 drop`,
  `nft add rule inet ranger output meta skuid ${WORKLOAD_UID} ip daddr 169.254.0.0/16 drop`,
  `nft add rule inet ranger output meta skuid ${WORKLOAD_UID} ip daddr 127.0.0.0/8 accept`,
  `nft add rule inet ranger output meta skuid ${WORKLOAD_UID} ip6 daddr ::1 accept`,
  `nft add rule inet ranger output meta skuid ${WORKLOAD_UID} drop`,
].join('\n');
