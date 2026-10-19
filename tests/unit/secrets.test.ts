import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSecretFile, SecretResolver, SecretMissingError, SecretsNotConfiguredError } from '../../src/secrets.js';

function writeFixtureSecretFile(dir: string, mode: number): string {
  const file = path.join(dir, 'environment');
  // Synthetic fixture values; never real provider keys.
  writeFileSync(file, 'XAI_API_KEY=test-fixture-xai-value\nINSTABOX_API_KEY=test-fixture-ibx-value\n# comment\n\n');
  chmodSync(file, mode);
  return file;
}

describe('SecretResolver', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('selects secrets from an explicitly configured 0600 fixture file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-secrets-'));
    const file = writeFixtureSecretFile(dir, 0o600);
    const resolver = new SecretResolver(file);
    expect(resolver.isConfigured()).toBe(true);
    expect(resolver.get('XAI_API_KEY')).toBe('test-fixture-xai-value');
    expect(resolver.presentNames()).toEqual(['XAI_API_KEY', 'INSTABOX_API_KEY']);
  });

  it('refuses secret files with permissive modes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-secrets-'));
    const file = writeFixtureSecretFile(dir, 0o644);
    const resolver = new SecretResolver(file);
    expect(() => resolver.presentNames()).toThrow(/permissions are too open/i);
  });

  it('reports not_configured when no file is configured (never throws raw paths)', () => {
    const resolver = new SecretResolver(null);
    expect(resolver.isConfigured()).toBe(false);
    expect(() => resolver.get('XAI_API_KEY')).toThrow(SecretsNotConfiguredError);
    expect(resolver.presentNames()).toEqual([]);
  });

  it('never selects ambient keys or ambient source flags through the legacy constructor', () => {
    vi.stubEnv('RANGER_SECRET_SOURCE', 'environment');
    vi.stubEnv('XAI_API_KEY', 'synthetic-ambient-xai');
    vi.stubEnv('INSTABOX_API_KEY', 'synthetic-ambient-instabox');
    const resolver = new SecretResolver(null);
    expect(resolver.isConfigured()).toBe(false);
    expect(resolver.presentNames()).toEqual([]);
    expect(() => resolver.get('XAI_API_KEY')).toThrow(SecretsNotConfiguredError);
  });

  it('does not fall back to ambient keys when a protected file is missing a key', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-secrets-'));
    const file = path.join(dir, 'environment');
    writeFileSync(file, 'INSTABOX_API_KEY=synthetic-file-instabox\n', { mode: 0o600 });
    vi.stubEnv('XAI_API_KEY', 'synthetic-ambient-xai');
    const resolver = new SecretResolver(file);
    expect(resolver.presentNames()).toEqual(['INSTABOX_API_KEY']);
    expect(() => resolver.get('XAI_API_KEY')).toThrow(SecretMissingError);
  });

  it('never reads an injected environment when the selected source is file', () => {
    const environment = new Proxy({}, {
      get: () => { throw new Error('environment must not be read'); },
    });
    const resolver = SecretResolver.fromConfig({ secretFile: null, secretSource: 'file' }, environment);
    expect(resolver.presentNames()).toEqual([]);
    expect(() => resolver.get('XAI_API_KEY')).toThrow(SecretsNotConfiguredError);
  });

  it('does not fall back to ambient keys when a configured protected file is unreadable', () => {
    vi.stubEnv('XAI_API_KEY', 'synthetic-ambient-xai');
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-secrets-'));
    const resolver = new SecretResolver(path.join(dir, 'missing'));
    expect(() => resolver.get('XAI_API_KEY')).toThrow(/could not be read/);
  });

  it('selects only allowlisted environment names after explicit opt-in', () => {
    const environment = {
      XAI_API_KEY: 'synthetic-env-xai',
      INSTABOX_API_KEY: 'synthetic-env-instabox',
      OTHER_KEY: 'synthetic-unrelated-secret',
    };
    const resolver = SecretResolver.fromConfig(
      { secretFile: null, secretSource: 'environment' }, environment,
    );
    expect(resolver.isConfigured()).toBe(true);
    expect(resolver.presentNames()).toEqual(['XAI_API_KEY', 'INSTABOX_API_KEY']);
    expect(resolver.get('XAI_API_KEY')).toBe('synthetic-env-xai');
    expect(resolver.get('INSTABOX_API_KEY')).toBe('synthetic-env-instabox');
    expect(() => resolver.get('OTHER_KEY' as never)).toThrow(SecretMissingError);
    expect(JSON.stringify(resolver)).not.toContain('synthetic-');
  });

  it('reads process environment on demand only when explicitly selected', () => {
    const resolver = SecretResolver.fromConfig({ secretFile: null, secretSource: 'environment' });
    vi.stubEnv('XAI_API_KEY', 'synthetic-late-env-xai');
    vi.stubEnv('INSTABOX_API_KEY', undefined);
    expect(resolver.get('XAI_API_KEY')).toBe('synthetic-late-env-xai');
    vi.stubEnv('XAI_API_KEY', 'synthetic-replaced-env-xai');
    expect(resolver.get('XAI_API_KEY')).toBe('synthetic-late-env-xai');
  });

  it('fails closed for absent or empty environment keys without exposing values', () => {
    const resolver = SecretResolver.fromConfig(
      { secretFile: null, secretSource: 'environment' },
      { XAI_API_KEY: '', INSTABOX_API_KEY: '  ', OTHER_KEY: 'synthetic-private-value' },
    );
    expect(resolver.presentNames()).toEqual([]);
    expect(() => resolver.get('XAI_API_KEY')).toThrow(SecretMissingError);
    expect(() => resolver.get('INSTABOX_API_KEY')).toThrow(SecretMissingError);
  });

  it('does not trim, unquote, or evaluate selected environment values', () => {
    const value = '"synthetic-$(echo nope)"';
    const resolver = SecretResolver.fromConfig(
      { secretFile: null, secretSource: 'environment' }, { XAI_API_KEY: value },
    );
    expect(resolver.get('XAI_API_KEY')).toBe(value);
  });

  it('rejects ambiguous and unsupported sources before reading a file or environment', () => {
    expect(() => new SecretResolver('/never-read', { source: 'environment' })).toThrow(/cannot also/);
    expect(() => new SecretResolver(null, { source: 'ambient' as never })).toThrow(/file or environment/);
  });

  it('refuses unknown provider names even when they are present in a protected file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-secrets-'));
    const file = path.join(dir, 'environment');
    writeFileSync(file, 'OTHER_KEY=synthetic-unrelated-secret\n', { mode: 0o600 });
    const resolver = new SecretResolver(file);
    expect(() => resolver.get('OTHER_KEY' as never)).toThrow(SecretMissingError);
  });

  it('reports a missing named secret with a message free of file contents', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ranger-secrets-'));
    const file = writeFixtureSecretFile(dir, 0o600);
    const resolver = new SecretResolver(file);
    let message = '';
    try {
      // INSTABOX key exists; ask for an unknown-but-typed name via cast.
      const unknown = 'OTHER_KEY' as never;
      resolver.get(unknown);
    } catch (cause) {
      message = String((cause as Error).message);
    }
    expect(message).not.toContain('test-fixture-xai-value');
    expect(() => resolver.get('XAI_API_KEY')).not.toThrow(SecretMissingError);
  });

  it('parses KEY=VALUE lines and ignores comments and blanks', () => {
    const parsed = parseSecretFile('# header\nA=1\n\nB=two = with equals\n');
    expect(parsed.get('A')).toBe('1');
    expect(parsed.get('B')).toBe('two = with equals');
    expect(parsed.size).toBe(2);
  });

  it('strips one matching pair of double quotes and keeps the inner value', () => {
    const parsed = parseSecretFile('INSTABOX_API_KEY="synthetic-double"\n');
    expect(parsed.get('INSTABOX_API_KEY')).toBe('synthetic-double');
  });

  it('strips one matching pair of single quotes and keeps the inner value', () => {
    const parsed = parseSecretFile("INSTABOX_API_KEY='synthetic-single'\n");
    expect(parsed.get('INSTABOX_API_KEY')).toBe('synthetic-single');
  });

  it('leaves an unquoted value unchanged, including embedded quotes', () => {
    const parsed = parseSecretFile('INSTABOX_API_KEY=synthetic-plain\nXAI_API_KEY=keep"inner\'quotes\n');
    expect(parsed.get('INSTABOX_API_KEY')).toBe('synthetic-plain');
    expect(parsed.get('XAI_API_KEY')).toBe('keep"inner\'quotes');
  });

  it('does not shell-evaluate quoted values or strip mismatched quotes', () => {
    const parsed = parseSecretFile(
      'INSTABOX_API_KEY="synthetic-$(echo leak)"\nXAI_API_KEY=\'not-closed\nOTHER="mismatched\'\n',
    );
    expect(parsed.get('INSTABOX_API_KEY')).toBe('synthetic-$(echo leak)');
    expect(parsed.get('XAI_API_KEY')).toBe("'not-closed");
    expect(parsed.get('OTHER')).toBe('"mismatched\'');
  });
});
