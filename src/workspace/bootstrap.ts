import {
  WORKLOAD_CGROUP,
  WORKLOAD_CPU_PERIOD_US,
  WORKLOAD_CPU_QUOTA_US,
  WORKLOAD_EGRESS_RULES,
  WORKLOAD_HOME,
  WORKLOAD_MEMORY_BYTES,
  WORKLOAD_PIDS_MAX,
  WORKLOAD_PROJECT,
  WORKLOAD_UID,
  WORKLOAD_USER,
} from './limits.js';
import type { InstaboxProvider } from './provider.js';

/**
 * Trusted bootstrap. Runs as the provider management user, then the workload
 * must not be that user. No provider keys are written into the guest.
 */
export function bootstrapScript(): string {
  return [
    'set -eu',
    `id ${WORKLOAD_USER} >/dev/null 2>&1 || useradd --uid ${WORKLOAD_UID} --create-home --home-dir ${WORKLOAD_HOME} --shell /bin/bash ${WORKLOAD_USER}`,
    `usermod -aG ${WORKLOAD_USER} ${WORKLOAD_USER}`,
    `gpasswd -d ${WORKLOAD_USER} sudo >/dev/null 2>&1 || true`,
    `gpasswd -d ${WORKLOAD_USER} docker >/dev/null 2>&1 || true`,
    `install -d -o ${WORKLOAD_USER} -g ${WORKLOAD_USER} -m 0750 ${WORKLOAD_PROJECT}`,
    'mkdir -p /etc/ranger',
    `printf '%s\\n' '${WORKLOAD_USER}' > /etc/ranger/workload-user`,
    'mkdir -p /sys/fs/cgroup/ranger-workload || true',
    `if [ -f ${WORKLOAD_CGROUP}/cgroup.controllers ] || [ -d ${WORKLOAD_CGROUP} ]; then`,
    `  echo '+cpu +memory +pids' > /sys/fs/cgroup/cgroup.subtree_control || true`,
    `  mkdir -p ${WORKLOAD_CGROUP}`,
    `  echo '${WORKLOAD_CPU_QUOTA_US} ${WORKLOAD_CPU_PERIOD_US}' > ${WORKLOAD_CGROUP}/cpu.max || true`,
    `  echo ${WORKLOAD_MEMORY_BYTES} > ${WORKLOAD_CGROUP}/memory.max || true`,
    `  echo ${WORKLOAD_MEMORY_BYTES} > ${WORKLOAD_CGROUP}/memory.swap.max || true`,
    `  echo ${WORKLOAD_PIDS_MAX} > ${WORKLOAD_CGROUP}/pids.max || true`,
    'fi',
    WORKLOAD_EGRESS_RULES,
    `printf '%s\\n' 'bootstrap-complete' > ${WORKLOAD_HOME}/bootstrap-complete`,
    `chown ${WORKLOAD_USER}:${WORKLOAD_USER} ${WORKLOAD_HOME}/bootstrap-complete`,
  ].join('\n');
}

export async function bootstrapWorkload(provider: InstaboxProvider, machineId: string): Promise<{ uid: number }> {
  const script = bootstrapScript();
  const result = await provider.exec({
    machineId,
    command: script,
    timeoutMs: 60_000,
    user: 'root',
  });
  if (result.exitCode !== 0) {
    throw new Error('workload bootstrap failed');
  }
  return { uid: WORKLOAD_UID };
}

/** Probe script the live suite runs as the workload identity. */
export function isolationProbeScript(): string {
  return [
    'set +e',
    'echo UID=$(id -u)',
    'echo USER=$(id -un)',
    'echo GROUPS=$(id -Gn)',
    'sudo -n true; echo SUDO=$?',
    'docker info >/dev/null 2>&1; echo DOCKER=$?',
    'test -S /var/run/docker.sock; echo DOCKER_SOCK=$?',
    'python3 - <<\'PY\'',
    'import os',
    'keys = [k for k in os.environ if "KEY" in k or "TOKEN" in k or "SECRET" in k or k.startswith("INSTABOX") or k.startswith("XAI")]',
    'print("SECRET_KEYS=" + str(len(keys)))',
    'PY',
    'curl -m 2 -sS -o /dev/null http://169.254.169.254/latest/meta-data/ && echo META=0 || echo META=1',
    'curl -m 2 -sS -o /dev/null https://example.com && echo EGRESS=0 || echo EGRESS=1',
  ].join('\n');
}
