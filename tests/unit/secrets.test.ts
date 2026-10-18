import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSecretFile, SecretResolver, SecretMissingError, SecretsNotConfiguredError } from '../../src/secrets.js';

function writeFixtureSecretFile(dir: string, mode: number): string {
  const file = path.join(dir, 'environment');
  // Synthetic fixture values; never real provider keys.
  writeFileSync(file, 'XAI_API_KEY=test-fixture-xai-value\nINSTABOX_API_KEY=test-fixture-ibx-value\n# comment\n\n');
  chmodSync(file, mode);
  return file;
}

describe('SecretResolver', () => {
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
