import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Operator-only, per-VM egress exception for the demo workload: DNS to the
 * guest's configured resolvers (udp/tcp 53) and tcp 443 to the public IPv4
 * addresses registry.npmjs.org resolves to right now. Nothing else changes.
 *
 * Rules live in a dedicated chain, reached by one jump placed after the
 * bootstrap's metadata/link-local drops and before its final UID drop, so
 * those drops keep precedence and everything else stays default-deny. The
 * chain is rebuilt atomically on every run (idempotent). Re-bootstrapping the
 * VM recreates the table and removes the exception. Only the one workspace
 * VM of the named project is touched; nothing is written to the repo, ledger
 * or workspace store, and no secret is printed.
 */

export const REGISTRY_HOST = 'registry.npmjs.org';
export const CHAIN = 'ranger_demo_egress';
export const WORKLOAD_UID = 1100;
export const MAX_RESOLVERS = 3;
export const MAX_REGISTRY_IPS = 32;

const RESOLV_MARK = '---RANGER-RESOLV---';
const HOSTS_MARK = '---RANGER-HOSTS---';
const ROOT_PATH = 'export PATH="/usr/sbin:/usr/bin:/sbin:/bin:${PATH}"';

function octets(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (m === null) return null;
  const parts = m.slice(1).map((part) => (part.length > 1 && part.startsWith('0') ? NaN : Number(part)));
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

function inCidr([a, b, c], [ra, rb, rc, bits]) {
  const value = ((a << 16) | (b << 8) | c) >>> 0;
  const base = ((ra << 16) | (rb << 8) | rc) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffff << (24 - bits)) & 0xffffff;
  return (value & mask) === (base & mask);
}

const NEVER = [[0, 0, 0, 8], [169, 254, 0, 16]];
const NOT_PUBLIC = [
  [10, 0, 0, 8], [100, 64, 0, 10], [127, 0, 0, 8], [172, 16, 0, 12], [192, 0, 0, 24], [192, 0, 2, 24],
  [192, 88, 99, 24], [192, 168, 0, 16], [198, 18, 0, 15], [198, 51, 100, 24], [203, 0, 113, 24],
];

const matchesAny = (o, ranges) => ranges.some((r) => inCidr(o, r));

