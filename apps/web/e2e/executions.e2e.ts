import { loadSession, sessionFilePath, WORKSPACE_SLUG } from './support/api';
import {
  attemptsWithDetail,
  executionsPath,
  richestAttempt,
  taskWithAttempts,
  taskWithTrace,
  taskWithoutAttempts,
} from './support/executions';
import { authed as test, expect } from './support/fixtures';
import { openOverview, taskQueues } from './support/overview';

/**
 * The execution detail route — `/[workspace]/tasks/[taskId]`.
 *
 * What is worth asserting here, and why each one is not a tautology:
 *
 * - **The row is the API's row.** The provenance word on screen is compared with
 *   the `simulated` field the API reported, read independently. A badge derived
 *   from anything else — a runtime name, a build flag, a hard-coded `Live` —
 *   fails this.
 * - **The trace is the API's trace.** The timeline item count equals the
 *   `toolInvocations` length for the selected attempt, not a placeholder.
 * - **Integrity is stated in words.** Every artifact row carries a label, so a
 *   failed checksum cannot be a colour-only difference.
 *
 * These run at 1440, 1024, 768 and 390 because the Playwright config defines all
 * four projects; nothing here is viewport-conditional, so a column dropped at
 * 390 must not be one of the four assertions below.
 */

test.describe('Execution detail', () => {
  test('a task title in the Overview opens its execution history', async ({ page }, testInfo) => {
    const session = await loadSession(sessionFilePath(testInfo.config.configFile));
    const taskId = await taskWithAttempts(session);
    expect(taskId, 'the seeded data contains a task with at least one attempt').not.toBeNull();
    if (taskId === null) {
      return;
    }

    await openOverview(page);
    const region = taskQueues(page);

    // The Overview links every task row to its execution history.
    const links = region.locator('tbody a[href*="/tasks/"]');
    await expect(links.first()).toBeVisible();

    const link = region.locator(`a[href$="/tasks/${taskId}"]`).first();
    await expect(link, 'a task with attempts is listed on the Overview').toBeVisible();
    const taskTitle = (await link.textContent())?.trim() ?? '';
    const href = await link.getAttribute('href');
    expect(href).toBe(`/${WORKSPACE_SLUG}/tasks/${taskId}`);

    await link.click();
    await page.waitForURL(`**/tasks/${taskId}`);

    // The h1 is the task, not a generic screen label, and there is exactly one.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(taskTitle);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.locator('.app-page-subtitle')).toContainText('Execution history');

    // The ledger is a table with a caption and column headers.
    const executions = page.getByRole('region', { name: 'Executions' });
    await expect(executions).toBeVisible();
    await expect(executions.getByRole('table')).toBeVisible();
    await expect(executions.locator('caption')).toContainText('newest first');

    // An attempt row exists, and it says Live or Simulated — never a blank.
    const attemptButtons = executions.getByRole('button', { name: /^Attempt \d+ details$/ });
    await expect(attemptButtons.first()).toBeVisible({ timeout: 20_000 });
    const provenance = executions.locator('[data-provenance]');
    await expect(provenance.first()).toBeVisible();
    const words = (await provenance.allInnerTexts()).map((word) =>
      word.replace('Provenance:', '').trim(),
    );
    expect(words.length).toBeGreaterThan(0);
    for (const word of words) {
      expect(['Live', 'Simulated']).toContain(word);
    }
  });

  test('attempt rows are labelled from the API, not from the runtime id', async ({
    page,
  }, testInfo) => {
    const session = await loadSession(sessionFilePath(testInfo.config.configFile));
    const taskId = await taskWithAttempts(session);
    expect(taskId, 'the seeded data contains a task with at least one attempt').not.toBeNull();
    if (taskId === null) {
      return;
    }

    const apiAttempts = await attemptsWithDetail(session, taskId);
    await page.goto(executionsPath(taskId));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });

    const executions = page.getByRole('region', { name: 'Executions' });
    const rows = executions.locator('tbody tr');
    await expect(rows.first()).toBeVisible();

    // Row i of the page is attempt i of the API, newest first.
    expect(apiAttempts.length).toBeGreaterThan(0);
    // Only the rendered rows can be compared: the API may know about more
    // attempts than the page has painted on its first pass.
    await expect(rows).toHaveCount(apiAttempts.length);
    for (const [index, entry] of apiAttempts.entries()) {
      const row = rows.nth(index);
      const expected = entry.attempt.simulated ? 'Simulated' : 'Live';
      // `toContainText`: the badge carries a visually hidden "Provenance: " prefix
      // so the word is never announced without its dimension.
      await expect(row.locator('[data-provenance]')).toContainText(expected);
      await expect(row.locator('[data-provenance]')).toHaveAttribute(
        'data-provenance',
        entry.attempt.simulated ? 'simulated' : 'live',
      );
      // And the attempt number is the API's, not the row index.
      await expect(row.getByRole('button', { name: /^Attempt \d+ details$/ })).toContainText(
        `#${entry.attempt.attemptNumber}`,
      );
    }
  });

  test('the selected attempt renders its tool timeline and artifact integrity', async ({
    page,
  }, testInfo) => {
    const session = await loadSession(sessionFilePath(testInfo.config.configFile));
    const found = await taskWithTrace(session);
    test.skip(found === null, 'no attempt in this workspace recorded both a trace and artifacts');
    if (found === null) {
      return;
    }
    const { taskId, entries } = found;
    const target = richestAttempt(entries);
    expect(target, 'at least one attempt carries a detail').not.toBeNull();
    if (target === null) {
      return;
    }
    // Guaranteed by `taskWithTrace`, so the assertions below are never vacuous.
    expect(target.detail.toolInvocations.length, 'the richest attempt has a trace').toBeGreaterThan(
      0,
    );
    expect(target.detail.artifacts.length, 'the richest attempt has artifacts').toBeGreaterThan(0);

    await page.goto(executionsPath(taskId));
    const choose = page.getByRole('button', {
      name: `Attempt ${target.attempt.attemptNumber} details`,
    });
    await expect(choose).toBeVisible({ timeout: 20_000 });
    await choose.click();

    const detail = page.locator('#attempt-detail');
    await expect(detail.getByRole('heading', { name: /^Attempt/ })).toBeVisible();
    await expect(choose).toHaveAttribute('aria-expanded', 'true');

    // The timeline is an ordered list, and its length is the API's length.
    const timeline = detail.getByRole('list', { name: 'Tool invocations, in sequence' });
    await expect(timeline).toBeVisible();
    await expect(timeline.locator('li')).toHaveCount(target.detail.toolInvocations.length);
    // Sequence, tool and time are all rendered for the first row.
    const first = timeline.locator('li').first();
    const firstInvocation = target.detail.toolInvocations[0];
    expect(firstInvocation).toBeDefined();
    if (firstInvocation !== undefined) {
      await expect(first).toContainText(String(firstInvocation.sequence));
      await expect(first).toContainText(firstInvocation.tool);
      await expect(first.locator('time')).toHaveAttribute('datetime', firstInvocation.occurredAt);
    }

    // Every artifact states its integrity in words plus a glyph.
    const artifacts = detail.getByRole('region', { name: 'Artifacts', exact: true });
    await expect(artifacts).toBeVisible();
    const labels = artifacts.locator('.ex-integrity[data-integrity]');
    await expect(labels).toHaveCount(target.detail.artifacts.length);
    const texts = (await labels.allInnerTexts()).map((text) =>
      text.replace('Integrity:', '').replace(/\s+/g, ' ').trim(),
    );
    for (const text of texts) {
      expect(['Verified', 'Failed', 'Unverified']).toContain(text);
    }
    // The API's own value decides which word is shown.
    for (const [index, artifact] of target.detail.artifacts.entries()) {
      await expect(labels.nth(index)).toHaveAttribute('data-integrity', artifact.integrity);
    }

    // Workspace is either described or explicitly absent — never a silent gap.
    const workspace = detail.getByRole('region', { name: 'Workspace' });
    await expect(workspace).toBeVisible();
    if (target.attempt.workspace === null) {
      await expect(workspace).toContainText('No workspace was provisioned');
    } else {
      await expect(workspace).toContainText('Base commit');
    }
  });

  test('a task with no attempt says so instead of showing zeros', async ({ page }, testInfo) => {
    const session = await loadSession(sessionFilePath(testInfo.config.configFile));
    const taskId = await taskWithoutAttempts(session);
    test.skip(taskId === null, 'the seeded data has no task without an attempt');
    if (taskId === null) {
      return;
    }

    await page.goto(executionsPath(taskId));
    const executions = page.getByRole('region', { name: 'Executions' });
    await expect(executions.getByText('No attempt has been recorded')).toBeVisible({
      timeout: 20_000,
    });
    // No table, no invented rows, and no detail panel to disclose.
    await expect(executions.getByRole('table')).toHaveCount(0);
    await expect(page.locator('#attempt-detail')).toHaveCount(0);
  });

  test('a verified artifact downloads through the authenticated content route', async ({
    page,
  }, testInfo) => {
    const session = await loadSession(sessionFilePath(testInfo.config.configFile));
    const found = await taskWithTrace(session);
    test.skip(found === null, 'no attempt in this workspace recorded artifacts');
    if (found === null) {
      return;
    }
    const target = richestAttempt(found.entries);
    if (target === null) {
      return;
    }
    const verified = target.detail.artifacts.find((artifact) => artifact.integrity === 'verified');
    test.skip(verified === undefined, 'no verified artifact to download');
    if (verified === undefined) {
      return;
    }
    const filename = verified.uri.split('/').filter(Boolean).at(-1) ?? '';

    await page.goto(executionsPath(found.taskId));
    const choose = page.getByRole('button', {
      name: `Attempt ${target.attempt.attemptNumber} details`,
    });
    await expect(choose).toBeVisible({ timeout: 20_000 });
    await choose.click();

    const artifacts = page
      .locator('#attempt-detail')
      .getByRole('region', { name: 'Artifacts', exact: true });
    const downloadButton = artifacts.getByRole('button', { name: `Download ${filename}` });
    await expect(downloadButton).toBeVisible();

    // The bytes come from `GET /artifacts/:id/content` with the bearer token —
    // a plain `<a href>` could not authenticate, so a download here proves the
    // authenticated round trip, not a link.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadButton.click(),
    ]);
    expect(download.suggestedFilename()).toBe(filename);
    expect(await download.failure()).toBeNull();
  });

  test('the page states when its values were read', async ({ page }, testInfo) => {
    const session = await loadSession(sessionFilePath(testInfo.config.configFile));
    const taskId = await taskWithAttempts(session);
    expect(taskId).not.toBeNull();
    if (taskId === null) {
      return;
    }
    await page.goto(executionsPath(taskId));
    const asOf = page.locator('.app-asof');
    await expect(asOf).toContainText('Data as of', { timeout: 20_000 });
    await expect(asOf.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d\d-\d\dT/);
  });
});
