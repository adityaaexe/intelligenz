import { defineConfig } from 'vitest/config';

/**
 * API test configuration.
 *
 * `fileParallelism: false` because every suite truncates the same test database. The
 * suite helper also takes a Postgres advisory lock, so the guarantee holds even when
 * the workspace root config runs these files in parallel — but serialising here keeps
 * the usual path from ever hitting that lock.
 */
export default defineConfig({
  test: {
    environment: 'node',
    // `*.e2e-spec.ts`, not `*.test.ts`: the workspace root config collects
    // `*.{test,spec}.ts`, and these suites truncate the shared `intelligenz_test`
    // database. Running them inside the root `pnpm -w test` would race
    // `packages/database`'s integration tests, which assert global row counts on the
    // same database. Contract §12 keeps them separate — this is gate 4.
    include: ['**/*.e2e-spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    fileParallelism: false,
    // Argon2 verification, a dozen HTTP round trips and a 2 s readiness budget add up.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
