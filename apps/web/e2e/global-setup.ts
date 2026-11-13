import type { FullConfig } from '@playwright/test';

import { apiLogin, saveSession, sessionFilePath } from './support/api';

/**
 * One real sign-in per run.
 *
 * The app keeps its token in `sessionStorage` (a deliberate trade, explained in
 * `src/lib/session.ts`), and Playwright's `storageState` only serialises cookies
 * and `localStorage`. So the "storage state" here is a session record on disk
 * that `support/fixtures.ts` replays into `sessionStorage` before every document
 * — one credential exchange for the whole suite, and every test starts signed in
 * without touching the form.
 *
 * The login form itself stays covered by its own test, which uses the anonymous
 * fixture and no session at all.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const session = await apiLogin();
  await saveSession(sessionFilePath(config.configFile), session);
}
