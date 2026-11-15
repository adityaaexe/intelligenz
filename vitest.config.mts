import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/**/*.{test,spec}.{ts,tsx}', 'packages/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/coverage/**'],
    passWithNoTests: true,
    // The worker integration suites start a real Temporal worker in `beforeAll`, and the
    // first one to run compiles the workflow bundle with webpack (~5 s, then cached). The
    // 10 s default turned that start-up into "Hook timed out" and every test in the file
    // was *skipped* — which reads as a pass in a summary line and asserts nothing. 60 s is
    // the value `apps/api/vitest.config.mts` already uses for the same class of hook; a
    // hook that genuinely hangs still fails, it just takes a minute to say so.
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/*.test.ts', '**/*.config.*'],
    },
  },
});
