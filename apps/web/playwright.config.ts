import { defineConfig, devices } from '@playwright/test';

/**
 * E2E configuration for the control centre.
 *
 * Port 3100, never 3000 (contract §15 A1: 3000 is another product's live
 * backend).
 *
 * The suite runs against a real stack: the API on 4100, a seeded Postgres, and
 * Temporal — it does not mock the network, because the things worth asserting
 * here (that a number on screen exists in the database) cannot be asserted
 * against a mock. `globalSetup` signs in once and writes the session that every
 * test replays; see `e2e/support/fixtures.ts` for why that is a file rather than
 * Playwright's `storageState`.
 */
export default defineConfig({
  testDir: './e2e',
  /*
   * `.e2e.ts`, not `.spec.ts`: the root Vitest project collects
   * `apps/**\/*.{test,spec}.ts` (`vitest.config.mts`) and a Playwright spec in
   * that glob fails the unit-test gate on import. Two runners, two suffixes.
   */
  testMatch: '**/*.e2e.ts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: process.env.CI === 'true',
  retries: process.env.CI === 'true' ? 2 : 0,
  reporter: process.env.CI === 'true' ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium-1440',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'chromium-1024',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 900 } },
    },
    {
      name: 'chromium-768',
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 900 } },
    },
    {
      name: 'chromium-390',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: 'pnpm --filter @intelligenz/web start',
    url: 'http://localhost:3100/login',
    reuseExistingServer: process.env.CI !== 'true',
    timeout: 120_000,
  },
});
