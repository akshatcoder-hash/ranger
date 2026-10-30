import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolveRepoRoot } from './identity/repo-root.js';
import type { SecretSource } from './secrets.js';

/**
 * Central configuration for all Ranger processes (API, worker, preview).
 *
 * Values come from environment variables plus an optional JSON config file
 * (RANGER_CONFIG_FILE). The config file may tighten limits but never widens
 * them beyond documented maxima. Secrets are NOT part of config: they are
 * selected on demand by src/secrets.ts from the protected file (default)
 * or an explicitly opted-in process environment.
 */

export const CONTRACT_VERSION = 'v1' as const;

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3100;
export const DEFAULT_PREVIEW_PORT = 3101;

/** Documented loopback ports from the mission boundaries. */
export const PORTS = {
  api: 3100,
  preview: 3101,
  fixtureMin: 3200,
  fixtureMax: 3299,
  testMin: 3900,
  testMax: 3999,
} as const;

export interface LimitsConfig {
  /** Global concurrent engineering runs (mission: initially one). */
  maxConcurrentRuns: number;
  /** Concurrent worker jobs claimed from the durable queue. */
  maxWorkerJobs: number;
  /** Max bytes accepted for one ingested screen frame. */
  maxFrameBytes: number;
  /** Max queued frames per capture session. */
  maxCaptureQueue: number;
  /** Max concurrent vision-processing jobs. */
  maxVisionConcurrency: number;
  /** Milliseconds a claimed worker job lease stays valid. */
  jobLeaseMs: number;
  /** Worker poll interval in milliseconds. */
  workerPollMs: number;
  /** Replay window (ms): cursors older than this answer cursor_expired. */
  eventReplayWindowMs: number;
}

export interface ProviderConfig {
  /** Optional explicit xAI realtime voice model override; pinned default below. */
  xaiVoiceModel: string;
  /** Optional explicit xAI image-understanding model for on-demand inspection. */
  xaiVisionModel: string;
  /** Optional explicit xAI Responses-API model for the coding loop. */
  xaiCodingModel: string;
  /** Sibling Trace repository root. */
  traceRoot: string;
  /** Pinned Trace commit (informational here; enforced by the Trace feature). */
  tracePinnedCommit: string;
  /** TRACE_HOME directory for Trace index/model state outside git. */
  traceHome: string;
}

export interface GroundingConfig {
  /** Atom/Orbit grounding is an optional interface only; disabled by default. */
  atomOrbitEndpoint: string | null;
}

export interface RangerConfig {
  host: string;
  port: number;
  previewPort: number;
  dataDir: string;
  /** Protected-file path; required for provider keys when source is file. */
  secretFile: string | null;
  /** Environment keys are unavailable unless explicitly selected by the operator. */
  secretSource: SecretSource;
  /** Path to the shared live-test budget ledger; unset means live ops are refused. */
  liveBudgetFile: string | null;
  /** Optional JSON config file with limit/provider overrides. */
  configFile: string | null;
  /**
   * Operator-approved synthetic roots (absolute paths) whose local git
   * worktrees may be inspected for repository snapshots. Empty means local
   * inspection is denied; remote references never need host inspection.
   */
  approvedSnapshotRoots: string[];
  /**
   * Opt-in shared demo: when set, every anonymous browser session becomes a
   * member of this one project. Null (unset) disables the feature and, after an
   * API restart, revokes grants made while it was enabled.
   */
  demoProjectId: string | null;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug';
  limits: LimitsConfig;
  providers: ProviderConfig;
  grounding: GroundingConfig;
}

/** Hard ceilings: a config file may lower but never exceed these. */
export const LIMIT_CEILINGS: LimitsConfig = {
  maxConcurrentRuns: 1,
  maxWorkerJobs: 2,
  maxFrameBytes: 8 * 1024 * 1024,
  maxCaptureQueue: 32,
  maxVisionConcurrency: 2,
  jobLeaseMs: 5 * 60 * 1000,
  workerPollMs: 1000,
  eventReplayWindowMs: 30 * 24 * 60 * 60 * 1000,
};

export const DEFAULT_PROVIDERS: ProviderConfig = {
  xaiVoiceModel: 'grok-voice-3.0',
  xaiVisionModel: 'grok-4.3',
  xaiCodingModel: 'grok-4.3',
  // Sibling checkout next to this repository; override with providers.traceRoot
  // in the RANGER_CONFIG_FILE. resolveRepoRoot works from src/ and dist/src/.
  traceRoot: path.join(path.dirname(resolveRepoRoot(import.meta.dirname)), 'trace'),
  tracePinnedCommit: 'bd7f255339a45a5bf41bcdc2be650626c497e2b2',
  traceHome: path.join(homedir(), '.cache', 'ranger-trace'),
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function readInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = readString(env, name);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`Environment variable ${name} must be a positive integer, got ${raw}`);
  }
  return parsed;
}

async function readConfigFile(path: string | undefined): Promise<Partial<RangerConfig>> {
  if (path === undefined) return {};
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    throw new ConfigError(`RANGER_CONFIG_FILE at ${path} could not be read: ${String(cause)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(`RANGER_CONFIG_FILE at ${path} is not valid JSON: ${String(cause)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`RANGER_CONFIG_FILE at ${path} must contain a JSON object`);
  }
  return parsed as Partial<RangerConfig>;
}

