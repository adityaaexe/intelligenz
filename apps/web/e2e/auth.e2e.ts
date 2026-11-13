import { CREDENTIALS, OVERVIEW_PATH } from './support/api';
import { expect, test } from './support/fixtures';

/**
 * The signed-out paths. These run with the anonymous fixture: no session is
 * seeded, so what they see is what a cold browser sees.
 */

test.describe('authentication', () => {
  test('an unauthenticated deep link to Overview is redirected to the login form', async ({
    page,
  }) => {
    await page.goto(OVERVIEW_PATH);

    await page.waitForURL(/\/login/, { timeout: 20_000 });
    const url = new URL(page.url());

    expect(url.pathname).toBe('/login');
    // The redirect remembers where the operator was going, and only that.
    expect(url.searchParams.get('next')).toBe(OVERVIEW_PATH);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    // Nothing from the control centre leaked into the signed-out page.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('INTELLIGENZ');
    expect(await page.getByRole('navigation').count()).toBe(0);
  });

  test('valid credentials reach the Overview, which has exactly one h1 reading "Overview"', async ({
    page,
  }) => {
    await page.goto('/login');

    await page.getByLabel('Email').fill(CREDENTIALS.email);
    await page.getByLabel('Password').fill(CREDENTIALS.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.waitForURL(`**${OVERVIEW_PATH}`, { timeout: 20_000 });

    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toHaveCount(1);
    await expect(h1).toHaveText('Overview');
  });

  test('a rejected sign-in stays on /login and never discloses whether the email exists', async ({
    page,
  }) => {
    await page.goto('/login');
    const banner = page.locator('.iz-banner__title');
    const submitButton = page.getByRole('button', { name: 'Sign in' });

    const attempt = async (email: string, password: string): Promise<number> => {
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill(password);
      const answered = page.waitForResponse(
        (response) =>
          response.url().endsWith('/v1/auth/login') && response.request().method() === 'POST',
      );
      await submitButton.click();
      const response = await answered;
      await expect(banner).toBeVisible();
      return response.status();
    };

    // A password long enough to pass validation, so the API answers 401 and not
    // a 400 that would tell the caller the email got past validation.
    const knownEmailStatus = await attempt(CREDENTIALS.email, 'DefinitelyNotThePassword1!');
    const knownEmailMessage = await banner.textContent();

    expect(knownEmailStatus).toBe(401);
    expect(knownEmailMessage).toBe('That email and password did not match an account.');
    expect(new URL(page.url()).pathname).toBe('/login');

    const unknownEmailStatus = await attempt(
      `missing-${Date.now().toString(36)}@northwind.test`,
      'DefinitelyNotThePassword1!',
    );
    const unknownEmailMessage = await banner.textContent();

    expect(unknownEmailStatus).toBe(401);
    // Byte-identical: the page cannot distinguish the two cases, because the API
    // does not either (api-contract.md §4).
    expect(unknownEmailMessage).toBe(knownEmailMessage);
    expect(new URL(page.url()).pathname).toBe('/login');

    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(
      /no such (email|account|user)|unknown (email|account|user)|not registered|email does not exist|could not find (an|your) account/i,
    );
  });
});
