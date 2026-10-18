import { describe, expect, it } from 'vitest';
import { redactRequestUrl, redactTopLevelUrlFields, safeRequestLogFields } from '../../src/http/safe-url.js';

const TICKET = 'tkt_unit-secret-value-must-not-appear';
const CURSOR = 'eyJ2IjoxLCJzZXEiOjF9';

describe('safe request URL serialization', () => {
  it('redacts ticket query values and keeps path, method and non-secret query', () => {
    const raw = `/v1/projects/prj_1/events/subscribe?ticket=${TICKET}&cursor=${CURSOR}`;
    const redacted = redactRequestUrl(raw);
    expect(redacted).toContain('/v1/projects/prj_1/events/subscribe');
    expect(redacted).toContain('ticket=%5Bredacted%5D');
    expect(redacted).toContain(`cursor=${encodeURIComponent(CURSOR)}`);
    expect(redacted).not.toContain(TICKET);

    const fields = safeRequestLogFields({
      method: 'GET',
      url: raw,
      host: '127.0.0.1:3908',
      ip: '127.0.0.1',
    });
    expect(fields.method).toBe('GET');
    expect(fields.url).toBe(redacted);
    expect(fields.host).toBe('127.0.0.1:3908');
    expect(JSON.stringify(fields)).not.toContain(TICKET);
  });

  it('redacts repeated and encoded ticket parameters without dropping the path', () => {
    const encoded = encodeURIComponent(TICKET);
    const raw = `/v1/no-such?ticket=${encoded}&ticket=${TICKET}&other=keep`;
    const redacted = redactRequestUrl(raw);
    expect(redacted.startsWith('/v1/no-such?')).toBe(true);
    expect(redacted).toContain('other=keep');
    expect(redacted).not.toContain(TICKET);
    expect(redacted).not.toContain(encoded);
    expect(redacted.match(/ticket=%5Bredacted%5D/g)?.length).toBe(2);
  });

  it('redacts ticket values embedded in error text and leaves ordinary URLs intact', () => {
    const message = `No route for GET /missing?ticket=${TICKET}&cursor=1`;
    expect(redactRequestUrl(message)).not.toContain(TICKET);
    expect(redactRequestUrl(message)).toContain('/missing');
    expect(redactRequestUrl('/health')).toBe('/health');
    expect(redactRequestUrl('/v1/projects?limit=10')).toBe('/v1/projects?limit=10');
  });

  it('redacts top-level path and url fields without touching unrelated bindings', () => {
    const raw = `/health?ticket=${TICKET}&cursor=${CURSOR}`;
    const merging = [{ path: raw, url: raw, reqId: 'keep', nested: { path: raw } }, 'closed incoming websocket connection'];
    const redacted = redactTopLevelUrlFields(merging);
    const fields = redacted[0] as { path: string; url: string; reqId: string; nested: { path: string } };
    expect(fields.path).toContain('/health');
    expect(fields.path).toContain('ticket=%5Bredacted%5D');
    expect(fields.path).toContain(`cursor=${encodeURIComponent(CURSOR)}`);
    expect(fields.url).toBe(fields.path);
    expect(fields.reqId).toBe('keep');
    expect(fields.nested.path).toBe(raw);
    expect(redacted[1]).toBe(merging[1]);
    expect(JSON.stringify(redacted).includes(TICKET)).toBe(true);
    expect(fields.path.includes(TICKET)).toBe(false);
    expect(fields.url.includes(TICKET)).toBe(false);
  });
});
