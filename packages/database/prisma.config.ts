import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 central configuration.
 *
 * Prisma 7 no longer reads `.env` on its own and no longer accepts a `url` in the
 * schema's datasource block. `dotenv` is not installed, so this file uses Node 22's
 * built-in `process.loadEnvFile`, which does not override variables already present
 * in the environment — so `DATABASE_URL=... pnpm prisma ...` still wins over `.env`.
 *
 * The file is found by walking up from the working directory: `pnpm --filter
 * @intelligenz/database` runs with cwd = this package, while a manually invoked
 * CLI from the repo root also finds the same root `.env`.
 */
function loadNearestEnvFile(): void {
  let directory = process.cwd();

  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = resolve(directory, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }

    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

loadNearestEnvFile();

/**
 * `prisma migrate` needs a database. Point it at the integration-test database with
 * `PRISMA_TARGET=test pnpm db:migrate:test` and the same config serves both.
 *
 * The URL is deliberately allowed to be absent: `prisma generate` does not connect
 * to anything, and `pnpm -w typecheck` must work in CI without a database or a
 * `.env` file. Commands that do need a connection report the missing variable.
 */
const targetVariable =
  process.env['PRISMA_TARGET'] === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
const url = process.env[targetVariable];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url,
    // `prisma migrate dev` creates a temporary shadow database; this role has no
    // CREATEDB privilege, so a dedicated one is provisioned by bootstrap. `migrate
    // deploy` ignores this. Optional: a role that can create databases needs no
    // SHADOW_DATABASE_URL at all.
    shadowDatabaseUrl: process.env['SHADOW_DATABASE_URL'],
  },
});
