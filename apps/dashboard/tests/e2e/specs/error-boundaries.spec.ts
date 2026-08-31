import { expect, test } from '../helpers/fixtures';
import { captureScreenshot, DASHBOARD_ORIGIN, expectAccessible } from '../helpers/contracts';

const fixtureEnabled = process.env.RAIBITSERVER_E2E_FIXTURES === '1';
const secretMarker = 'T6_E2E_SECRET_SHOULD_NOT_RENDER';
const PUBLIC_HOME_URL = 'http://localhost:3410/';
const CONSOLE_LOGIN_URL = `${DASHBOARD_ORIGIN}/login`;
const LOOPBACK_ORIGIN = 'http://127.0.0.1:3410';

async function expectPublicErrorSurface(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('main#main-content')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(secretMarker);
  await expect(page.locator('body')).not.toContainText(/\bat\s+\w+\s*\(/);
}

async function openGlobalErrorFixture(
  page: import('@playwright/test').Page,
  request: import('@playwright/test').APIRequestContext,
): Promise<void> {
  const arm = await request.get(`${LOOPBACK_ORIGIN}/errors/fixtures/global-error/arm`, {
    headers: { cookie: 'raibitserver_session=fixture-user-populated', host: new URL(DASHBOARD_ORIGIN).host },
    maxRedirects: 0,
  });
  expect(arm.status()).toBe(307);
  expect(arm.headers().location).toMatch(/\/errors\/fixtures\/global-error$/);
  const fixtureCookie = arm.headers()['set-cookie']?.match(/T6_E2E_GLOBAL_ERROR=([^;]+)/)?.[1];
  expect(fixtureCookie).toBe('1');
  await page.context().addCookies([{
    name: 'T6_E2E_GLOBAL_ERROR',
    value: fixtureCookie,
    domain: new URL(DASHBOARD_ORIGIN).hostname,
    path: '/errors/fixtures/global-error',
    httpOnly: true,
    sameSite: 'Strict',
  }]);
  await page.goto('/errors/fixtures/global-error', { waitUntil: 'networkidle' });
}

async function expectKeyboardSkipLink(page: import('@playwright/test').Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'networkidle' });
  await expect.poll(() => page.url()).toBe(url);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const skipLink = page.getByRole('link', { name: '본문으로 건너뛰기' });
  await page.keyboard.press('Tab');
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toHaveAttribute('href', '#main-content');
  await page.keyboard.press('Enter');
  await expect.poll(() => new URL(page.url()).hash).toBe('#main-content');
  await expect(page.locator('main#main-content')).toHaveCount(1);
  await expect(page.locator('#main-content')).toHaveCount(1);
}

test.describe('@t6-error-boundaries', () => {
  test.skip(!fixtureEnabled, 'requires RAIBITSERVER_E2E_FIXTURES=1');

  test('public and auth skip links focus their sole main target', async ({ browser }) => {
    const anonymousContext = await browser.newContext();
    try {
      await expectKeyboardSkipLink(await anonymousContext.newPage(), PUBLIC_HOME_URL);
      await expectKeyboardSkipLink(await anonymousContext.newPage(), CONSOLE_LOGIN_URL);
    } finally {
      await anonymousContext.close();
    }
  });

  test('catalog preview and not-found expose one accessible error landmark', async ({ userPage }, testInfo) => {
    await userPage.goto('/errors/404');
    await expectPublicErrorSurface(userPage);
    await expect(userPage.getByRole('link', { name: /메인으로|다시|로그인|상태/ })).toBeVisible();
    await expectAccessible(userPage);
    await captureScreenshot(userPage, testInfo, 't6-errors-404');

    await userPage.goto('/errors/not-a-real-status');
    await expectPublicErrorSurface(userPage);
    await expect(userPage.getByRole('heading', { name: '요청한 화면을 찾을 수 없습니다' })).toBeVisible();
    await expectAccessible(userPage);
    await captureScreenshot(userPage, testInfo, 't6-not-found');
  });

  test('loading fixture exposes the neutral polite boundary', async ({ userPage }, testInfo) => {
    await userPage.goto('/errors/fixtures/loading', { waitUntil: 'commit' });
    const main = userPage.locator('main#main-content');
    await expect(main).toHaveAttribute('aria-busy', 'true');
    await expect(main.getByRole('heading', { name: '불러오는 중입니다' })).toBeVisible();
    await captureScreenshot(userPage, testInfo, 't6-loading');
  });

  test('injected route and global failures keep recovery controls focusable and sanitized', async ({ userPage, request }, testInfo) => {
    await userPage.goto('/errors/fixtures/route-error');
    await expectPublicErrorSurface(userPage);
    const retry = userPage.getByRole('button', { name: '다시 시도하기' });
    await retry.focus();
    await expect(retry).toBeFocused();
    const support = userPage.getByRole('link', { name: '지원 보기' });
    await userPage.keyboard.press('Tab');
    await expect(support).toBeFocused();
    await expectAccessible(userPage);
    await captureScreenshot(userPage, testInfo, 't6-route-error');

    await openGlobalErrorFixture(userPage, request);
    await expectPublicErrorSurface(userPage);
    await expect(userPage.getByRole('alert')).toBeVisible();
    const globalRetry = userPage.getByRole('button', { name: '다시 시도하기' });
    await globalRetry.focus();
    await expect(globalRetry).toBeFocused();
    const globalSupport = userPage.getByRole('link', { name: '지원 보기' });
    await userPage.keyboard.press('Tab');
    await expect(globalSupport).toBeFocused();
    await expectAccessible(userPage);
    await captureScreenshot(userPage, testInfo, 't6-global-error');
  });
});
