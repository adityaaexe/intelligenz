import { authed as test, expect } from './support/fixtures';
import { openOverview } from './support/overview';

/**
 * REVIEW-CHECKLIST §2.1.1: the skip link is the first `Tab` stop, it becomes
 * visible on focus, and activating it moves focus to `<main>`.
 */

test('the first Tab reaches the skip link, which moves focus into main', async ({ page }) => {
  await openOverview(page);

  // Start from the document, not from whatever the last click left focused.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await page.keyboard.press('Tab');

  const skip = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skip).toBeFocused();

  // Visible means on screen, not merely in the accessibility tree: the link is
  // translated out of the viewport until it has focus.
  const box = await skip.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);

  await page.keyboard.press('Enter');

  await expect(page.locator('main#main')).toBeFocused();
  // And the focus landed inside the content, not on a wrapper above it.
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
});