/** Non-loopback IPv4 nameservers. Loopback stubs are already allowed; IPv6 is ignored. */
export function parseResolvers(resolvConf) {
  const found = [];
  for (const line of resolvConf.split('\n')) {
    const m = /^\s*nameserver\s+(\S+)\s*$/.exec(line);
    if (m === null || m[1].includes(':')) continue;
    const o = octets(m[1]);
    if (o === null) throw new Error('invalid resolver address in resolv.conf');
    if (o[0] === 127) continue;
    if (o[0] >= 224 || matchesAny(o, NEVER)) throw new Error(`refusing resolver ${m[1]}`);
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found.slice(0, MAX_RESOLVERS);
}

/** Public IPv4 addresses from `getent ahostsv4` output. Any non-public answer aborts. */
export function parseRegistryIps(hostsOutput) {
  const found = new Set();
  for (const line of hostsOutput.split('\n')) {
    const token = line.trim().split(/\s+/)[0];
    if (token === undefined || token === '') continue;
    const o = octets(token);
    if (o === null) throw new Error('invalid registry address from resolver');
    if (o[0] >= 224 || matchesAny(o, NEVER) || matchesAny(o, NOT_PUBLIC)) {
      throw new Error(`refusing non-public registry address ${token}`);
    }
    found.add(token);
  }
  if (found.size === 0) throw new Error(`${REGISTRY_HOST} did not resolve to any IPv4 address`);
  if (found.size > MAX_REGISTRY_IPS) throw new Error(`${REGISTRY_HOST} resolved to more than ${MAX_REGISTRY_IPS} addresses`);
  return [...found].sort();
}

export function probeScript() {
  return [
    'set -eu',
    ROOT_PATH,
    `echo '${RESOLV_MARK}'`,
    'cat /etc/resolv.conf',
    `echo '${HOSTS_MARK}'`,
    `getent ahostsv4 ${REGISTRY_HOST}`,
  ].join('\n');
}

export function parseProbe(stdout) {
  const r = stdout.indexOf(RESOLV_MARK);
  const h = stdout.indexOf(HOSTS_MARK);
  if (r < 0 || h < r) throw new Error('unexpected probe output');
  return {
    resolvers: parseResolvers(stdout.slice(r + RESOLV_MARK.length, h)),
    registryIps: parseRegistryIps(stdout.slice(h + HOSTS_MARK.length)),
  };
}

/** Root script that installs the exception. Inputs must come from parseProbe. */
export function applyScript({ resolvers, registryIps }) {
  const uid = `meta skuid ${WORKLOAD_UID}`;
  const rules = [
    ...(resolvers.length === 0
      ? []
      : ['udp', 'tcp'].map((p) => `add rule inet ranger ${CHAIN} ${uid} ip daddr { ${resolvers.join(', ')} } ${p} dport 53 accept`)),
    `add rule inet ranger ${CHAIN} ${uid} ip daddr { ${registryIps.join(', ')} } tcp dport 443 accept`,
  ];
  const listing = 'nft -n list chain inet ranger output';
  return [
    'set -eu',
    ROOT_PATH,
    `${listing} >/dev/null`,
    'nft -f - <<\'RANGER_NFT\'',
    `add chain inet ranger ${CHAIN}`,
    `flush chain inet ranger ${CHAIN}`,
    ...rules,
    'RANGER_NFT',
    `final=$(nft -n -a list chain inet ranger output | sed -n 's/^[[:space:]]*${uid} drop # handle \\([0-9][0-9]*\\)$/\\1/p')`,
    'test "$(printf \'%s\\n\' "$final" | grep -c .)" = 1',
    `${listing} | grep -q 'jump ${CHAIN}' || nft insert rule inet ranger output position "$final" ${uid} jump ${CHAIN}`,
    `test "$(${listing} | grep -c 'jump ${CHAIN}')" = 1`,
    `${listing} | awk '/jump ${CHAIN}/{j=NR} /^[ \\t]*${uid} drop$/{d=NR} END{exit !(j && d && j<d)}'`,
    `nft list chain inet ranger ${CHAIN}`,
  ].join('\n');
}

export function removeScript() {
  return [
    'set -eu',
    ROOT_PATH,
    `h=$(nft -n -a list chain inet ranger output | sed -n 's/.*jump ${CHAIN} # handle \\([0-9][0-9]*\\)$/\\1/p')`,
    '[ -z "$h" ] || nft delete rule inet ranger output handle "$h"',
    `nft delete chain inet ranger ${CHAIN} 2>/dev/null || true`,
    'nft list chain inet ranger output',
  ].join('\n');
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const asRoot = (script) => `sudo --non-interactive /bin/bash -lc ${shellQuote(script)}`;

/**
 * deps.workspace(projectId) -> { machineId, observedState, uncertain, destroyedAt } | null
 * deps.exec(machineId, command) -> { stdout, stderr, exitCode, timedOut, truncated }
 */
export async function run({ projectId, mode }, deps) {
  if (!/^prj_[0-9a-f-]{36}$/.test(projectId ?? '')) throw new Error('--project must be a project id');
  const ws = deps.workspace(projectId);
  if (ws === null || ws.machineId === null || ws.observedState !== 'running' || ws.uncertain || ws.destroyedAt !== null) {
    throw new Error('project has no ready workspace');
  }
  const exec = async (script) => {
    const r = await deps.exec(ws.machineId, asRoot(script));
    if (r.exitCode !== 0 || r.timedOut || r.truncated) {
      throw new Error(`guest command failed exitCode=${r.exitCode}: ${`${r.stderr}`.slice(0, 300)}`);
    }
    return r.stdout;
  };
  if (mode === 'remove') return { mode, machineId: ws.machineId, nft: await exec(removeScript()) };
  const plan = parseProbe(await exec(probeScript()));
  const script = applyScript(plan);
  if (mode !== 'apply') return { mode: 'dry-run', machineId: ws.machineId, ...plan, script };
  return { mode, machineId: ws.machineId, ...plan, nft: await exec(script) };
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--project');
  const mode = args.includes('--remove') ? 'remove' : args.includes('--apply') ? 'apply' : 'dry-run';
  const root = process.env.RANGER_APP_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const load = (rel) => import(pathToFileURL(path.join(root, 'dist/src', rel)).href);
  const [{ loadConfig }, { SecretResolver }, { openDatabase }, store, { SdkInstaboxProvider }] = await Promise.all([
    load('config.js'), load('secrets.js'), load('db/db.js'), load('workspace/store.js'), load('workspace/sdk-provider.js'),
  ]);
  const config = await loadConfig(process.env);
  const db = openDatabase(config.dataDir);
  const provider = new SdkInstaboxProvider(SecretResolver.fromConfig(config, process.env).get('INSTABOX_API_KEY'));
  try {
    const result = await run(
      { projectId: at >= 0 ? args[at + 1] : undefined, mode },
      {
        workspace: (id) => store.getWorkspace(db, id),
        exec: (machineId, command) => provider.exec({ machineId, command, timeoutMs: 30_000 }),
      },
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`demo-registry-egress: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exit(1);
  });
}
