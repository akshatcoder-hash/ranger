import { readFileSync, statSync } from 'node:fs';
import { AppError, Errors } from './errors.js';

/**
 * Secret selection from an explicitly configured protected file.
 *
 * Rules (mission boundaries):
 * - The file path comes only from RANGER_SECRET_FILE, configured explicitly.
 * - Values are read into the requesting process memory on demand and never
 *   logged, echoed, embedded in errors, or written anywhere.
 * - Tests and offline code paths must not call into this module with a real
 *   file; they pass their own fixtures.
 */

const KNOWN_SECRET_NAMES = ['XAI_API_KEY', 'INSTABOX_API_KEY'] as const;
export type KnownSecretName = (typeof KNOWN_SECRET_NAMES)[number];

export class SecretsNotConfiguredError extends AppError {
  constructor() {
    super('not_configured', 'No secret file is configured for this process', {
      details: { provider: 'secrets', reason: 'RANGER_SECRET_FILE unset' },
    });
    this.name = 'SecretsNotConfiguredError';
  }
}

export class SecretMissingError extends AppError {
  constructor(name: string) {
    // Deliberately does not include the file path or any value material.
    super('not_configured', `Secret ${name} is not present in the configured secret file`, {
      details: { secret: name, reason: 'missing' },
    });
    this.name = 'SecretMissingError';
  }
}

/** Parse a KEY=VALUE environment-style file. Values are never logged. */
export function parseSecretFile(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key !== '' && value !== '') map.set(key, value);
  }
  return map;
}

/**
 * Resolves secret names from the configured protected file.
 * Constructed once per process with the configured path (or null when unset).
 */
export class SecretResolver {
  private cache: Map<string, string> | null = null;

  constructor(private readonly secretFile: string | null) {}

  isConfigured(): boolean {
    return this.secretFile !== null;
  }

  /** Which known provider secrets are present. Never returns values. */
  presentNames(): KnownSecretName[] {
    if (this.secretFile === null) return [];
    const parsed = this.load();
    return KNOWN_SECRET_NAMES.filter((name) => parsed.has(name));
  }

  /** Select one secret into process memory. Throws explicit errors on failure. */
  get(name: KnownSecretName): string {
    if (this.secretFile === null) throw new SecretsNotConfiguredError();
    const parsed = this.load();
    const value = parsed.get(name);
    if (value === undefined) throw new SecretMissingError(name);
    return value;
  }

  private load(): Map<string, string> {
    if (this.cache !== null) return this.cache;
    if (this.secretFile === null) throw new SecretsNotConfiguredError();
    let raw: string;
    try {
      const stats = statSync(this.secretFile);
      // Protected file must not be world- or group-readable.
      if ((stats.mode & 0o077) !== 0) {
        throw Errors.internal('Secret file permissions are too open');
      }
      raw = readFileSync(this.secretFile, 'utf8');
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError('not_configured', 'Configured secret file could not be read', {
        details: { provider: 'secrets', reason: 'unreadable' },
      });
    }
    this.cache = parseSecretFile(raw);
    // Drop the raw buffer reference; only the parsed map survives.
    raw = '';
    return this.cache;
  }
}
