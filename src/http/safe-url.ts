/**
 * Safe serialization of request URLs for logs and error payloads.
 *
 * Connection tickets are short-lived secrets carried as a query parameter
 * on WebSocket upgrades. Fastify's default request serializer copies
 * `req.url` verbatim, and header redaction does not touch that string.
 * Both the API and the preview gateway must share this helper so a ticket
 * never appears in an info log or an unknown-route body.
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
  };
}
