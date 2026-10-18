import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { getRegistry, ROUTE_FAMILIES, declaredEventTypes } from '../../src/contracts/registry.js';
import { buildOpenApiDocument } from '../../src/contracts/openapi.js';
import { renderClientSource, renderOpenApiDoc, renderEventSchemaFiles } from '../../src/contracts/generate.js';
import { CONTRACT_EXAMPLES } from '../../src/contracts/examples.js';
import { EVENT_ENVELOPE_SCHEMA, EVENT_SCHEMA_VERSION, eventSchemaBundle } from '../../src/contracts/events.js';

function makeAjv(): Ajv {
  return new Ajv({ strict: false, validateFormats: false, allErrors: true });
}
describe('v1 contract registry', () => {
  it('declares operations for every approved route family', () => {
    const registry = getRegistry();
    for (const family of ROUTE_FAMILIES) {
      const ops = registry.filter((op) => op.family === family);
      expect(ops.length, `family ${family} has no declared operations`).toBeGreaterThan(0);
    }
  });

  it('has unique operation ids and paths per method', () => {
    const registry = getRegistry();
    const ids = new Set(registry.map((op) => op.id));
    expect(ids.size).toBe(registry.length);
    const methodPaths = new Set(registry.map((op) => `${op.method} ${op.path}`));
    expect(methodPaths.size).toBe(registry.length);
  });

  it('declares response schemas that carry the requestId', () => {
    for (const op of getRegistry()) {
      if (op.ws === true) continue;
      if (op.id === 'getOpenApiDocument') continue; // raw document, not an envelope
      const props = (op.response?.properties ?? {}) as Record<string, unknown>;
      expect(props['requestId'], `${op.id} response must carry requestId`).toBeDefined();
    }
  });
});

describe('openapi document', () => {
  it('checked-in copy equals the served document', () => {
    const checkedIn = readFileSync(new URL('../../contracts/openapi.json', import.meta.url), 'utf8');
    expect(renderOpenApiDoc()).toBe(checkedIn);
  });

  it('is OpenAPI 3.1 with every registry operation present', () => {
    const doc = buildOpenApiDocument() as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
      info: { version: string };
    };
    expect(doc.openapi).toBe('3.1.0');
    for (const op of getRegistry()) {
      const pathItem = doc.paths[op.path];
      if (pathItem === undefined) throw new Error(`missing path ${op.path}`);
      expect(pathItem[op.method], `missing ${op.method} ${op.path}`).toBeDefined();
    }
  });

  it('declares the shared error envelope for every operation', () => {
    const doc = buildOpenApiDocument() as Record<string, unknown>;
    const paths = doc['paths'] as Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> }>>;
    for (const [pathKey, pathItem] of Object.entries(paths)) {
      for (const [method, methodDocUntyped] of Object.entries(pathItem)) {
        const methodDoc = methodDocUntyped as { responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> };
        const responses = methodDoc.responses ?? {};
        for (const errorStatus of ['400', '401', '500', '501']) {
          const schema = responses[errorStatus]?.content?.['application/json']?.schema;
          expect(schema?.$ref, `${errorStatus} envelope on ${method} ${pathKey}`).toBe(
            '#/components/schemas/ErrorEnvelope',
          );
        }
      }
    }
  });
});

describe('typed client generation', () => {
  it('generated client source matches the checked-in file', () => {
    const checkedIn = readFileSync(new URL('../../src/clients/ranger-client.ts', import.meta.url), 'utf8');
    expect(renderClientSource()).toBe(checkedIn);
  });

  it('exposes one method per declared operation (including WebSocket openers)', () => {
    const source = renderClientSource();
    for (const op of getRegistry()) {
      if (op.ws === true) {
        const opener = `open${op.id.charAt(0).toUpperCase()}${op.id.slice(1)}(`;
        expect(source.includes(opener), `missing ws opener ${opener}`).toBe(true);
      } else {
        expect(source.includes(`async ${op.id}(`), `missing client method ${op.id}`).toBe(true);
      }
    }
  });
});

describe('event schemas', () => {
  it('checked-in event schema files match generation', () => {
    for (const file of renderEventSchemaFiles()) {
      const checkedIn = readFileSync(new URL(`../../${file.path}`, import.meta.url), 'utf8');
      expect(file.contents).toBe(checkedIn);
    }
  });

  it('a synthesized event validates against the envelope schema', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(EVENT_ENVELOPE_SCHEMA);
    const event = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: 'evt_0e2f6c9a-1111-4c3d-9f4e-2b7c5d1a3f10',
      projectId: 'prj_0e2f6c9a-2222-4c3d-9f4e-2b7c5d1a3f10',
      runId: null,
      sessionId: null,
      timestamp: '2026-10-18T12:00:00.000Z',
      sequence: 0,
      requestId: 'req-abc',
      type: 'project.updated',
      data: { engineerDisplayName: 'Ranger' },
    };
    expect(validate(event)).toBe(true);
    expect(validate({ ...event, sequence: -1 })).toBe(false);
    expect(validate({ ...event, extraField: 1 })).toBe(false);
  });

  it('serves a bundle enumerating every declared event type', () => {
    const bundle = eventSchemaBundle();
    expect(bundle.eventTypes.map((t) => t.name)).toEqual([...declaredEventTypes()]);
  });
});

describe('contract examples', () => {
  it('validate against their own declared schemas', () => {
    const ajv = makeAjv();
    const registry = getRegistry();
    for (const example of CONTRACT_EXAMPLES) {
      const op = registry.find((candidate) => candidate.id === example.operationId);
      expect(op, `unknown operation ${example.operationId}`).toBeDefined();
      const schema = example.kind === 'request' ? op?.body : op?.response;
      expect(schema, `${example.kind} example for ${example.operationId} has no schema`).toBeDefined();
      const validate = ajv.compile(schema as Record<string, unknown>);
      const valid = validate(example.payload);
      expect(
        valid,
        `example ${example.description} for ${example.operationId}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
    }
  });

  it('cover every route family with at least one example', () => {
    const registry = getRegistry();
    const coveredFamilies = new Set(
      CONTRACT_EXAMPLES.map((example) => registry.find((op) => op.id === example.operationId)?.family),
    );
    for (const family of ROUTE_FAMILIES) {
      expect(coveredFamilies.has(family), `no example for family ${family}`).toBe(true);
    }
  });
});
