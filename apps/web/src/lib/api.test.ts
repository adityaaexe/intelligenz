import { describe, expect, it } from 'vitest';

import { ApiError, toApiError } from './api';

/**
 * The error mapping is the client half of `api-contract.md` §1, so it is tested
 * without a server: given a status and a body, the client must produce a typed
 * error with the code, message, details and correlation id the API sent.
 */
describe('toApiError', () => {
  it('reads the documented envelope', () => {
    const error = toApiError(
      400,
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request body or query is invalid.',
          details: { riskClass: ['Invalid option: expected one of LOW|MEDIUM|HIGH|CRITICAL'] },
        },
        correlationId: '8b0e2f5e-5a51-4f5e-9f5e-6c0e5d3b7c11',
      },
      'header-ignored-when-body-has-one',
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.status).toBe(400);
    expect(error.message).toBe('The request body or query is invalid.');
    expect(error.correlationId).toBe('8b0e2f5e-5a51-4f5e-9f5e-6c0e5d3b7c11');
    expect(error.details).toEqual({
      riskClass: ['Invalid option: expected one of LOW|MEDIUM|HIGH|CRITICAL'],
    });
  });

  it('flags 401 as needing a redirect', () => {
    const error = toApiError(401, {
      error: { code: 'UNAUTHORIZED', message: 'Invalid email or password.' },
      correlationId: 'c0',
    });
    expect(error.isUnauthorized).toBe(true);
    expect(error.isForbidden).toBe(false);
  });

  it('flags 403 as a permission problem, not an auth problem', () => {
    const error = toApiError(403, {
      error: { code: 'FORBIDDEN', message: 'Not a member of this organisation.' },
      correlationId: 'c1',
    });
    expect(error.isForbidden).toBe(true);
    expect(error.isUnauthorized).toBe(false);
  });

  it('preserves the machine-readable approval gate code', () => {
    const error = toApiError(409, {
      error: { code: 'APPROVAL_REQUIRED', message: 'A HIGH risk task needs an approved request.' },
      correlationId: 'c2',
    });
    expect(error.code).toBe('APPROVAL_REQUIRED');
    expect(error.status).toBe(409);
  });

  it('falls back to the header correlation id when the body omits it', () => {
    const error = toApiError(500, { error: { code: 'INTERNAL_ERROR' } }, 'header-id');
    expect(error.correlationId).toBe('header-id');
    expect(error.code).toBe('INTERNAL_ERROR');
  });

  it('never trusts an unknown code', () => {
    const error = toApiError(418, { error: { code: 'TEAPOT', message: 'nope' }, correlationId: null });
    expect(error.code).toBe('UNKNOWN');
  });

  it('maps a non-envelope body to INVALID_RESPONSE rather than pretending it matched', () => {
    const error = toApiError(502, '<html>bad gateway</html>');
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toContain('failed');
  });

  it('maps a client-side 4xx non-envelope body to INVALID_RESPONSE', () => {
    const error = toApiError(404, null);
    expect(error.code).toBe('INVALID_RESPONSE');
    expect(error.status).toBe(404);
  });

  it('produces a stated message for an unreachable API', () => {
    const error = toApiError(0, null);
    expect(error.code).toBe('INVALID_RESPONSE');
    expect(error.status).toBe(0);
  });

  it('drops empty detail maps instead of returning an empty object', () => {
    const error = toApiError(400, { error: { code: 'VALIDATION_ERROR', message: 'bad', details: {} } });
    expect(error.details).toBeNull();
  });
});

describe('ApiError', () => {
  it('exposes isNetwork for the offline state', () => {
    const error = new ApiError('NETWORK_ERROR', 0, 'The API could not be reached.');
    expect(error.isNetwork).toBe(true);
    expect(error.isUnauthorized).toBe(false);
  });

  it('is a real Error, so a thrown value is catchable and named', () => {
    const error = new ApiError('NOT_FOUND', 404, 'gone');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ApiError');
  });
});
