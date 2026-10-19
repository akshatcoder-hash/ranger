import { describe, expect, it, vi } from 'vitest';
import { bootstrapScript, bootstrapWorkload, isolationProbeScript } from '../../src/workspace/bootstrap.js';
import { FakeInstabox } from '../../src/workspace/fake-provider.js';
import { splitFencedCommand, WORKLOAD_CGROUP, WORKLOAD_MEMORY_BYTES, WORKLOAD_PIDS_MAX, WORKLOAD_UID } from '../../src/workspace/limits.js';

const success = { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false };

describe('workspace bootstrap control-plane safety', () => {
  it('never migrates PID 1 or provider-control processes while retaining workload limits', () => {
    const script = bootstrapScript();
    // Live stage-by-stage reproduction showed PID 1 migration returns 0,
    // then every later management exec times out. The init cgroup is owned
    // by systemd; only the fenced launcher may move its own workload PID.
    expect(script).not.toContain('echo 1 >');
    expect(script).not.toMatch(/>\s*\/sys\/fs\/cgroup\/cgroup\.procs/);
    expect(script).toContain("'+cpu +memory +pids'");
    expect(script).toContain(`${WORKLOAD_CGROUP}/cpu.max`);
    expect(script).toContain(`'${WORKLOAD_MEMORY_BYTES}' > ${WORKLOAD_CGROUP}/memory.max`);
    expect(script).toContain(`'${WORKLOAD_PIDS_MAX}' > ${WORKLOAD_CGROUP}/pids.max`);
    expect(script).toContain(`meta skuid ${WORKLOAD_UID} drop`);
  });

  it('requires a fresh fenced exec under the workload UID after setup', async () => {
    const provider = new FakeInstabox();
    await expect(bootstrapWorkload(provider, 'm_local')).resolves.toEqual({ uid: WORKLOAD_UID });
    expect(provider.commands).toHaveLength(2);
    expect(splitFencedCommand(provider.commands[1]!.command)?.payload).toContain('id -u');
    expect(provider.commands[1]!.cwd).toBeUndefined();
    expect(provider.commands[1]!.user).toBe('ranger');
  });

  it('inspects limits on the workload cgroup rather than the unrestricted root', () => {
    const probe = isolationProbeScript();
    for (const limit of ['memory.max', 'pids.max', 'cpu.max']) {
      expect(probe).toContain(`cat ${WORKLOAD_CGROUP}/${limit}`);
      expect(probe).not.toContain(`cat /sys/fs/cgroup/${limit}`);
    }
  });

  it.each([
    ['stalled control', { exitCode: 124, timedOut: true }],
    ['wrong UID', { stdout: '1000\n' }],
    ['unverified output', { stdout: '' }],
    ['truncated output', { stdout: `${WORKLOAD_UID}\n`, truncated: true }],
  ])('fails closed on %s after a zero-exit setup command', async (_label, failed) => {
    const provider = new FakeInstabox();
    vi.spyOn(provider, 'exec')
      .mockResolvedValueOnce(success)
      .mockResolvedValueOnce({ ...success, ...failed });
    await expect(bootstrapWorkload(provider, 'm_local')).rejects.toThrow('workload bootstrap failed: readiness');
  });

  it('rejects a timeout flag even if the bootstrap exit code is zero', async () => {
    const provider = new FakeInstabox();
    const exec = vi.spyOn(provider, 'exec').mockResolvedValueOnce({ ...success, timedOut: true });
    await expect(bootstrapWorkload(provider, 'm_local')).rejects.toThrow('workload bootstrap failed');
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
