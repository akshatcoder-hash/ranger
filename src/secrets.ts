import { readFileSync, statSync } from 'node:fs';
import { AppError, Errors } from './errors.js';

/**
 * Secret selection from an explicitly configured source.
 *
 * Rules (mission boundaries):
 * - Protected-file selection remains the default. Environment selection is
 *   opt-in through RANGER_SECRET_SOURCE=environment; there is no fallback.
 * - Values are read into the requesting process memory on demand and never
 *   logged, echoed, embedded in errors, or written anywhere.
 * - Tests and offline code paths must not call into this module with a real
 *   file; they pass their own fixtures.
 */

const KNOWN_SECRET_NAMES = ['XAI_API_KEY', 'INSTABOX_API_KEY'] as const;
export type KnownSecretName = (typeof KNOWN_SECRET_NAMES)[number];
export type SecretSource = 'file' | 'environment';

interface SecretResolverOptions {
  source?: SecretSource;
  /** Injectable environment for tests; never used unless explicitly selected. */
  environment?: NodeJS.ProcessEnv;
}

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
    super('not_configured', `Secret ${name} is not present in the configured secret source`, {
      details: { secret: name, reason: 'missing' },
    });
    this.name = 'SecretMissingError';
  }
}

/**
 * Drop one matching pair of outer quotes. This is not shell evaluation:
 * no expansion, no escape processing, and mismatched quotes stay put.
 */
export function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }
  return value;
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
    const value = stripMatchingQuotes(trimmed.slice(eq + 1).trim());
    if (key !== '' && value !== '') map.set(key, value);
  }
  return map;
}

/**
 * Resolves only known provider names from the selected source. Constructing
 * with just a file path retains the original protected-file behavior, even
 * when ambient provider keys or RANGER_SECRET_SOURCE exist in process.env.
 */
export class SecretResolver {
  private cache: Map<string, string> | null = null;
  private readonly source: SecretSource;
  // A real private field prevents an injected environment from being included
  // in accidental object serialization. Only allowlisted values enter cache.
  #environment: NodeJS.ProcessEnv | undefined;

  constructor(private readonly secretFile: string | null, options: SecretResolverOptions = {}) {
    this.source = options.source ?? 'file';
    if (this.source !== 'file' && this.source !== 'environment') {
      throw new AppError('not_configured', 'Secret source must be file or environment');
    }
    if (this.source === 'environment' && secretFile !== null) {
      throw new AppError('not_configured', 'Environment secret source cannot also configure a secret file');
    }
    this.#environment = this.source === 'environment' ? options.environment : undefined;
  }

  /** Central runtime adapter; configuration contains selectors, never values. */
  static fromConfig(
    config: { secretFile: string | null; secretSource: SecretSource },
    environment?: NodeJS.ProcessEnv,
  ): SecretResolver {
    return new SecretResolver(config.secretFile, { source: config.secretSource, environment });
  }

  isConfigured(): boolean {
    return this.source === 'environment' || this.secretFile !== null;
  }

  /** Which known provider secrets are present. Never returns values. */
  presentNames(): KnownSecretName[] {
    if (!this.isConfigured()) return [];
    const parsed = this.load();
    return KNOWN_SECRET_NAMES.filter((name) => parsed.has(name));
  }

  /** Select one secret into process memory. Throws explicit errors on failure. */
  get(name: KnownSecretName): string {
    if (!this.isConfigured()) throw new SecretsNotConfiguredError();
    const parsed = this.load();
    const value = parsed.get(name);
    if (value === undefined) throw new SecretMissingError(name);
    return value;
  }

  private load(): Map<string, string> {
    if (this.cache !== null) return this.cache;
    if (this.source === 'environment') {
      const environment = this.#environment ?? process.env;
      const selected = new Map<string, string>();
      for (const name of KNOWN_SECRET_NAMES) {
        const value = environment[name];
        if (typeof value === 'string' && value.trim() !== '') selected.set(name, value);
      }
      this.cache = selected;
      return this.cache;
    }
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
    const parsed = parseSecretFile(raw);
    this.cache = new Map(
      KNOWN_SECRET_NAMES.flatMap((name) => {
        const value = parsed.get(name);
        return value === undefined ? [] : [[name, value] as const];
      }),
    );
    // Drop the raw buffer reference; only the parsed map survives.
    raw = '';
    return this.cache;
  }
}
