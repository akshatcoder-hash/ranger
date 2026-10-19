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
    expect(config.secretSource).toBe('file');
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
    expect(config.secretSource).toBe('file');
    expect(config.liveBudgetFile).toBe('/tmp/ranger-test-budget.json');
  });

  it('requires explicit process opt-in before selecting environment secrets', async () => {
    const config = await loadConfig(envWith({
      RANGER_SECRET_SOURCE: 'environment',
      XAI_API_KEY: 'synthetic-env-key',
    }), { requireDataDir: false });
    expect(config.secretSource).toBe('environment');
    expect(config.secretFile).toBeNull();
    expect(JSON.stringify(config)).not.toContain('synthetic-env-key');

    const defaultConfig = await loadConfig(envWith({ XAI_API_KEY: 'synthetic-env-key' }), { requireDataDir: false });
    expect(defaultConfig.secretSource).toBe('file');
  });

  it('rejects ambiguous and unsupported secret source settings', async () => {
    await expect(loadConfig(envWith({
      RANGER_SECRET_SOURCE: 'environment', RANGER_SECRET_FILE: '/not-read',
    }), { requireDataDir: false })).rejects.toThrow(/Unset RANGER_SECRET_FILE/);
    await expect(loadConfig(envWith({
      RANGER_SECRET_SOURCE: 'ambient',
    }), { requireDataDir: false })).rejects.toThrow(/must be file or environment/);
  });

  it('does not allow a JSON config file to opt into ambient provider secrets', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-config-'));
    const cfgFile = path.join(dir, 'ranger.config.json');
    writeFileSync(cfgFile, JSON.stringify({ secretSource: 'environment', secretFile: '/not-read' }));
    const config = await loadConfig(envWith({ RANGER_CONFIG_FILE: cfgFile }), { requireDataDir: false });
    expect(config.secretSource).toBe('file');
    expect(config.secretFile).toBeNull();
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
