import { describe, expect, it } from 'vitest';
import { AppError, Errors, redact } from '../../src/errors.js';

describe('stable error classes', () => {
  it('maps each failure class to its stable code and status', () => {
    expect(Errors.validation('bad')).toMatchObject({ code: 'validation_failed', httpStatus: 400 });
    expect(Errors.unauthorized()).toMatchObject({ code: 'unauthorized', httpStatus: 401 });
    expect(Errors.forbidden()).toMatchObject({ code: 'forbidden', httpStatus: 403 });
    expect(Errors.notFound()).toMatchObject({ code: 'not_found', httpStatus: 404 });
    expect(Errors.conflict()).toMatchObject({ code: 'conflict', httpStatus: 409 });
    expect(Errors.rateLimited('slow down')).toMatchObject({ code: 'rate_limited', httpStatus: 429 });
    expect(Errors.budgetExceeded('over budget')).toMatchObject({ code: 'budget_exceeded', httpStatus: 402 });
    expect(Errors.notConfigured('provider missing')).toMatchObject({ code: 'not_configured', httpStatus: 501 });
    expect(Errors.invalidCursor('bad cursor')).toMatchObject({ code: 'invalid_cursor', httpStatus: 400 });
    expect(Errors.cursorExpired('too old')).toMatchObject({ code: 'cursor_expired', httpStatus: 410 });
    expect(Errors.internal()).toMatchObject({ code: 'internal_error', httpStatus: 500 });
  });

  it('never includes secrets or provider URLs in redacted messages', () => {
    expect(redact('dial failed with key sk-abcdef1234567890')).toBe('dial failed with key [redacted]');
    expect(redact('connect to wss://api.x.ai/v1/realtime?model=grok-voice-3.0&token=abc123')).toBe(
      'connect to wss://[redacted]',
    );
    expect(redact('auth header was Bearer eyJhbGciOi.abc.def')).toBe('auth header was Bearer [redacted]');
  });

  it('keeps safe details on the envelope', () => {
    const err = Errors.notConfigured('provider missing', { provider: 'instabox' });
    expect(err.details).toEqual({ provider: 'instabox' });
    expect(err).toBeInstanceOf(AppError);
  });
});
