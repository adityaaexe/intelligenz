import { loadNearestEnvFile } from '../../src/config/load-env';

/**
 * Test bootstrap environment.
 *
 * `.env` is loaded from the repository root, the same way `main.ts` does it, so the
 * suite reads the same `JWT_SECRET` and `TEMPORAL_*` values the dev server uses.
 * `loadEnvFile` does not override variables that are already set, so a CI run can
 * provide them directly.
 */
loadNearestEnvFile();

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();

  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * Two guards on the test database, because a suite that truncates the wrong database
 * is worse than a failing test:
 *   1. it reads `TEST_DATABASE_URL`, never `DATABASE_URL`;
 *   2. it refuses to run unless that database name ends in `_test`.
 */
export function testDatabaseUrl(): string {
  const url = optionalEnv('TEST_DATABASE_URL');

  if (url === undefined) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Integration tests need a dedicated *_test database.',
    );
  }

  const databaseName = new URL(url).pathname.replace(/^\//, '');

  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run API tests against "${databaseName}": TEST_DATABASE_URL must name a *_test database.`,
    );
  }

  return url;
}

export function jwtSecret(): string {
  const secret = optionalEnv('JWT_SECRET');

  if (secret === undefined || secret.length < 32) {
    throw new Error('JWT_SECRET must be set (32+ characters) for the API test suite.');
  }

  return secret;
}
