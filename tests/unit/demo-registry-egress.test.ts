import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  applyScript, parseProbe, parseRegistryIps, parseResolvers, removeScript, run, type Deps,
} from '../../scripts/demo-registry-egress.mjs';

const PROJECT = 'prj_6f5b65e6-e85d-4380-9b52-67c7a12fde4c';
const probe = (resolv: string, hosts: string): string =>
  `---RANGER-RESOLV---\n${resolv}\n---RANGER-HOSTS---\n${hosts}\n`;

describe('demo-registry-egress parsing', () => {
  it('keeps non-loopback IPv4 resolvers, skips loopback and IPv6, caps at three', () => {
    const conf = 'nameserver 127.0.0.53\nnameserver ::1\nnameserver 10.0.0.2\nnameserver 10.0.0.2\nnameserver 8.8.8.8\nnameserver 1.1.1.1\nnameserver 9.9.9.9';
    expect(parseResolvers(conf)).toEqual(['10.0.0.2', '8.8.8.8', '1.1.1.1']);
  });

  it.each(['nameserver 169.254.169.254', 'nameserver 0.0.0.0', 'nameserver 224.0.0.1', 'nameserver 1.2.3', 'nameserver 08.8.8.8', 'nameserver 1.2.3.999'])(
    'rejects invalid or unsafe resolver %s',
    (line) => expect(() => parseResolvers(line)).toThrow(),
  );

  it('dedupes and sorts public registry addresses', () => {
    const hosts = '104.16.2.35 STREAM registry.npmjs.org\n104.16.2.35 DGRAM\n104.16.1.35 STREAM\n';
    expect(parseRegistryIps(hosts)).toEqual(['104.16.1.35', '104.16.2.35']);
  });

  it.each(['10.1.1.1', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '255.255.255.255', 'not-an-ip', '2606:4700::1'])(
    'rejects non-public or malformed registry answer %s',
    (ip) => expect(() => parseRegistryIps(`104.16.1.35 STREAM\n${ip} STREAM`)).toThrow(),
  );

  it('rejects empty and oversized answers', () => {
    expect(() => parseRegistryIps('')).toThrow();
    const many = Array.from({ length: 33 }, (_, i) => `104.16.1.${i + 1} STREAM`).join('\n');
    expect(() => parseRegistryIps(many)).toThrow();
  });
});

describe('demo-registry-egress script', () => {
  const plan = parseProbe(probe('nameserver 10.0.0.2', '104.16.1.35 STREAM\n104.16.2.35 STREAM'));
  const script = applyScript(plan);

  it('is valid shell and only allows resolvers and the registry for UID 1100', () => {
    expect(spawnSync('bash', ['-n'], { input: script }).status).toBe(0);
    expect(spawnSync('bash', ['-n'], { input: removeScript() }).status).toBe(0);
    const rules = script.split('\n').filter((l) => l.startsWith('add rule'));
    expect(rules).toEqual([
      'add rule inet ranger ranger_demo_egress meta skuid 1100 ip daddr { 10.0.0.2 } udp dport 53 accept',
      'add rule inet ranger ranger_demo_egress meta skuid 1100 ip daddr { 10.0.0.2 } tcp dport 53 accept',
      'add rule inet ranger ranger_demo_egress meta skuid 1100 ip daddr { 104.16.1.35, 104.16.2.35 } tcp dport 443 accept',
    ]);
  });

  it('never touches the base table or existing drops, and is idempotent', () => {
    expect(script).not.toMatch(/delete|flush table|flush ruleset|policy/);
    expect(script).toContain('flush chain inet ranger ranger_demo_egress');
    expect(script).toContain("grep -q 'jump ranger_demo_egress' ||");
    expect(script).toContain('position "$final"');
  });

  it('omits DNS rules when only loopback resolvers exist', () => {
    const only = applyScript(parseProbe(probe('nameserver 127.0.0.53', '104.16.1.35 STREAM')));
    expect(only.split('\n').filter((l) => l.startsWith('add rule'))).toHaveLength(1);
  });
});

describe('demo-registry-egress run', () => {
  const ready = { machineId: 'm1', observedState: 'running', uncertain: false, destroyedAt: null };
  function deps(ws: ReturnType<Deps['workspace']>, calls: string[]): Deps {
    return {
      workspace: () => ws,
      exec: async (machineId, command) => {
        calls.push(`${machineId}:${command}`);
        const stdout = calls.length === 1 ? probe('nameserver 10.0.0.2', '104.16.1.35 STREAM') : 'ok';
        return { stdout, stderr: '', exitCode: 0, timedOut: false, truncated: false };
      },
    };
  }

  it('dry run probes read-only and does not apply', async () => {
    const calls: string[] = [];
    const result = await run({ projectId: PROJECT, mode: 'dry-run' }, deps(ready, calls));
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ mode: 'dry-run', machineId: 'm1', registryIps: ['104.16.1.35'] });
  });

  it('apply runs probe then rules on the resolved machine only', async () => {
    const calls: string[] = [];
    await run({ projectId: PROJECT, mode: 'apply' }, deps(ready, calls));
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.startsWith('m1:sudo --non-interactive'))).toBe(true);
  });

  it('refuses bad project ids and unready workspaces before any exec', async () => {
    const calls: string[] = [];
    await expect(run({ projectId: 'x', mode: 'apply' }, deps(ready, calls))).rejects.toThrow();
    await expect(run({ projectId: PROJECT, mode: 'apply' }, deps(null, calls))).rejects.toThrow();
    await expect(run({ projectId: PROJECT, mode: 'apply' }, deps({ ...ready, uncertain: true }, calls))).rejects.toThrow();
    await expect(run({ projectId: PROJECT, mode: 'apply' }, deps({ ...ready, machineId: null }, calls))).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('fails closed on a failing guest command', async () => {
    const failing: Deps = { workspace: () => ready, exec: async () => ({ stdout: '', stderr: 'boom', exitCode: 1, timedOut: false, truncated: false }) };
    await expect(run({ projectId: PROJECT, mode: 'apply' }, failing)).rejects.toThrow(/exitCode=1/);
  });
});
