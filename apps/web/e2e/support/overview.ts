import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

import { OVERVIEW_PATH } from './api';

/**
 * Shared navigation for the authenticated specs.
 *
 * Every test that asserts something about the Overview has to wait for the
 * page's own data pass to land, because the screen renders skeletons first and
 * fills in from the API afterwards. Waiting on a data row rather than a timeout
 * is what keeps these tests about the app instead of about the machine.
 */
export function taskQueues(page: Page) {
  return page.getByRole('region', { name: 'Task queues' });
}

export async function openOverview(page: Page): Promise<void> {
  await page.goto(OVERVIEW_PATH);
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(taskQueues(page).getByRole('row').nth(1)).toBeVisible({ timeout: 20_000 });
}

/** The status vocabulary the API writes and the UI must render verbatim. */
export const KNOWN_TASK_STATUSES: readonly string[] = [
  'Draft',
  'Ready',
  'Queued',
  'Running',
  'Verifying',
  'Completed',
  'Failed',
  'Blocked',
  'Cancelled',
  'Timed out',
];
