/**
 * Central stable error envelope for the Ranger API.
 *
 * Every failure uses the same envelope shape:
 *   { "requestId": "...", "error": { "code": "...", "message": "...", "details": {...} } }
 *
 * Codes are stable, documented semantic classes (see docs/contract-changelog.md).
 * Messages and details must never contain secrets or raw provider output.
 */

export type ErrorCode =
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'not_configured'
  | 'invalid_cursor'
  | 'cursor_expired'
  | 'internal_error';

export interface ErrorEnvelopeBody {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  requestId: string;
  error: ErrorEnvelopeBody;
}

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  budget_exceeded: 402,
  not_configured: 501,
  invalid_cursor: 400,
  cursor_expired: 410,
  internal_error: 500,
};

/** Application error carrying a stable code and safe public message. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, opts?: { httpStatus?: number; details?: Record<string, unknown> }) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = opts?.httpStatus ?? DEFAULT_STATUS[code];
    this.details = opts?.details;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Convenience constructors for the common classes. */
export const Errors = {
  validation: (message: string, details?: Record<string, unknown>) =>
    new AppError('validation_failed', message, { details }),
  unauthorized: (message = 'Authentication required', details?: Record<string, unknown>) =>
    new AppError('unauthorized', message, { details }),
  forbidden: (message = 'Not allowed for this principal', details?: Record<string, unknown>) =>
    new AppError('forbidden', message, { details }),
  notFound: (message = 'Resource not found', details?: Record<string, unknown>) =>
    new AppError('not_found', message, { details }),
  conflict: (message = 'Conflicting request', details?: Record<string, unknown>) =>
    new AppError('conflict', message, { details }),
  rateLimited: (message: string, details?: Record<string, unknown>) =>
    new AppError('rate_limited', message, { details }),
  budgetExceeded: (message: string, details?: Record<string, unknown>) =>
    new AppError('budget_exceeded', message, { details }),
  notConfigured: (message: string, details?: Record<string, unknown>) =>
    new AppError('not_configured', message, { details }),
  invalidCursor: (message: string, details?: Record<string, unknown>) =>
    new AppError('invalid_cursor', message, { details }),
  cursorExpired: (message: string, details?: Record<string, unknown>) =>
    new AppError('cursor_expired', message, { details }),
  internal: (message = 'Internal error', details?: Record<string, unknown>) =>
    new AppError('internal_error', message, { details }),
} as const;

/**
 * Redact obviously secret-shaped content from a message before it can reach a
 * client. This is defense in depth; handlers must already emit safe messages.
 */
const SECRETISH_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /sk-[A-Za-z0-9_-]{8,}/g, replacement: '[redacted]' },
  { pattern: /xai-[A-Za-z0-9_-]{8,}/g, replacement: '[redacted]' },
  { pattern: /Bearer\s+[A-Za-z0-9._-]{8,}/gi, replacement: 'Bearer [redacted]' },
  { pattern: /wss:\/\/[^\s"']*[A-Za-z0-9][^\s"']*/g, replacement: 'wss://[redacted]' },
];

export function redact(message: string): string {
  let out = message;
  for (const { pattern, replacement } of SECRETISH_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
