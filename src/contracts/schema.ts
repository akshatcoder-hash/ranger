/**
 * Tiny JSON Schema builder helpers. All contract schemas are plain JSON
 * Schema objects (validated at runtime by Fastify/AJV and emitted verbatim
 * into the generated OpenAPI document by scripts/generate-contracts.ts).
 */

export type JSONSchema = Record<string, unknown>;

export const str = (opts: JSONSchema = {}): JSONSchema => ({ type: 'string', ...opts });
export const int = (opts: JSONSchema = {}): JSONSchema => ({ type: 'integer', ...opts });
export const num = (opts: JSONSchema = {}): JSONSchema => ({ type: 'number', ...opts });
export const bool = (opts: JSONSchema = {}): JSONSchema => ({ type: 'boolean', ...opts });
export const arr = (items: JSONSchema, opts: JSONSchema = {}): JSONSchema => ({
  type: 'array',
  items,
  ...opts,
});
export const obj = (
  required: string[],
  properties: Record<string, JSONSchema>,
  opts: JSONSchema = {},
): JSONSchema => ({ type: 'object', required, properties, additionalProperties: false, ...opts });
export const nullable = (schema: JSONSchema): JSONSchema => ({
  anyOf: [schema, { type: 'null' }],
});
export const oneOf = (...schemas: JSONSchema[]): JSONSchema => ({ oneOf: schemas });

/** IDs are prefixed by resource kind; keeps identifiers self-describing. */
export const idField = (prefix: string): JSONSchema =>
  str({ pattern: `^${prefix}_[0-9a-fA-F-]+$`, description: `Prefixed ${prefix} identifier` });

/** Timestamps are ISO 8601 strings. */
export const timestamp = (): JSONSchema => str({ format: 'date-time' });

/**
 * Standard 2xx envelope: every success response carries the requestId echoed
 * from the request (injected centrally by the API preSerialization hook).
 */
export const okResponse = (
  properties: Record<string, JSONSchema> = {},
  required: string[] = [],
): JSONSchema => ({
  type: 'object',
  required: ['requestId', ...required],
  properties: { requestId: str(), ...properties },
});

/** Shared error envelope schema (also embedded in the OpenAPI document). */
export const errorEnvelopeSchema = (): JSONSchema =>
  obj(
    ['requestId', 'error'],
    {
      requestId: str({ description: 'Unique per-request identifier' }),
      error: obj(
        ['code', 'message'],
        {
          code: str({
            description: 'Stable error class code, e.g. validation_failed',
          }),
          message: str({ description: 'Safe, human-readable message' }),
          details: obj([], {}, { description: 'Safe structured details', additionalProperties: true }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  );

/** Cursor pagination query for list/replay surfaces. HTTP query values are strings. */
export const cursorQuery = (): JSONSchema =>
  obj([], {
    cursor: str({ description: 'Opaque cursor from a previous page' }),
    limit: str({ pattern: '^[0-9]{1,4}$', description: 'Page size between 1 and 500 (default 100)' }),
  });

/** Standard headers accepted on mutating routes (permissive: HTTP always sends more). */
export const mutationHeaders = (): JSONSchema =>
  obj([], {
    'idempotency-key': str({ description: 'Scoped idempotency key for safe retries' }),
  }, { additionalProperties: true });
