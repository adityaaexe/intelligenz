import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Environment loading without `dotenv`.
 *
 * Node 22 ships `process.loadEnvFile`, which behaves like `--env-file`: it does not
 * override variables that are already set. That precedence is the one we want —
 * an explicit `DATABASE_URL=... pnpm ...` beats the local `.env`, and CI never
 * needs a file at all.
 *
 * Prisma 7 stopped loading `.env` itself, so the CLI config and the seed both call
 * this. Library code does not: importing `@intelligenz/database` must never mutate
 * the process environment as a side effect.
 */
export function loadNearestEnvFile(startDirectory: string = process.cwd()): void {
  let directory = resolve(startDirectory);

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

/**
 * Reads a connection string, failing loudly instead of letting Prisma report a
 * confusing connection error later.
 */
export function readDatabaseUrl(variable = 'DATABASE_URL'): string {
  const url = process.env[variable];

  if (!url) {
    throw new Error(
      `${variable} is not set. Copy .env.example to .env at the repository root, ` +
        'or export the variable for this command.',
    );
  }

  return url;
}
