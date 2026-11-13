import { authed as test, expect } from './support/fixtures';
import { openOverview } from './support/overview';

/**
 * Navigation is the shell's own promise: the sidebar routes, and the route it
 * lands on tells the truth about the module being unbuilt.
 */

test('Approvals in the primary navigation routes to the module and names it', async ({ page }) => {
  await openOverview(page);

  // The shell is a drawer below 768 (DESIGN.md §9): the control that opens it is
  // the only way in at 390, so the test opens it the way a phone user would.
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }

  const primary = page.getByRole('navigation', { name: 'Primary' });
  await primary.getByRole('link', { name: 'Approvals' }).click();

  await page.waitForURL('**/approvals', { timeout: 20_000 });

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Approvals');
  await expect(page.getByText('Approvals is not implemented in Phase 2.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'What exists today' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Overview' })).toBeVisible();

  // The nav agrees with the URL about where the operator is.
  await expect(primary.getByRole('link', { name: 'Approvals' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});
