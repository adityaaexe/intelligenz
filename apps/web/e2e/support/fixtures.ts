import { expect } from '@playwright/test';
import { test as base } from '@playwright/test';

import { SESSION_STORAGE_KEY } from '../../src/lib/session';
import { loadSession, sessionFilePath } from './api';

/**
 * `test` is anonymous — a fresh context with empty storage. Use it for anything
 * that is about the signed-out state (the auth gate, the login form).
 *
 * `authed` is the same test with the session replayed into `sessionStorage`
 * before any of the app's own scripts run. `addInitScript` is the only hook that
 * lands before hydration: setting storage after `goto` would race the shell's
 * `useEffect`, which redirects to `/login` the moment it sees no session.
 */
export { expect, base as test };

export const authed = base.extend({
  page: async ({ page }, use, testInfo) => {
    const session = await loadSession(sessionFilePath(testInfo.config.configFile));
    await page.addInitScript(
      ({ key, value }) => {
        window.sessionStorage.setItem(key, value);
      },
      { key: SESSION_STORAGE_KEY, value: JSON.stringify(session) },
    );
    await use(page);
  },
});
