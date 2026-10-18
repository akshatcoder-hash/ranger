import { getRegistry, FAMILY_DESCRIPTIONS, ROUTE_FAMILIES, type OperationDef } from './registry.js';
import { errorEnvelopeSchema } from './schema.js';
import { EVENT_ENVELOPE_SCHEMA, EVENT_SCHEMA_VERSION } from './events.js';

/**
 * OpenAPI 3.1 document builder. Both the generator (checked-in copy) and the
 * live server route use this exact function, so the served document and the
 * checked-in document cannot drift.
 */

export const OPENAPI_VERSION = '3.1.0';
export const CONTRACT_INFO_VERSION = '1.0.0';

const ERROR_STATUS_CODES = [400, 401, 403, 404, 409, 402, 429, 501, 500] as const;

function securityFor(op: OperationDef): Array<Record<string, string[]>> | undefined {
  switch (op.auth) {
    case 'principal':
      return [{ bearerApiToken: [] }, { browserSession: [] }];
    case 'connection-ticket':
      return [{ connectionTicket: [] }];
    default:
      return undefined;
  }
}

function toOpenApiPath(path: string): string {
  return path; // registry already uses {param} placeholders
}

function toFastifyPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ':$1');
}

export function toFastifyPathFor(op: OperationDef): string {
  return toFastifyPath(op.path);
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const registry = getRegistry();
  const paths: Record<string, Record<string, unknown>> = {};

  for (const op of registry) {
    const url = toOpenApiPath(op.path);
    const entry = paths[url] ?? {};

    const parameters: Array<Record<string, unknown>> = [];
    if (op.params !== undefined) {
      const props = (op.params.properties ?? {}) as Record<string, { description?: string }>;
      for (const name of (op.params.required as string[]) ?? []) {
        parameters.push({
          name,
          in: 'path',
          required: true,
          schema: props[name] ?? { type: 'string' },
        });
      }
    }
    if (op.querystring !== undefined) {
      const props = (op.querystring.properties ?? {}) as Record<string, { description?: string; default?: unknown }>;
      for (const [name, schema] of Object.entries(props)) {
        parameters.push({ name, in: 'query', required: ((op.querystring.required as string[]) ?? []).includes(name), schema });
      }
    }
    if (op.mutating) {
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        schema: { type: 'string' },
        description: 'Scoped idempotency key: identical retries return the stored result; reuse with different input conflicts.',
      });
    }

    const methodDoc: Record<string, unknown> = {
      operationId: op.id,
      summary: op.summary,
      tags: [op.family],
      description: op.ws
        ? `${op.summary}. WebSocket upgrade: authenticate with a single-use connection ticket, then receive ordered replayable events.`
        : op.summary,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(op.body !== undefined ? { requestBody: { required: true, content: { 'application/json': { schema: op.body } } } } : {}),
      ...(securityFor(op) !== undefined ? { security: securityFor(op) } : {}),
      responses: {
        ...(op.ws
          ? {
              101: { description: 'Switching protocols (WebSocket upgrade accepted)' },
            }
          : {
              200: {
                description: 'Success (envelope carries requestId)',
                content:
                  op.response !== undefined
                    ? { 'application/json': { schema: op.response } }
                    : undefined,
              },
            }),
        ...Object.fromEntries(
          ERROR_STATUS_CODES.map((status) => [
            status,
            {
              description: {
                400: 'Validation failed or invalid cursor',
                401: 'Unauthorized',
                402: 'Budget admission stop',
                403: 'Forbidden',
                404: 'Not found',
                409: 'Conflict (including idempotency conflict)',
                429: 'Rate limited',
                501: 'Not configured / not yet implemented',
                500: 'Internal error',
              }[status],
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
            },
          ]),
        ),
      },
    };
    if (op.ws) {
      methodDoc['x-websocket'] = true;
      methodDoc['schemes'] = ['ws', 'wss'];
    }
    if (op.gateway) {
      methodDoc['x-preview-gateway'] = true;
      methodDoc['description'] = `${String(methodDoc['description'])} Served from the preview gateway origin (default http://127.0.0.1:3101), separate from the control-service cookie origin.`;
    }
    entry[op.method] = methodDoc;
    paths[url] = entry;
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Ranger API',
      version: CONTRACT_INFO_VERSION,
      description:
        'Ranger backend v1 contract: every declared frontend operation across all route families. ' +
        'Routes whose provider is not yet implemented return an explicit not_configured (501) envelope — never fake success.',
    },
    servers: [
      { url: 'http://127.0.0.1:3100', description: 'Control API' },
      { url: 'http://127.0.0.1:3101', description: 'Preview gateway' },
    ],
    'x-ranger-contract': {
      contractVersion: 'v1',
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
      families: ROUTE_FAMILIES.map((family) => ({ family, description: FAMILY_DESCRIPTIONS[family] })),
    },
    components: {
      securitySchemes: {
        bearerApiToken: { type: 'http', scheme: 'bearer', description: 'Hashed, revocable API token' },
        browserSession: { type: 'apiKey', in: 'cookie', name: 'ranger_session', description: 'Revocable browser session; mutations require CSRF/origin protection' },
        connectionTicket: { type: 'apiKey', in: 'query', name: 'ticket', description: 'Short-lived single-use ticket bound to principal, project and purpose' },
      },
      schemas: {
        ErrorEnvelope: errorEnvelopeSchema(),
        RangerProjectEvent: EVENT_ENVELOPE_SCHEMA,
      },
    },
    paths,
  };
}
