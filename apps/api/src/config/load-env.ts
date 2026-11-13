import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Loads the nearest `.env`, walking up from the working directory.
 *
 * `packages/database` has the same helper internally but does not export it, and this
 * unit may not modify that package. `process.loadEnvFile` (Node 22) does not override
 * variables that are already set, which is the precedence we want: an explicit
 * `DATABASE_URL=... pnpm ...` beats the file, and CI needs no file at all.
 *
 * Only `main.ts` and the test bootstrap call this. Library code must not mutate the
 * process environment as an import side effect.
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
