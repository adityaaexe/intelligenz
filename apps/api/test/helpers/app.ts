import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Connection } from '@temporalio/client';
import request from 'supertest';

import { createApplication } from '../../src/app.factory';
import { loadConfig, type AppConfig } from '../../src/config/app-config';
import { acquireSuiteLock, createTestClient, resetDatabase, truncateAll, type Fixtures } from './database';
import { jwtSecret, optionalEnv, testDatabaseUrl } from './env';
import type { PrismaClient } from '@intelligenz/database';

/**
 * Builds the real application for a test, with two substitutions: the test database
 * and a silent logger. Everything else — guards, filter, middleware, validation — is
 * the pipeline `main.ts` runs. A test that assembles its own module graph proves the
 * test works, not the app.
 */
export async function createTestApp(overrides: Partial<AppConfig> = {}): Promise<INestApplication> {
  const config: AppConfig = {
    ...loadConfig(),
    databaseUrl: testDatabaseUrl(),
    jwtSecret: jwtSecret(),
    nodeEnv: 'test',
    logLevel: 'silent',
    ...overrides,
  };

  const app = await createApplication(config);
  await app.init();

  return app;
}

export interface Suite {
  readonly app: INestApplication;
  readonly prisma: PrismaClient;
  readonly fixtures: Fixtures;
  close(): Promise<void>;
}

/**
 * One suite = the database lock, a clean fixture set, and a booted app.
 *
 * The lock is released only after `app.close()` and `$disconnect()`, so a following
 * suite cannot truncate rows this one is still reading.
 */
export async function startSuite(options: { appOverrides?: Partial<AppConfig> } = {}): Promise<Suite> {
  const release = await acquireSuiteLock();
  const prisma = createTestClient();

  try {
    const fixtures = await resetDatabase(prisma);
    const app = await createTestApp(options.appOverrides);

    return {
      app,
      prisma,
      fixtures,
      async close(): Promise<void> {
        await app.close();
        // Leave the shared test database empty rather than full of fixtures. Other
        // packages' integration tests assert global row counts on this database, and
        // a leftover user row is enough to fail them.
        await truncateAll(prisma);
        await prisma.$disconnect();
        await release();
      },
    };
  } catch (error) {
    await prisma.$disconnect();
    await release();
    throw error;
  }
}

export const PASSWORD = 'Passw0rd!demo';

interface LoginBody {
  data: { accessToken: string; expiresIn: number; user: { id: string; email: string } };
}

/** Logs in through the HTTP endpoint: the token is issued by the code under test. */
export async function login(
  app: INestApplication,
  email: string,
  password: string = PASSWORD,
): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/v1/auth/login')
    .send({ email, password });

  if (response.status !== 200) {
    throw new Error(
      `login failed for ${email} with ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }

  return (response.body as LoginBody).data.accessToken;
}

export function authHeaders(token: string, orgId?: string): Record<string, string> {
  return orgId === undefined
    ? { authorization: `Bearer ${token}` }
    : { authorization: `Bearer ${token}`, 'x-org-id': orgId };
}

export interface TemporalProbe {
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * Honest reachability check, used to decide whether a test can run at all. A test
 * that needs Temporal must skip *with the reason* when it is not there — a silent
 * pass would be worse than no test.
 */
export async function probeTemporal(address?: string): Promise<TemporalProbe> {
  const target = address ?? optionalEnv('TEMPORAL_ADDRESS') ?? 'localhost:7233';
  const connection = Connection.lazy({ address: target, connectTimeout: 1_500 });

  try {
    await connection.ensureConnected();
    return { ok: true, reason: `reachable at ${target}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unreachable';
    return { ok: false, reason: `Temporal not reachable at ${target} (${detail})` };
  } finally {
    await connection.close().catch(() => undefined);
  }
}
