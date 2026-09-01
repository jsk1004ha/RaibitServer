import { expect, test } from '../helpers/fixtures';
import {
  captureScreenshot,
  expectAccessible,
  expectRoute,
  nativeFormData,
  observeBrowserErrors,
} from '../helpers/contracts';

const fixtureEnabled = process.env.RAIBITSERVER_E2E_FIXTURES === '1';
const fixtureOrigin = 'http://127.0.0.1:3410';

async function expectNoOverflow(page: import('@playwright/test').Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth)).toBe(true);
}

async function selectTheme(page: import('@playwright/test').Page, preference: 'light' | 'dark', label: '라이트' | '다크'): Promise<void> {
  const trigger = page.locator('[data-slot="theme-utility"]').getByRole('button', { name: /테마 설정: 현재/ });
  await expect(trigger).toHaveCount(1);
  await trigger.focus();
  await page.keyboard.press('Enter');
  const choice = page.getByRole('menuitemradio', { name: label });
  await choice.click();
  await expect(choice).toBeHidden();
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe(preference);
}

async function openGlobalErrorFixture(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext): Promise<void> {
  const arm = await request.get(`${fixtureOrigin}/errors/fixtures/global-error/arm`, {
    headers: { cookie: 'raibitserver_session=fixture-user-populated', host: 'console.localhost:3410' },
    maxRedirects: 0,
  });
  expect(arm.status()).toBe(307);
  expect(arm.headers().location).toMatch(/\/errors\/fixtures\/global-error$/);
  const fixtureCookie = arm.headers()['set-cookie']?.match(/T6_E2E_GLOBAL_ERROR=([^;]+)/)?.[1];
  expect(fixtureCookie).toBe('1');
  await page.context().addCookies([
    { name: 'raibitserver_session', value: 'fixture-user-populated', domain: 'console.localhost', path: '/', httpOnly: true, sameSite: 'Lax' },
    { name: 'T6_E2E_GLOBAL_ERROR', value: fixtureCookie, domain: 'console.localhost', path: '/errors/fixtures/global-error', httpOnly: true, sameSite: 'Strict' },
  ]);
  expect((await page.context().cookies('http://console.localhost:3410/errors/fixtures/global-error')).map((cookie) => cookie.name)).toEqual(expect.arrayContaining(['raibitserver_session', 'T6_E2E_GLOBAL_ERROR']));
  await page.goto('/errors/fixtures/global-error', { waitUntil: 'commit', timeout: 5_000 });
}

async function disableThemeStorage(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'raibit-theme') throw new DOMException('Storage disabled', 'SecurityError');
      return getItem.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'raibit-theme') throw new DOMException('Storage disabled', 'SecurityError');
      return setItem.call(this, key, value);
    };
  });
}

function observeGlobalErrorBrowserErrors(page: import('@playwright/test').Page): () => void {
  const unexpected: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.includes('500 (Internal Server Error)') || text.includes('An error occurred in the Server Components render') || text.includes('404 (Not Found)')) return;
    unexpected.push(`console:${text}`);
  });
  page.on('pageerror', (error) => unexpected.push(`page:${error.message}`));
  page.on('requestfailed', (requestEvent) => unexpected.push(`request:${requestEvent.url()}:${requestEvent.failure()?.errorText || 'failed'}`));
  return () => expect(unexpected, unexpected.join('\n')).toEqual([]);
}