function clampLimits(overrides: unknown): LimitsConfig {
  const limits: LimitsConfig = { ...LIMIT_CEILINGS };
  if (overrides === undefined) return limits;
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    throw new ConfigError('Config "limits" must be an object');
  }
  const source = overrides as Record<string, unknown>;
  const keys = Object.keys(LIMIT_CEILINGS) as Array<keyof LimitsConfig>;
  for (const key of keys) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new ConfigError(`Config limits.${key} must be a positive number`);
    }
    if (value > LIMIT_CEILINGS[key]) {
      throw new ConfigError(
        `Config limits.${key}=${value} exceeds the documented ceiling ${LIMIT_CEILINGS[key]}`,
      );
    }
    limits[key] = value;
  }
  return limits;
}

function resolveProviders(overrides: unknown): ProviderConfig {
  const providers: ProviderConfig = { ...DEFAULT_PROVIDERS };
  if (overrides === undefined) return providers;
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    throw new ConfigError('Config "providers" must be an object');
  }
  const source = overrides as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_PROVIDERS) as Array<keyof ProviderConfig>) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value === '') {
      throw new ConfigError(`Config providers.${key} must be a non-empty string`);
    }
    providers[key] = value;
  }
  return providers;
}

/**
 * Local snapshot inspection is denied unless the operator explicitly
 * approved synthetic roots. Roots come from RANGER_APPROVED_SNAPSHOT_ROOTS
 * (path-delimiter-separated) and the optional config-file key
 * `approvedSnapshotRoots` (string array); entries must be absolute paths.
 */
function resolveApprovedSnapshotRoots(
  env: NodeJS.ProcessEnv,
  fileConfig: Partial<RangerConfig>,
): string[] {
  const rawEnv = readString(env, 'RANGER_APPROVED_SNAPSHOT_ROOTS');
  const fromEnv =
    rawEnv === undefined
      ? []
      : rawEnv
          .split(path.delimiter)
          .map((entry) => entry.trim())
          .filter((entry) => entry !== '');
  const fromFile = fileConfig.approvedSnapshotRoots;
  const declared = Array.isArray(fromFile) ? fromFile : [];
  const roots = [...fromEnv, ...declared];
  for (const root of roots) {
    if (typeof root !== 'string' || root === '') {
      throw new ConfigError('Approved snapshot roots must be non-empty path strings');
    }
    if (!path.isAbsolute(root)) {
      throw new ConfigError(`Approved snapshot roots must be absolute paths, got ${root}`);
    }
  }
  return roots;
}

/**
 * Load and validate configuration. `dataDir` is required for processes that
 * touch durable state; pass `requireDataDir: false` for pure helpers.
 */
export async function loadConfig(
  env: NodeJS.ProcessEnv,
  opts: { requireDataDir?: boolean } = {},
): Promise<RangerConfig> {
  const configFile = readString(env, 'RANGER_CONFIG_FILE');
  const fileConfig = await readConfigFile(configFile);
  // Source selection is an explicit process setting, never a JSON-file
  // override. Ambient key presence alone must not enable live providers.
  const secretSource = readString(env, 'RANGER_SECRET_SOURCE') ?? 'file';
  if (secretSource !== 'file' && secretSource !== 'environment') {
    throw new ConfigError('RANGER_SECRET_SOURCE must be file or environment');
  }
  const secretFile = readString(env, 'RANGER_SECRET_FILE') ?? null;
  if (secretSource === 'environment' && secretFile !== null) {
    throw new ConfigError('Unset RANGER_SECRET_FILE when RANGER_SECRET_SOURCE=environment');
  }

  const dataDir = readString(env, 'RANGER_DATA_DIR') ?? fileConfig.dataDir;
  if (opts.requireDataDir !== false && dataDir === undefined) {
    throw new ConfigError('RANGER_DATA_DIR must be set to a writable data directory');
  }

  const logLevelRaw = readString(env, 'RANGER_LOG_LEVEL') ?? 'info';
  const allowedLogLevels: RangerConfig['logLevel'][] = ['fatal', 'error', 'warn', 'info', 'debug'];
  if (!allowedLogLevels.includes(logLevelRaw as RangerConfig['logLevel'])) {
    throw new ConfigError(`RANGER_LOG_LEVEL must be one of ${allowedLogLevels.join(', ')}`);
  }

  const demoProjectId = readString(env, 'RANGER_DEMO_PROJECT_ID') ?? null;
  if (demoProjectId !== null && !/^prj_[0-9a-fA-F-]+$/.test(demoProjectId)) {
    throw new ConfigError('RANGER_DEMO_PROJECT_ID must be a project id like prj_<uuid>');
  }

  return {
    host: readString(env, 'RANGER_HOST') ?? DEFAULT_HOST,
    port: readInt(env, 'RANGER_PORT') ?? DEFAULT_PORT,
    previewPort: readInt(env, 'RANGER_PREVIEW_PORT') ?? DEFAULT_PREVIEW_PORT,
    dataDir: dataDir ?? '.',
    secretFile,
    secretSource,
    liveBudgetFile: readString(env, 'RANGER_LIVE_BUDGET_FILE') ?? null,
    configFile: configFile ?? null,
    approvedSnapshotRoots: resolveApprovedSnapshotRoots(env, fileConfig),
    demoProjectId,
    logLevel: logLevelRaw as RangerConfig['logLevel'],
    limits: clampLimits(fileConfig.limits),
    providers: resolveProviders(fileConfig.providers),
    grounding: {
      atomOrbitEndpoint: null,
    },
  };
}
