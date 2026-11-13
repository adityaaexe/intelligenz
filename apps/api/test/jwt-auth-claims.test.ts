import { type ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { AppError } from '../src/common/errors';
import type { ApiRequest } from '../src/common/request-context';
import { type AppConfig } from '../src/config/app-config';
import { JwtAuthGuard, REQUIRED_ACCESS_TOKEN_CLAIMS } from '../src/auth/jwt-auth.guard';

/**
 * Claim requirements on the access token.
 *
 * `algorithms` alone verifies *who signed* the token. It says nothing about
 * whether the token can expire, so a correctly signed token without `exp` was
 * accepted for ever — the Low that turns any leaked signing key (Fix 1) into a
 * permanent credential.
 */

const SECRET = 'Kq7-tR2#vLm9!pXz4w8@nB3yS6';
const USER_ID = '4bc8b01a-5e41-5dab-8559-43edc720a061';

const config: AppConfig = {
  nodeEnv: 'test',
  port: 4100,
  host: '127.0.0.1',
  databaseUrl: 'postgresql://unused/unused',
  jwtSecret: SECRET,
  jwtTtlSeconds: 900,
  logLevel: 'silent',
  corsOrigins: [],
  temporal: { address: 'localhost:7233', namespace: 'default', taskQueue: 'intelligenz-tasks' },
  readinessTimeoutMs: 2_000,
  artifactRoot: '/tmp/intelligenz-test-artifacts',
  workspaceRoot: '/tmp/intelligenz-test-workspaces',
};

/** Signs without the module's default `expiresIn`, so the payload is exact. */
function signer(): JwtService {
  return new JwtService({ secret: SECRET, signOptions: { algorithm: 'HS256' } });
}

function contextFor(token: string): { context: ExecutionContext; request: ApiRequest } {
  const request: ApiRequest = {
    correlationId: 'corr-1',
    headers: { authorization: `Bearer ${token}` },
    params: {},
    method: 'GET',
    url: '/v1/orgs',
  };

  const context = {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  return { context, request };
}

async function authenticate(token: string): Promise<ApiRequest> {
  const guard = new JwtAuthGuard(new Reflector(), signer(), config);
  const { context, request } = contextFor(token);

  await guard.canActivate(context);

  return request;
}

async function refusal(token: string): Promise<AppError> {
  const guard = new JwtAuthGuard(new Reflector(), signer(), config);
  const { context } = contextFor(token);

  try {
    await guard.canActivate(context);
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }

  throw new Error('the guard accepted a token it should have rejected');
}

describe('JwtAuthGuard — required claims', () => {
  it('declares exp, iat and sub as required', () => {
    expect(REQUIRED_ACCESS_TOKEN_CLAIMS).toEqual(['exp', 'iat', 'sub']);
  });

  it('accepts a fully-formed token and attaches the identity', async () => {
    const token = await signer().signAsync(
      { sub: USER_ID, email: 'owner@northwind.test' },
      { expiresIn: 900 },
    );

    const request = await authenticate(token);

    expect(request.auth).toEqual({ userId: USER_ID, email: 'owner@northwind.test' });
  });

  it('rejects a correctly signed token with no exp claim', async () => {
    // Signed with the real secret — the signature is valid, the token is not.
    const token = await signer().signAsync({
      sub: USER_ID,
      email: 'owner@northwind.test',
      iat: Math.floor(Date.now() / 1000),
    });

    const error = await refusal(token);

    expect(error.status).toBe(401);
    expect(error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a correctly signed token with no iat claim', async () => {
    // `noTimestamp` is what actually omits `iat`; signing without it always adds
    // one, which is why the first version of this test passed for the wrong reason.
    const token = await signer().signAsync(
      { sub: USER_ID, email: 'owner@northwind.test', exp: Math.floor(Date.now() / 1000) + 900 },
      { noTimestamp: true },
    );

    expect((await refusal(token)).status).toBe(401);
  });

  it('rejects a correctly signed token with no sub claim', async () => {
    const token = await signer().signAsync({ email: 'owner@northwind.test' }, { expiresIn: 900 });

    expect((await refusal(token)).status).toBe(401);
  });

  it('rejects a token whose iat is older than the 900s TTL even with a far-future exp', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signer().signAsync({
      sub: USER_ID,
      email: 'owner@northwind.test',
      iat: now - 901,
      exp: now + 86_400,
    });

    expect((await refusal(token)).status).toBe(401);
  });

  it('rejects a token signed with a different key', async () => {
    const foreign = new JwtService({
      secret: 'a-different-key-that-is-long-enough-1234',
      signOptions: { algorithm: 'HS256' },
    });
    const token = await foreign.signAsync(
      { sub: USER_ID, email: 'owner@northwind.test' },
      { expiresIn: 900 },
    );

    expect((await refusal(token)).status).toBe(401);
  });
});
