/**
 * Workload limits enforced inside the guest, not claimed from configuration.
 *
 * Instabox exposes no egress-policy API and no per-command cgroup API. The
 * trusted bootstrap installs these limits for the non-sudo workload identity.
 * Provider control (root management exec) stays outside the workload UID.
 */

export const WORKLOAD_USER = 'ranger';
export const WORKLOAD_HOME = '/data/ranger';
export const WORKLOAD_PROJECT = '/data/ranger/project';
export const WORKLOAD_UID = 1100;

/**
 * Guest tools that exist only on root's PATH. Readiness found useradd,
 * runuser and nft under /usr/sbin, not in the default exec PATH.
 */
export const ROOT_PATH = 'export PATH="/usr/sbin:/usr/bin:/sbin:/bin:${PATH}"';

/** Guest cgroup the workload is placed in. Root management stays outside it. */
export const WORKLOAD_CGROUP = '/sys/fs/cgroup/ranger-workload';

export const WORKLOAD_CPU_QUOTA_US = 100_000;
export const WORKLOAD_CPU_PERIOD_US = 100_000;
export const WORKLOAD_MEMORY_BYTES = 256 * 1024 * 1024;
export const WORKLOAD_PIDS_MAX = 32;
export const COMMAND_OUTPUT_CAP_BYTES = 256 * 1024;
export const SOURCE_FILE_CAP_BYTES = 1024 * 1024;
export const VM_KILL_TIMEOUT_MS = 600_000;

/** Fixed guest app ports the private preview may forward. No arbitrary targets. */
export const FIXED_PREVIEW_PORTS = [4173, 3000, 8080] as const;
export type FixedPreviewPort = (typeof FIXED_PREVIEW_PORTS)[number];

export function isFixedPreviewPort(port: number): port is FixedPreviewPort {
  return (FIXED_PREVIEW_PORTS as readonly number[]).includes(port);
}

/**
 * Default-deny egress for the workload UID. Loopback stays open so a fixed
 * guest app can be reached by the private SSH forward. Management UIDs are
 * not covered, so provider control keeps working.
 *
 * nft and runuser live in root's PATH (/usr/sbin). Callers must not assume
 * the default exec PATH includes them.
 */
/**
 * Enter the workload cgroup, then drop to the restricted user with
 * no-new-privileges. The SDK exec API has no user field, so the drop is
 * the fence. The inner command is already shell-quoted.
 *
 * A missing cgroup or a failed drop exits before the payload. Never fall
 * back to the sudo-enabled template user.
 */
export function fencedWorkloadCommand(inner: string): string {
  return [
    ROOT_PATH,
    `test -f ${WORKLOAD_CGROUP}/cgroup.procs`,
    `echo $$ > ${WORKLOAD_CGROUP}/cgroup.procs`,
    `exec runuser --user ${WORKLOAD_USER} --group ${WORKLOAD_USER} -- setpriv --no-new-privs --inh-caps -all --ambient-caps -all --bounding-set -all -- bash -lc ${inner}`,
  ].join('\n');
}

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