test.describe('@todo6-auth-error-theme', () => {
  test.skip(!fixtureEnabled, 'requires RAIBITSERVER_E2E_FIXTURES=1');
  test.setTimeout(30_000);

  test('login preserves form submission and uses separate desktop brand surfaces across the required theme matrix', async ({ page }, testInfo) => {
    const assertNoErrors = observeBrowserErrors(page);
    const scenarios = [
      { viewport: { width: 375, height: 812 }, preference: 'dark' as const, label: '다크' as const },
      { viewport: { width: 768, height: 1024 }, preference: 'dark' as const, label: '다크' as const },
      { viewport: { width: 1280, height: 800 }, preference: 'dark' as const, label: '다크' as const },
      { viewport: { width: 1280, height: 800 }, preference: 'light' as const, label: '라이트' as const },
    ];

    for (const scenario of scenarios) {
      await page.setViewportSize(scenario.viewport);
      await page.goto('/login?next=%2Forg%2Fraibit%2Fprojects', { waitUntil: 'networkidle' });
      await selectTheme(page, scenario.preference, scenario.label);
      await expect(page.getByRole('heading', { level: 1, name: '콘솔에 로그인' })).toHaveCount(1);
      await expectAccessible(page);
      await expectNoOverflow(page);
      if (scenario.viewport.width === 1280) {
        await expect(page.locator('main > section').first()).toHaveCSS(
          'background-color',
          scenario.preference === 'dark' ? 'rgb(11, 29, 58)' : 'rgb(9, 25, 54)',
        );
      }
      await captureScreenshot(page, testInfo, `todo6-login-${scenario.preference}-${scenario.viewport.width}`);
    }

    await page.goto('/login?next=%2Forg%2Fraibit%2Fprojects', { waitUntil: 'networkidle' });
    await page.getByLabel('이메일').fill('user@fixture.test');
    await page.getByLabel('비밀번호').fill('fixture-user-pass');
    expect(await nativeFormData(page, 'form.auth-form')).toEqual([
      ['_returnTo', '/org/raibit/projects'],
      ['email', 'user@fixture.test'],
      ['password', 'fixture-user-pass'],
    ]);
    await page.getByLabel('비밀번호').press('Enter');
    await expectRoute(page, '/org/raibit/projects', { notice: 'saved' });
    assertNoErrors();
  });

  test('global error keeps one accessible recovery menu when storage is unavailable and restores a valid cookie after hydration', async ({ browser, request }, testInfo) => {
    const storageDisabledContext = await browser.newContext();
    const storageDisabledPage = await storageDisabledContext.newPage();
    const assertNoStorageErrors = observeGlobalErrorBrowserErrors(storageDisabledPage);
    await disableThemeStorage(storageDisabledPage);
    try {
      await test.step('storage-disabled global error renders after its armed session and cookie', async () => {
        await storageDisabledPage.setViewportSize({ width: 375, height: 812 });
        await openGlobalErrorFixture(storageDisabledPage, request);
        await expect(storageDisabledPage.getByRole('alert')).toHaveCount(1);
        await expect(storageDisabledPage.locator('html')).toHaveAttribute('data-theme', 'system');
        await expect(storageDisabledPage.getByRole('button', { name: /테마 설정: 현재/ })).toHaveCount(1);
        await expect(storageDisabledPage.getByRole('heading', { level: 1 })).toHaveCount(1);
      });
      await test.step('storage-disabled recovery controls remain usable and accessible', async () => {
        const retry = storageDisabledPage.getByRole('button', { name: '다시 시도하기' });
        await retry.focus();
        await expect(retry).toBeFocused();
        await expect(retry).toBeVisible();
        await expect(storageDisabledPage.getByRole('link', { name: '지원 보기' })).toBeVisible();
        await expectAccessible(storageDisabledPage);
        await expectNoOverflow(storageDisabledPage);
        await captureScreenshot(storageDisabledPage, testInfo, 'todo6-global-error-system-storage-disabled-375');
      });
      assertNoStorageErrors();
    } finally {
      await storageDisabledContext.close();
    }

    const cookieContext = await browser.newContext();
    const cookiePage = await cookieContext.newPage();
    const assertNoCookieErrors = observeGlobalErrorBrowserErrors(cookiePage);
    try {
      await test.step('valid cookie restores the dark global-error menu after hydration', async () => {
        await cookieContext.addCookies([{ name: 'raibit-theme', value: 'dark', domain: 'console.localhost', path: '/', sameSite: 'Lax' }]);
        await cookiePage.setViewportSize({ width: 1280, height: 800 });
        await openGlobalErrorFixture(cookiePage, request);
        await expect.poll(() => cookiePage.locator('html').getAttribute('data-theme')).toBe('dark');
        await expect(cookiePage.getByRole('button', { name: '테마 설정: 현재 다크' })).toHaveCount(1);
        await expect(cookiePage.getByRole('heading', { level: 1 })).toHaveCount(1);
        await expectAccessible(cookiePage);
        await expectNoOverflow(cookiePage);
        await captureScreenshot(cookiePage, testInfo, 'todo6-global-error-dark-cookie-1280');
      });
      assertNoCookieErrors();
    } finally {
      await cookieContext.close();
    }
  });
});
