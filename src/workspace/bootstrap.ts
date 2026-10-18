import {
  ROOT_PATH,
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Trusted bootstrap. Runs as the provider management user, then the workload
 * must not be that user. No provider keys are written into the guest.
 *
 * The guest template user is sudo- and docker-enabled. This script creates a
 * separate identity, drops it from those groups, and fences CPU, memory,
 * PIDs and egress to that UID. Commands later enter the fence with
 * no-new-privileges.
 */
/**
 * Trusted bootstrap. Fails closed: a missing cgroup controller or a failed
 * user/nft setup exits non-zero, and the caller does not mark the workspace
 * usable. No provider keys are written into the guest.
 */
export function bootstrapScript(): string {
  return [
    'set -eu',
    ROOT_PATH,
    'command -v useradd >/dev/null',
    'command -v sudo >/dev/null',
    'command -v nft >/dev/null',
    'command -v setpriv >/dev/null',
    'test -f /sys/fs/cgroup/cgroup.controllers',
    'grep -q memory /sys/fs/cgroup/cgroup.controllers',
    'grep -q pids /sys/fs/cgroup/cgroup.controllers',
    `id ${WORKLOAD_USER} >/dev/null 2>&1 || useradd --uid ${WORKLOAD_UID} --create-home --home-dir ${WORKLOAD_HOME} --shell /bin/bash --user-group ${WORKLOAD_USER}`,
    `gpasswd -d ${WORKLOAD_USER} sudo >/dev/null 2>&1 || true`,
    `gpasswd -d ${WORKLOAD_USER} docker >/dev/null 2>&1 || true`,
    `install -d -o ${WORKLOAD_USER} -g ${WORKLOAD_USER} -m 0750 ${WORKLOAD_PROJECT}`,
    'install -d -o root -g root -m 0755 /etc/ranger',
    `printf '%s\\n' '${WORKLOAD_USER}' > /etc/ranger/workload-user`,
    'chmod 0644 /etc/ranger/workload-user',
    'printf \'provider-control-only\\n\' > /etc/ranger/provider-marker',
    'chmod 0600 /etc/ranger/provider-marker',
    'printf \'%s\\n\' \'+cpu +memory +pids\' > /sys/fs/cgroup/cgroup.subtree_control',
    `mkdir -p ${WORKLOAD_CGROUP}`,
    `printf '%s %s\\n' '${WORKLOAD_CPU_QUOTA_US}' '${WORKLOAD_CPU_PERIOD_US}' > ${WORKLOAD_CGROUP}/cpu.max`,
    `printf '%s\\n' '${WORKLOAD_MEMORY_BYTES}' > ${WORKLOAD_CGROUP}/memory.max`,
    `printf '%s\\n' '0' > ${WORKLOAD_CGROUP}/memory.swap.max`,
    `printf '%s\\n' '${WORKLOAD_PIDS_MAX}' > ${WORKLOAD_CGROUP}/pids.max`,
    'echo 1 > /sys/fs/cgroup/cgroup.procs',
    WORKLOAD_EGRESS_RULES,
    'nft list table inet ranger >/dev/null',
    `test "$(id -u ${WORKLOAD_USER})" = "${WORKLOAD_UID}"`,
    `printf '%s\\n' 'bootstrap-complete' > ${WORKLOAD_HOME}/bootstrap-complete`,
    `chown ${WORKLOAD_USER}:${WORKLOAD_USER} ${WORKLOAD_HOME}/bootstrap-complete`,
  ].join('\n');
}

export async function bootstrapWorkload(provider: InstaboxProvider, machineId: string): Promise<{ uid: number }> {
  const script = bootstrapScript();
  const result = await provider.exec({
    machineId,
    command: `sudo --non-interactive /bin/bash -lc ${shellQuote(script)}`,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.replace(/[A-Za-z0-9_\-]{24,}/g, '[redacted]').slice(0, 500);
    throw new Error(`workload bootstrap failed: ${detail}`);
  }
  return { uid: WORKLOAD_UID };
}

/**
 * Probe the live suite runs as the workload identity.
 * Markers are stable tokens. Output must not include secret values.
 */
export function isolationProbeScript(): string {
  return [
    'set +e',
    'echo UID=$(id -u)',
    'echo USER=$(id -un)',
    'echo GROUPS=$(id -Gn | tr " " ",")',
    'echo NNP=$(awk "/NoNewPrivs/ {print \\$2}" /proc/self/status)',
    'echo CGROUP=$(cat /proc/self/cgroup)',
    'echo MEMMAX=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo missing)',
    'echo PIDSMAX=$(cat /sys/fs/cgroup/pids.max 2>/dev/null || echo missing)',
    'echo CPUMAX=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo missing)',
    'sudo -n true >/dev/null 2>&1; echo SUDO=$?',
    'docker info >/dev/null 2>&1; echo DOCKER=$?',
    'test -S /var/run/docker.sock; echo DOCKER_SOCK=$?',
    'id -nG | tr " " "\\n" | grep -qx sudo; echo SUDO_GROUP=$?',
    'id -nG | tr " " "\\n" | grep -qx docker; echo DOCKER_GROUP=$?',
    'python3 - <<\'PY\'',
    'import os',
    'keys = [k for k in os.environ if "KEY" in k or "TOKEN" in k or "SECRET" in k or k.startswith("INSTABOX") or k.startswith("XAI")]',
    'print("SECRET_KEYS=" + str(len(keys)))',
    'PY',
    'cat /etc/ranger/provider-marker >/dev/null 2>&1; echo PROVIDER_FILE=$?',
    'curl -m 3 -sS -o /dev/null -w "META=%{http_code}\\n" http://169.254.169.254/latest/meta-data/ || echo META=000',
    'curl -m 3 -sS -o /dev/null -w "EGRESS=%{http_code}\\n" https://example.com/ || echo EGRESS=000',
    'curl -m 3 -sS -o /dev/null -w "LOOP=%{http_code}\\n" http://127.0.0.1:1/ || echo LOOP=000',
  ].join('\n');
}

/** Memory probe. A real cgroup kill exits 137. A quiet success is not enforcement. */
export function memoryPressureScript(): string {
  return [
    'python3 - <<\'PY\'',
    'chunks = []',
    'try:',
    '    while True:',
    '        chunks.append(bytearray(8 * 1024 * 1024))',
    'except MemoryError:',
    '    print("MEM=MemoryError")',
    '    raise SystemExit(0)',
    'PY',
  ].join('\n');
}

/** Fork until the PID ceiling refuses another child. */
export function pidCeilingScript(): string {
  return [
    'python3 - <<\'PY\'',
    'import os, sys',
    'live = []',
    'refused = 0',
    'for _ in range(80):',
    '    try:',
    '        pid = os.fork()',
    '    except OSError:',
    '        refused += 1',
    '        break',
    '    if pid == 0:',
    '        os.execv("/bin/sleep", ["sleep", "30"])',
    '    live.append(pid)',
    'print("PIDS=%d REFUSED=%d" % (len(live), refused))',
    'for pid in live:',
    '    try:',
    '        os.kill(pid, 9)',
    '        os.waitpid(pid, 0)',
    '    except OSError:',
    '        pass',
    'sys.exit(0 if refused else 1)',
    'PY',
  ].join('\n');
}
