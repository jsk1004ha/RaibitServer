import { expect, test } from '../helpers/fixtures';
import {
  CONSOLE_ORIGIN,
  contrastRatio,
  DARK_ALIASES,
  expectThemeAgreement,
  expectThemeSurface,
  observeThemeErrors,
  prepareTheme,
  PUBLIC_ORIGIN,
  readAliases,
  saveThemeScreenshot,
  THEME_EVIDENCE_DIRECTORY,
  THEME_VIEWPORTS,
  type ThemePreference,
} from '../helpers/theme-contracts';

const fixtureEnabled = process.env.RAIBITSERVER_E2E_FIXTURES === '1';
const globalErrorArm = 'http://127.0.0.1:3410/errors/fixtures/global-error/arm';

test.describe('@theme semantic integration', () => {
  test.skip(!fixtureEnabled || !THEME_EVIDENCE_DIRECTORY, 'requires fixture and evidence directory');
  test.setTimeout(120_000);

  test('captures the exact 24-row theme matrix with accessibility and layout contracts', async ({ browser, request }) => {
    const rows = [
      ...THEME_VIEWPORTS.flatMap((viewport) => ([
        { origin: PUBLIC_ORIGIN, path: '/', preference: 'light', viewport, placement: 'public', name: `theme-home-light-${viewport.width}` },
        { origin: PUBLIC_ORIGIN, path: '/', preference: 'dark', viewport, placement: 'public', name: `theme-home-dark-${viewport.width}` },
      ] as const)),
      ...THEME_VIEWPORTS.map((viewport) => ({ origin: CONSOLE_ORIGIN, path: '/login', preference: 'dark', viewport, placement: 'login', name: `theme-login-dark-${viewport.width}` } as const)),
      { origin: CONSOLE_ORIGIN, path: '/login', preference: 'light', viewport: THEME_VIEWPORTS[2], placement: 'login', name: 'theme-login-light-1280' },
      ...THEME_VIEWPORTS.map((viewport) => ({ origin: CONSOLE_ORIGIN, path: '/console', preference: 'dark', viewport, placement: 'console', name: `theme-console-dark-${viewport.width}`, authenticated: true } as const)),
      { origin: CONSOLE_ORIGIN, path: '/console', preference: 'light', viewport: THEME_VIEWPORTS[2], placement: 'console', name: 'theme-console-light-1280', authenticated: true },
      ...(['/status', '/contributors'] as const).flatMap((path) => ([THEME_VIEWPORTS[0], THEME_VIEWPORTS[2]].map((viewport) => ({ origin: PUBLIC_ORIGIN, path, preference: 'dark', viewport, placement: 'public', name: `theme-${path.slice(1)}-dark-${viewport.width}` } as const)))),
      ...([THEME_VIEWPORTS[0], THEME_VIEWPORTS[2]] as const).map((viewport) => ({ origin: CONSOLE_ORIGIN, path: '/errors/fixtures/global-error', preference: 'dark', viewport, placement: 'error', name: `theme-global-error-dark-${viewport.width}`, authenticated: true, globalError: true } as const)),
      ...([THEME_VIEWPORTS[0], THEME_VIEWPORTS[2]] as const).map((viewport) => ({ origin: PUBLIC_ORIGIN, path: '/', preference: 'system', colorScheme: 'light', viewport, placement: 'public', name: `theme-home-system-light-${viewport.width}` } as const)),
      ...([THEME_VIEWPORTS[0], THEME_VIEWPORTS[2]] as const).map((viewport) => ({ origin: CONSOLE_ORIGIN, path: '/console', preference: 'system', colorScheme: 'dark', viewport, placement: 'console', name: `theme-console-system-dark-${viewport.width}`, authenticated: true } as const)),
    ] as const;
    expect(rows).toHaveLength(24);

    for (const row of rows) {
      await test.step(row.name, async () => {
        const context = await browser.newContext({ viewport: row.viewport, colorScheme: 'colorScheme' in row ? row.colorScheme : 'light' });
        if ('authenticated' in row) await context.addCookies([{ name: 'raibitserver_session', value: 'fixture-user-populated', domain: 'console.localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
        const page = await context.newPage();
        const assertNoErrors = observeThemeErrors(page, 'globalError' in row);
        try {
          await prepareTheme(page, row.origin, row.preference);
          if ('globalError' in row) {
            const arm = await request.get(globalErrorArm, { headers: { cookie: 'raibitserver_session=fixture-user-populated', host: 'console.localhost:3410' }, maxRedirects: 0 });
            const fixtureCookie = arm.headers()['set-cookie']?.match(/T6_E2E_GLOBAL_ERROR=([^;]+)/)?.[1];
            expect(arm.status()).toBe(307);
            expect(fixtureCookie).toBe('1');
            await context.addCookies([{ name: 'T6_E2E_GLOBAL_ERROR', value: fixtureCookie ?? '', domain: 'console.localhost', path: row.path, httpOnly: true, sameSite: 'Strict' }]);
          }
          await page.goto(`${row.origin}${row.path}`, { waitUntil: 'networkidle' });
          await expectThemeAgreement(page, row.preference);
          await expectThemeSurface(page, row.placement);
          await saveThemeScreenshot(page, row.name);
          assertNoErrors();
        } finally {
          await context.close();
        }
      });
    }
  });

  test('proves radio keyboard, direct selection, persistence, and same-document synchronization', async ({ browser }) => {
    const context = await browser.newContext({ viewport: THEME_VIEWPORTS[1] });
    await context.addCookies([{ name: 'raibitserver_session', value: 'fixture-user-populated', domain: 'console.localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    const assertNoErrors = observeThemeErrors(page);
    try {
      await prepareTheme(page, CONSOLE_ORIGIN, 'system');
      await page.goto('/primitives-fixture', { waitUntil: 'networkidle' });
      const triggers = page.locator('[data-theme-menu-fixture] button[aria-label^="테마 설정: 현재"]');
      await expect(triggers).toHaveCount(2);
      await triggers.first().focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menuitemradio', { name: '시스템' })).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await expectThemeAgreement(page, 'light');
      await expect(triggers.first()).toBeFocused();
      await expect(triggers.nth(1)).toHaveAttribute('aria-label', '테마 설정: 현재 라이트');
      await triggers.nth(1).click();
      const lightChoice = page.getByRole('menuitemradio', { name: '라이트' });
      await expect(lightChoice).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(lightChoice).toBeHidden();
      await expect(triggers.nth(1)).toBeFocused();
      for (const [preference, label] of [['dark', '다크'], ['system', '시스템'], ['light', '라이트']] as const) {
        await triggers.first().click();
        await page.getByRole('menuitemradio', { name: label }).click();
        await expectThemeAgreement(page, preference);
      }
      await page.reload({ waitUntil: 'networkidle' });
      await expectThemeAgreement(page, 'light');
      await page.goto('/console', { waitUntil: 'networkidle' });
      await expectThemeAgreement(page, 'light');
      assertNoErrors();
    } finally {
      await context.close();
    }
  });

  test('synchronizes two tabs and refreshes the receiving host-only cookie', async ({ browser }) => {
    const context = await browser.newContext({ viewport: THEME_VIEWPORTS[2] });
    await context.addCookies([{ name: 'raibitserver_session', value: 'fixture-user-populated', domain: 'console.localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
    const first = await context.newPage();
    const second = await context.newPage();
    const assertFirstClean = observeThemeErrors(first);
    const assertSecondClean = observeThemeErrors(second);
    try {
      await prepareTheme(first, CONSOLE_ORIGIN, 'light');
      await Promise.all([first.goto('/console', { waitUntil: 'networkidle' }), second.goto('/console', { waitUntil: 'networkidle' })]);
      await first.locator('button[aria-label^="테마 설정: 현재"]:visible').click();
      await first.getByRole('menuitemradio', { name: '다크' }).click();
      await expectThemeAgreement(first, 'dark');
      await expectThemeAgreement(second, 'dark');
      assertFirstClean();
      assertSecondClean();
    } finally {
      await context.close();
    }
  });

  test('recovers invalid preferences and preserves cookie fallback with 320px long copy when localStorage throws', async ({ browser, request }) => {
    const fixture = await request.post('http://127.0.0.1:3411/__fixture/state', { data: { publicSiteScenario: 'long' } });
    expect(fixture.ok()).toBe(true);
    const context = await browser.newContext({ viewport: { width: 320, height: 800 } });
    const page = await context.newPage();
    const assertNoErrors = observeThemeErrors(page);
    await page.addInitScript(() => {
      localStorage.setItem('raibit-theme', 'invalid');
      const getItem = Storage.prototype.getItem;
      const setItem = Storage.prototype.setItem;
      Storage.prototype.getItem = function (key) { if (key === 'raibit-theme') throw new DOMException('disabled', 'SecurityError'); return getItem.call(this, key); };
      Storage.prototype.setItem = function (key, value) { if (key === 'raibit-theme') throw new DOMException('disabled', 'SecurityError'); return setItem.call(this, key, value); };
    });
    try {
      await page.goto(PUBLIC_ORIGIN, { waitUntil: 'networkidle' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
      await expect(page.locator('body')).toContainText('배포 로그가 길어져도');
      await page.locator('header').getByRole('button', { name: /테마 설정: 현재/ }).click();
      await page.getByRole('menuitemradio', { name: '다크' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect.poll(async () => (await context.cookies(PUBLIC_ORIGIN)).find((cookie) => cookie.name === 'raibit-theme')?.value).toBe('dark');
      await expectThemeSurface(page, 'public');
      assertNoErrors();
    } finally {
      await request.post('http://127.0.0.1:3411/__fixture/reset');
      await context.close();
    }
  });

  test('matches explicit dark aliases to system dark, responds to OS flips, and enforces contrast', async ({ browser }) => {
    const context = await browser.newContext({ viewport: THEME_VIEWPORTS[2], colorScheme: 'dark' });
    const page = await context.newPage();
    const assertNoErrors = observeThemeErrors(page);
    try {
      await prepareTheme(page, PUBLIC_ORIGIN, 'dark');
      await page.goto(PUBLIC_ORIGIN, { waitUntil: 'networkidle' });
      const explicit = await readAliases(page);
      await page.locator('header').getByRole('button', { name: /테마 설정: 현재/ }).click();
      await page.getByRole('menuitemradio', { name: '시스템' }).click();
      const systemDark = await readAliases(page);
      expect(systemDark).toEqual(explicit);
      for (const alias of DARK_ALIASES) expect(systemDark[alias]).not.toBe('');
      expect(contrastRatio(systemDark['--foreground'] ?? '', systemDark['--background'] ?? '')).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(systemDark['--primary-foreground'] ?? '', systemDark['--primary'] ?? '')).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(systemDark['--brand-surface-foreground'] ?? '', systemDark['--brand-surface'] ?? '')).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(systemDark['--input'] ?? '', systemDark['--popover'] ?? '')).toBeGreaterThanOrEqual(3);
      await page.emulateMedia({ colorScheme: 'light' });
      await expect.poll(async () => (await readAliases(page))['--background']).not.toBe(systemDark['--background']);
      await page.emulateMedia({ colorScheme: 'dark' });
      expect(await readAliases(page)).toEqual(systemDark);
      await expectThemeAgreement(page, 'system');
      assertNoErrors();
    } finally {
      await context.close();
    }
  });
});
