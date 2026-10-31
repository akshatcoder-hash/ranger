import { Sandbox, type SandboxInfo } from '@insforge/instabox-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCreateRequest } from '../../src/workspace/provider.js';
import { SdkInstaboxProvider } from '../../src/workspace/sdk-provider.js';

const request: ProviderCreateRequest = {
  template: 'agent-browser', vault: false, timeoutMs: 600_000,
  onTimeout: 'kill', autoSuspendMs: 0, metadata: { rangerProject: 'prj_fixture' },
  apiKey: 'synthetic-fixture-key',
};
const info = {
  sandboxId: 'm_fixture', state: 'running', vault: false,
  onTimeout: 'kill', metadata: request.metadata,
} as SandboxInfo;

afterEach(() => vi.restoreAllMocks());

describe('SDK account-wide create admission (offline mocks only)', () => {
  it('never sends the lifetime fields the provider retired', async () => {
    vi.spyOn(Sandbox, 'list').mockResolvedValue([]);
    const create = vi.spyOn(Sandbox, 'create').mockResolvedValue({ getInfo: async () => info } as Sandbox);
    expect(await new SdkInstaboxProvider().create({ ...request, timeoutMs: null })).toMatchObject({ timeoutMs: null });
    expect(create.mock.calls[0]?.[1]).not.toHaveProperty('timeoutMs');
    expect(create.mock.calls[0]?.[1]).not.toHaveProperty('onTimeout');
  });
  it('treats a failed create response as uncertain rather than freeing the slot', async () => {
    vi.spyOn(Sandbox, 'list').mockResolvedValue([]);
    vi.spyOn(Sandbox, 'create').mockRejectedValue(new Error('lost response'));
    await expect(new SdkInstaboxProvider().create(request)).rejects.toMatchObject({ details: { reason: 'uncertain_create' } });
  });
  it('re-dials once without the idle override when a free account refuses it', async () => {
    vi.spyOn(Sandbox, 'list').mockResolvedValue([]);
    const refusal = Object.assign(new Error('Free users are not able to change idle time'), { code: 'permission_denied', status: 403 });
    const create = vi
      .spyOn(Sandbox, 'create')
      .mockRejectedValueOnce(refusal)
      .mockResolvedValue({ getInfo: async () => info } as Sandbox);
    await expect(new SdkInstaboxProvider().create(request)).resolves.toMatchObject({ machineId: 'm_fixture' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[1]).not.toHaveProperty('autoSuspendMs');
  });
  it('reports a provider quota refusal as capacity, not an uncertain create', async () => {
    vi.spyOn(Sandbox, 'list').mockResolvedValue([]);
    vi.spyOn(Sandbox, 'create').mockRejectedValue(
      Object.assign(new Error('sandbox limit reached (1 of 1)'), { code: 'quota_exceeded', status: 429 }),
    );
    await expect(new SdkInstaboxProvider().create(request)).rejects.toMatchObject({ details: { reason: 'vm_capacity' } });
  });
  it('keeps a post-create rate limit uncertain instead of reporting capacity', async () => {
    vi.spyOn(Sandbox, 'list').mockResolvedValue([]);
    vi.spyOn(Sandbox, 'create').mockResolvedValue({
      getInfo: async () => {
        throw Object.assign(new Error('too many requests'), { code: 'rate_limited', status: 429 });
      },
    } as unknown as Sandbox);
    await expect(new SdkInstaboxProvider().create(request)).rejects.toMatchObject({ details: { reason: 'uncertain_create' } });
  });
  it('checks account headroom using the same key before creating the fifth machine', async () => {
    const list = vi.spyOn(Sandbox, 'list').mockResolvedValue(Array(4).fill(info));
    const create = vi.spyOn(Sandbox, 'create').mockResolvedValue({ getInfo: async () => info } as Sandbox);
    const provider = new SdkInstaboxProvider('different-synthetic-constructor-key');
    await expect(provider.create(request)).resolves.toMatchObject({ machineId: 'm_fixture' });
    expect(list).toHaveBeenCalledExactlyOnceWith({ apiKey: request.apiKey });
    expect(create).toHaveBeenCalledExactlyOnceWith('agent-browser', {
      apiKey: request.apiKey, vault: false, autoSuspendMs: 0, metadata: request.metadata,
    });
    expect(list.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]!);
  });

  it.each([5, 6])('refuses before create when the account already contains %i machines', async (count) => {
    vi.spyOn(Sandbox, 'list').mockResolvedValue(Array(count).fill(info));
    const create = vi.spyOn(Sandbox, 'create').mockRejectedValue(new Error('must not run'));
    await expect(new SdkInstaboxProvider().create(request)).rejects.toThrow('account simultaneous-machine limit');
    expect(create).not.toHaveBeenCalled();
  });

  it('fails closed without a create when account inventory cannot be verified', async () => {
    vi.spyOn(Sandbox, 'list').mockRejectedValue(new Error('synthetic inventory failure'));
    const create = vi.spyOn(Sandbox, 'create').mockRejectedValue(new Error('must not run'));
    await expect(new SdkInstaboxProvider().create(request)).rejects.toThrow('synthetic inventory failure');
    expect(create).not.toHaveBeenCalled();
  });
});
