import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, LIMIT_CEILINGS } from '../../src/config.js';

function envWith(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe('loadConfig', () => {
  it('requires RANGER_DATA_DIR for stateful processes', async () => {
    await expect(loadConfig(envWith({}))).rejects.toBeInstanceOf(ConfigError);
  });

  it('applies documented defaults for a fresh data directory', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-config-'));
    const config = await loadConfig(envWith({ RANGER_DATA_DIR: dir }));
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3100);
    expect(config.previewPort).toBe(3101);
    expect(config.secretFile).toBeNull();
    expect(config.liveBudgetFile).toBeNull();
    expect(config.limits.maxConcurrentRuns).toBe(1);
  });

  it('reads ports, secret file and budget ledger from the environment', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-config-'));
    const config = await loadConfig(
      envWith({
        RANGER_DATA_DIR: dir,
        RANGER_HOST: '127.0.0.1',
        RANGER_PORT: '3901',
        RANGER_PREVIEW_PORT: '3902',
        RANGER_SECRET_FILE: '/tmp/ranger-test-secrets',
        RANGER_LIVE_BUDGET_FILE: '/tmp/ranger-test-budget.json',
      }),
    );
    expect(config.port).toBe(3901);
    expect(config.previewPort).toBe(3902);
    expect(config.secretFile).toBe('/tmp/ranger-test-secrets');
    expect(config.liveBudgetFile).toBe('/tmp/ranger-test-budget.json');
  });

  it('rejects non-integer ports', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-config-'));
    await expect(
      loadConfig(envWith({ RANGER_DATA_DIR: dir, RANGER_PORT: 'not-a-port' })),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('applies config-file limits only within documented ceilings', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-config-'));
    const cfgFile = path.join(dir, 'ranger.config.json');
    writeFileSync(
      cfgFile,
      JSON.stringify({ limits: { maxFrameBytes: 1024, maxConcurrentRuns: 4 } }),
    );
    // maxConcurrentRuns 4 exceeds the ceiling of 1 and must be refused.
    await expect(
      loadConfig(envWith({ RANGER_DATA_DIR: dir, RANGER_CONFIG_FILE: cfgFile })),
    ).rejects.toBeInstanceOf(ConfigError);

    writeFileSync(cfgFile, JSON.stringify({ limits: { maxFrameBytes: 1024 } }));
    const config = await loadConfig(envWith({ RANGER_DATA_DIR: dir, RANGER_CONFIG_FILE: cfgFile }));
    expect(config.limits.maxFrameBytes).toBe(1024);
    expect(config.limits.maxConcurrentRuns).toBe(LIMIT_CEILINGS.maxConcurrentRuns);
  });

  it('rejects malformed config files', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-config-'));
    const cfgFile = path.join(dir, 'broken.json');
    writeFileSync(cfgFile, '{not json');
    await expect(
      loadConfig(envWith({ RANGER_DATA_DIR: dir, RANGER_CONFIG_FILE: cfgFile })),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
