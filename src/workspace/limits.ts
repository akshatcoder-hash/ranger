/**
 * Workload limits enforced inside the guest, not claimed from configuration.
 *
 * Instabox exposes no egress-policy API and no per-command cgroup API. The
 * trusted bootstrap installs these limits for the non-sudo workload identity.
 * Provider control (root management SSH/exec) stays outside the workload UID.
 */

export const WORKLOAD_USER = 'ranger';
export const WORKLOAD_HOME = '/data/ranger';
export const WORKLOAD_PROJECT = '/data/ranger/project';
export const WORKLOAD_UID = 1100;

/** Guest cgroup the workload is placed in. Root management stays outside it. */
export const WORKLOAD_CGROUP = '/sys/fs/cgroup/ranger-workload';

export const WORKLOAD_CPU_QUOTA_US = 100_000;
export const WORKLOAD_CPU_PERIOD_US = 100_000;
export const WORKLOAD_MEMORY_BYTES = 256 * 1024 * 1024;
export const WORKLOAD_PIDS_MAX = 64;
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
 * Shell fragment applied by trusted bootstrap.
 * Default-deny egress for the workload UID, loopback allowed, metadata blocked.
 * Management (uid 0 / uid 1000) is not covered, so provider control keeps working.
 */
export const WORKLOAD_EGRESS_RULES = [
  'nft add table ip ranger',
  'nft add chain ip ranger output { type filter hook output priority 0 \\; policy accept \\; }',
  `nft add rule ip ranger output meta skuid ${WORKLOAD_UID} ip daddr 169.254.169.254 drop`,
  `nft add rule ip ranger output meta skuid ${WORKLOAD_UID} ip daddr 169.254.0.0/16 drop`,
  `nft add rule ip ranger output meta skuid ${WORKLOAD_UID} ip daddr 127.0.0.0/8 accept`,
  `nft add rule ip ranger output meta skuid ${WORKLOAD_UID} drop`,
].join('\n');
