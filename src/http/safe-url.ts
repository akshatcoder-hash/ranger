/**
 * Safe serialization of request URLs for logs and error payloads.
 *
 * Connection tickets are short-lived secrets carried as a query parameter
 * on WebSocket upgrades. Fastify's request serializer covers fields logged
 * as `req`, but framework and plugin calls also put the raw URL on the log
 * object itself (`path`, `url`) or inside a message. Header redaction does
 * not touch those strings. Both the API and the preview gateway share this
 * helper so a ticket never appears in an info log or an unknown-route body.
 */

const REDACTED_QUERY_VALUE = '[redacted]';

/** Query parameter names whose values are credentials, not request metadata. */
const SECRET_QUERY_NAMES = new Set(['ticket']);

function redactSearch(search: string): string {
  if (search === '' || search === '?') return search;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  let changed = false;
  for (const name of [...params.keys()]) {
    if (!SECRET_QUERY_NAMES.has(name.toLowerCase())) continue;
    const count = params.getAll(name).length;
    params.delete(name);
    for (let i = 0; i < count; i += 1) params.append(name, REDACTED_QUERY_VALUE);
    changed = true;
  }
  if (!changed) return search.startsWith('?') ? search : `?${search}`;
  const rendered = params.toString();
  return rendered === '' ? '' : `?${rendered}`;
}

/**
 * Redact credential query values in a request URL or in a message that
 * embeds one. The path, method and non-secret query parameters stay so
 * logs remain useful. Malformed query text falls back to stripping any
 * `ticket=` assignment rather than echoing the raw value.
 */
export function redactRequestUrl(url: string): string {
  const queryAt = url.indexOf('?');
  if (queryAt < 0) return url;
  const pathPart = url.slice(0, queryAt);
  const search = url.slice(queryAt);
  let redacted: string;
  try {
    redacted = `${pathPart}${redactSearch(search)}`;
  } catch {
    redacted = url;
  }
  // Defense in depth for messages that embed a ticket assignment the parser
  // did not treat as a parameter (truncated or mixed prose).
  return redacted.replace(/([?&]ticket=)[^&#\s]*/gi, `$1${encodeURIComponent(REDACTED_QUERY_VALUE)}`);
}

/**
 * Copy a log merging object and redact only its top-level `path` and `url`.
 *
 * @fastify/websocket `noHandle` logs `{ path: rawRequest.url }` on the parent
 * logger, which never runs the `req` serializer. Fastify's own 404 and reply
 * warnings also interpolate `request.url` / `raw.url` into the message.
 * Nested objects stay untouched so the `req` serializer and header redaction
 * remain the only writers of those fields.
 */
export function redactTopLevelUrlFields(args: unknown[]): unknown[] {
  const head = args[0];
  if (head === null || typeof head !== 'object' || Array.isArray(head)) return args;
  const record = head as Record<string, unknown>;
  let next: Record<string, unknown> | undefined;
  for (const key of ['path', 'url'] as const) {
    const value = record[key];
    if (typeof value !== 'string' || !value.includes('?')) continue;
    const redacted = redactRequestUrl(value);
    if (redacted === value) continue;
    next ??= { ...record };
    next[key] = redacted;
  }
  if (next === undefined) return args;
  return [next, ...args.slice(1)];
}

/** Redact ticket assignments that a log message interpolated from a raw URL. */
export function redactLogMessage(message: unknown): unknown {
  if (typeof message !== 'string' || !message.toLowerCase().includes('ticket=')) return message;
  return redactRequestUrl(message);
}

/** Structural request fields the serializer actually reads. */
export interface SafeRequestLogInput {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  headers?: Record<string, unknown>;
  socket?: { remotePort?: number };
}

/** Fastify/pino request serializer fields, with the URL made safe to log. */
export function safeRequestLogFields(req: SafeRequestLogInput): {
  method: string | undefined;
  url: string;
  version: string | undefined;
  host: string | undefined;
  remoteAddress: string | undefined;
  remotePort: number | undefined;
} {
  const version = req.headers?.['accept-version'];
  return {
    method: req.method,
    url: redactRequestUrl(req.url ?? ''),
    version: typeof version === 'string' ? version : undefined,
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

/**
 * Logger options shared by the API and the preview gateway.
 * The serializer accepts Fastify's request object; only url/method/host are read.
 * The log hook also redacts top-level path/url fields and ticket assignments
 * in messages, which the req serializer never sees. Header redaction stays.
 */
export function secretSafeLoggerOptions(level: string): {
  level: string;
  redact: { paths: string[]; censor: string };
  serializers: {
    req: (req: {
      method?: string;
      url?: string;
      host?: string;
      ip?: string;
      headers?: Record<string, unknown>;
      socket?: { remotePort?: number };
    }) => ReturnType<typeof safeRequestLogFields>;
  };
  hooks: {
    logMethod: (args: unknown[], method: (...methodArgs: unknown[]) => void) => void;
  };
} {
  return {
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'req.headers["idempotency-key"]',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req: (req) => safeRequestLogFields(req),
    },
    hooks: {
      logMethod(args, method) {
        const [merging, message, ...rest] = redactTopLevelUrlFields(args);
        method.apply(this, [merging, redactLogMessage(message), ...rest]);
      },
    },
  };
}
