import { authed as test, expect } from './support/fixtures';
import { openOverview } from './support/overview';

/**
 * Reflow: at 390 the page must not scroll sideways (WCAG 1.4.10, and the reason
 * the task table has its own bounded scroll container rather than widening the
 * document).
 *
 * Measured only under the 390 project; the assertion is about that width, so
 * repeating it at 1440 would prove nothing.
 */
test('Overview does not scroll horizontally at 390px', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-390', 'measured at the 390px project only');

  expect(page.viewportSize()?.width, 'the 390 project really is 390 wide').toBe(390);

  await openOverview(page);

  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
  }));

  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
});
