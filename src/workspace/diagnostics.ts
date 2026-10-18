/**
 * Secret-safe diagnostics for provider command failures.
 *
 * Provider error text may echo the command that was sent or carry
 * machine-scoped tokens. Everything that reaches public logs, API error
 * details or persisted command rows passes through here first.
 */

import type { ProviderCommandResult } from './provider.js';

const MAX_DETAIL_CHARS = 300;

export function sanitizeProviderError(raw: string, command: string): string {
  let text = raw;
  if (command.length > 0) text = text.split(command).join('[command]');
  text = text.replace(/[A-Za-z0-9_\-]{24,}/g, '[redacted]');
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_CHARS);
}

/** Duck-typed shape of the SDK's CommandExitError. */
export interface CommandExitShape {
  name?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
  truncated?: boolean;
  error?: string;
}

/**
 * Translate an SDK CommandExitError into a failed result. The server reports
 * launch failures (for example a denied pre-command chdir) through `error`
 * with both streams empty: keep a meaningful, secret-safe diagnosis instead
 * of an empty detail. Returns undefined when the cause is not a command exit.
 */
export function translateCommandExitError(cause: unknown, command: string): ProviderCommandResult | undefined {
  const exited = (cause ?? {}) as CommandExitShape;
  if (exited.name !== 'CommandExitError' || typeof exited.exitCode !== 'number') return undefined;
  const stdout = exited.stdout ?? '';
  const stderr = exited.stderr ?? '';
  const rawError = typeof exited.error === 'string' && exited.error.length > 0 ? exited.error : undefined;
  const detail = rawError === undefined ? undefined : sanitizeProviderError(rawError, command);
  const streamsEmpty = stdout === '' && stderr === '';
  return {
    stdout,
    stderr: streamsEmpty && detail !== undefined ? detail : stderr,
    exitCode: exited.exitCode,
    timedOut: exited.timedOut === true,
    truncated: exited.truncated === true,
    ...(detail !== undefined ? { error: detail } : {}),
  };
}
