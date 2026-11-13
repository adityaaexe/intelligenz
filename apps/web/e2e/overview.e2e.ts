import type { Project, Task } from '../src/lib/types';
import { apiGet, authorizationFor, loadSession, scopeOf, sessionFilePath } from './support/api';
import { authed as test, expect } from './support/fixtures';
import { KNOWN_TASK_STATUSES, openOverview, taskQueues } from './support/overview';

/**
 * What the Overview is allowed to claim.
 *
 * Each test here checks a different promise from `docs/engineering/PHASE-2-CONTRACT.md`
 * §15 A6: rows come from the API, regions with no source say so, and the
 * document has one landmark tree rather than content floating outside it.
 */

test.describe('Overview', () => {
  test('Task queues renders rows whose values come from the API', async ({ page }, testInfo) => {
    await openOverview(page);
    const region = taskQueues(page);

    // Independent source of truth: the same token, the same routes the page
    // calls, read by the test rather than by the component under test.
    const session = await loadSession(sessionFilePath(testInfo.config.configFile));
    const { orgId, workspaceId } = scopeOf(session);
    const headers = authorizationFor(session);
    const projects = await apiGet<readonly Project[]>(
      `/v1/orgs/${orgId}/workspaces/${workspaceId}/projects`,
      headers,
    );
    const projectId = projects[0]?.id;
    expect(projectId, 'the seeded workspace has at least one project').toBeDefined();
    const apiTasks = await apiGet<readonly Task[]>(
      // The same limit the screen asks for (`ApiClient.listTasks` defaults to 100).
      `/v1/orgs/${orgId}/projects/${String(projectId)}/tasks?limit=100`,
      headers,
    );
    expect(apiTasks.length, 'the seeded project has tasks').toBeGreaterThan(0);

    // Rows: a header plus at least one task, and never more rows than the list
    // endpoint returns — a table that shows more than the API has would be
    // inventing rows. (Not exact equality: the page reads before this test does,
    // so a task created in between would legitimately make the API count larger.)
    const rows = region.getByRole('row');
    await expect(rows.first()).toBeVisible();
    const dataRows = (await rows.count()) - 1;
    expect(dataRows).toBeGreaterThan(0);
    expect(dataRows).toBeLessThanOrEqual(apiTasks.length);

    // Every rendered row is one of the API's tasks. This is the assertion a
    // fixture-backed table cannot pass.
    const rowTexts = await region.locator('tbody tr').allInnerTexts();
    expect(rowTexts).toHaveLength(dataRows);
    for (const text of rowTexts) {
      const isRealTask = apiTasks.some((task) => text.includes(task.title));
      expect(isRealTask, `a rendered row is not one of the API's tasks: ${text.slice(0, 60)}`).toBe(
        true,
      );
    }

    // Every rendered status is a wire status, and every row has one.
    const statuses = await region
      .locator('tbody .iz-pill__label')
      .evaluateAll((elements) =>
        elements.map((element) => (element.textContent ?? '').replace('Status:', '').trim()),
      );
    expect(statuses).toHaveLength(dataRows);
    for (const status of statuses) {
      expect(KNOWN_TASK_STATUSES).toContain(status);
    }

    // And the newest task the API knows about is on screen.
    const newest = apiTasks[0];
    expect(newest).toBeDefined();
    await expect(region.getByText(newest?.title ?? '', { exact: true }).first()).toBeVisible();

    // And the page states when those values were read.
    const asOf = page.locator('.app-asof');
    await expect(asOf).toContainText('Data as of');
    await expect(asOf.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d\d-\d\dT/);
  });

  test('regions with no source say "Not instrumented" instead of inventing data', async ({
    page,
  }) => {
    await openOverview(page);

    for (const name of ['Active workflows', 'Recent decisions']) {
      const region = page.getByRole('region', { name });
      await expect(region).toBeVisible();
      await expect(region.getByText('Not instrumented')).toBeVisible();
      await expect(region.getByText(/Missing source:/)).toBeVisible();
    }
  });

  test('every piece of page content sits inside a landmark', async ({ page }) => {
    await openOverview(page);

    await expect(page.locator('main')).toHaveCount(1);
    await expect(page.locator('nav[aria-label="Primary"]')).toHaveCount(1);
    await expect(page.getByRole('banner')).toHaveCount(1);
    await expect(page.getByRole('complementary')).toHaveCount(1);

    /*
     * The `region` rule of axe, without the dependency: walk every element that
     * carries its own text and require a landmark ancestor. A skip link is
     * exempt (that is axe's own exception), as is the inert scrim. This is the
     * check that fails if the scope bar, or anything else, ever drifts back
     * outside `main`.
     */
    const unlandmarked = await page.evaluate(() => {
      const landmarks = [
        'main',
        'header',
        'nav',
        'aside',
        'section[aria-labelledby]',
        '[role="banner"]',
        '[role="main"]',
        '[role="navigation"]',
        '[role="complementary"]',
        '[role="region"]',
        '[role="contentinfo"]',
        '[role="search"]',
      ].join(', ');

      // Elements whose text is not rendered text. axe ignores these too; the
      // Next.js flight payload lives in inline `<script>` text and is not content.
      const inert = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'TITLE']);

      const offenders: string[] = [];
      for (const element of Array.from(document.body.querySelectorAll('*'))) {
        if (inert.has(element.tagName)) {
          continue;
        }
        const ownText = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => (node.textContent ?? '').trim())
          .join(' ')
          .trim();
        if (ownText.length === 0) {
          continue;
        }
        if (element.closest(landmarks) !== null) {
          continue;
        }
        if (element.closest('a[href^="#"]') !== null) {
          continue;
        }
        if (element.closest('.app-scrim') !== null) {
          continue;
        }
        offenders.push(
          `${element.tagName.toLowerCase()}.${element.className} :: ${ownText.slice(0, 48)}`,
        );
      }
      return offenders;
    });

    expect(unlandmarked).toEqual([]);
  });
});
