import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { captureScreenshot, DASHBOARD_ORIGIN, FIXTURE_ORIGIN, installSession, isBenignNextPrefetchCancellation } from '../helpers/contracts';
import { attachA11y, CONSOLE_HOST, contextFor, expectDocument, hostedErrorUrl, LOOPBACK_ORIGIN, observeScenarioIssues, PUBLIC_ORIGIN, routeUrl, USER_SESSION_TOKEN, visibleTargetHeights } from '../helpers/t16-runtime';
import { HOSTED_ERROR_CASES, MATRIX_TIMEOUTS, ROUTE_BATCHES, SHELL_VIEWPORTS, TEMPLATE_MATRIX, TEMPLATE_VIEWPORTS } from '../regression-matrix';

const fixtureEnabled = process.env.RAIBITSERVER_E2E_FIXTURES === '1';
test.describe('@t16-regression-matrix', () => {
  test.skip(!fixtureEnabled, 'requires RAIBITSERVER_E2E_FIXTURES=1');

  test.beforeEach(async ({ request }) => {
    expect((await request.post(`${FIXTURE_ORIGIN}/__fixture/reset`)).ok()).toBe(true);
  });

  for (const batch of ROUTE_BATCHES) {
    test(`one-width behavioral matrix covers ${batch.id}`, async ({ browser, request }, testInfo) => {
      const scenarios = batch.scenarios;
      test.setTimeout(MATRIX_TIMEOUTS.routeBaseMs + scenarios.length * MATRIX_TIMEOUTS.routeStepMs);
      const context = await contextFor(browser, scenarios[0].actor, scenarios[0].state);
      const page = await context.newPage();
      try {
        for (const scenario of scenarios) {
          await test.step(scenario.id, async () => {
            if (scenario.family === 'public' && scenario.state !== 'populated') {
              const selected = await request.post(`${FIXTURE_ORIGIN}/__fixture/state`, { data: { publicSiteScenario: scenario.state } });
              expect(selected.ok()).toBe(true);
            }
            const observer = observeScenarioIssues(page, scenario.allowedStatuses ?? []);
            try {
              const response = await page.goto(routeUrl(scenario), { waitUntil: 'domcontentloaded' });
              if (scenario.expected === 'login-redirect') {
                await expect(page).toHaveURL(/\/login\?/);
                if (scenario.state === 'expired') await expect(page).toHaveURL(/error=session_expired/);
              } else if (scenario.expected === 'console-redirect') {
                await expect(page).toHaveURL(/\/console$/);
              } else {
                expect(response?.status()).toBeLessThan(400);
                await expectDocument(page);
                await attachA11y(page, testInfo, scenario.id);
              }
            } finally {
              observer.dispose();
              await testInfo.attach(`${scenario.id}-browser-log`, { body: Buffer.from(JSON.stringify({ issues: observer.issues }, null, 2)), contentType: 'application/json' });
            }
            expect(observer.issues, observer.issues.join('\n')).toEqual([]);
          });
        }
      } finally {
        await context.close();
      }
    });
  }

  for (const [id, origin, path, actor, state] of TEMPLATE_MATRIX) {
    test(`representative template ${id} captures settled mobile and desktop evidence`, async ({ browser }, testInfo) => {
      test.setTimeout(MATRIX_TIMEOUTS.templateMs);
      for (const viewport of TEMPLATE_VIEWPORTS) {
        const context = await contextFor(browser, actor, state);
        const page = await context.newPage();
        try {
          await page.setViewportSize(viewport);
          await page.goto(`${origin === 'public' ? PUBLIC_ORIGIN : DASHBOARD_ORIGIN}${path}`, { waitUntil: 'networkidle' });
          await expectDocument(page);
          await attachA11y(page, testInfo, `${id}-${viewport.width}`);
          await captureScreenshot(page, testInfo, `t16-${id}-${viewport.width}`);
        } finally {
          await context.close();
        }
      }
    });
  }

  for (const code of HOSTED_ERROR_CASES) {
    test(`standalone hosted error ${code} preserves headers and sanitization`, async ({ browser, request }, testInfo) => {
      test.setTimeout(MATRIX_TIMEOUTS.hostedErrorMs);
      const maliciousPath = '/<img src=x onerror=fixture-hosted-error>';
      const expected = code === 599 ? 404 : code;
      const httpUrl = hostedErrorUrl(LOOPBACK_ORIGIN, code, maliciousPath);
      const consoleUrl = hostedErrorUrl(DASHBOARD_ORIGIN, code, maliciousPath);
      expect(CONSOLE_HOST).toBe('console.localhost:3410');
      expect(new URL(consoleUrl).host).toBe(CONSOLE_HOST);
      const apiResponse = await request.get(httpUrl, { headers: { host: CONSOLE_HOST } });
      expect(apiResponse.status()).toBe(expected);
      const headers = apiResponse.headers();
      expect(headers['cache-control']).toContain('no-store');
      expect(headers['content-security-policy']).toContain("default-src 'none'");
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['x-error-id']).toBe('fixture-hosted-id');
      const html = await apiResponse.text();
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<img src=x');
      await testInfo.attach(`hosted-${code}-headers`, { body: Buffer.from(JSON.stringify({ requestUrl: consoleUrl, transportUrl: httpUrl, host: CONSOLE_HOST, headers }, null, 2)), contentType: 'application/json' });

      for (const viewport of TEMPLATE_VIEWPORTS) {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        const requestedUrls: string[] = [];
        page.on('request', (requestEvent) => requestedUrls.push(requestEvent.url()));
        try {
          const response = await page.goto(consoleUrl, { waitUntil: 'domcontentloaded' });
          expect(response?.status()).toBe(expected);
          await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
          await expect(page.locator('img[src="x"], script')).toHaveCount(0);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
          expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
          expect(requestedUrls.every((requestedUrl) => requestedUrl.startsWith(DASHBOARD_ORIGIN) || requestedUrl.startsWith('data:'))).toBe(true);
          await attachA11y(page, testInfo, `hosted-${code}-${viewport.width}`);
          await captureScreenshot(page, testInfo, `t16-hosted-${code}-${viewport.width}`);
        } finally {
          await context.close();
        }
      }
    });
  }

  test('reduced motion and shell breakpoint ownership remain deterministic', async ({ browser }, testInfo) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    await installSession(context, USER_SESSION_TOKEN);
    const page = await context.newPage();
    try {
      await page.goto('/console');
      const primary = page.getByRole('link', { name: '새 프로젝트', exact: true });
      expect(Number.parseFloat(await primary.evaluate((element) => getComputedStyle(element).transitionDuration))).toBeLessThanOrEqual(0.001);
      for (const viewport of SHELL_VIEWPORTS) {
        await page.setViewportSize(viewport);
        const desktop = viewport.width === 768;
        if (desktop) {
          await expect(page.locator('aside[aria-label="콘솔 사이드바"]')).toBeVisible();
          await expect(page.getByRole('button', { name: '콘솔 메뉴 열기' })).toBeHidden();
        } else {
          await expect(page.locator('aside[aria-label="콘솔 사이드바"]')).toBeHidden();
          await expect(page.getByRole('button', { name: '콘솔 메뉴 열기' })).toBeVisible();
        }
        await captureScreenshot(page, testInfo, `t16-shell-${viewport.width}`);
      }
      await page.setViewportSize(SHELL_VIEWPORTS[1]);
      const searchTrigger = page.getByRole('button', { name: '메뉴 검색' });
      await searchTrigger.click();
      await expect(page.getByPlaceholder('메뉴 또는 프로젝트 화면 검색')).toBeFocused();
      await captureScreenshot(page, testInfo, 't16-search-focused-open');
      await page.keyboard.press('Escape');
      await expect(searchTrigger).toBeFocused();
      await page.setViewportSize(TEMPLATE_VIEWPORTS[0]);
      await page.getByRole('button', { name: '콘솔 메뉴 열기' }).click();
      await expect(page.getByRole('dialog', { name: 'RAIBIT SERVER 콘솔' })).toBeVisible();
      await captureScreenshot(page, testInfo, 't16-shell-mobile-open');
    } finally {
      await context.close();
    }
  });

  test('primary mobile targets remain at least 44px', async ({ browser }) => {
    const context = await browser.newContext({ viewport: TEMPLATE_VIEWPORTS[0] });
    const page = await context.newPage();
    try {
      await page.goto(PUBLIC_ORIGIN);
      await expect(page.locator('header a').first()).toBeVisible();
      const publicTargets = await visibleTargetHeights(page, 'header a');
      expect(publicTargets.length).toBeGreaterThan(0);
      for (const height of publicTargets) expect(height).toBeGreaterThanOrEqual(44);
      await page.goto(`${PUBLIC_ORIGIN}/errors/503`);
      const errorTargets = await visibleTargetHeights(page, 'main a');
      expect(errorTargets.length).toBeGreaterThan(0);
      for (const height of errorTargets) expect(height).toBeGreaterThanOrEqual(44);
    } finally {
      await context.close();
    }
  });

  test('console, network, CSP, and hydration logs remain clean', async ({ browser }, testInfo) => {
    const context = await contextFor(browser, 'user', 'populated');
    const page = await context.newPage();
    const issues: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') issues.push(`console:${message.text()}`); });
    page.on('pageerror', (error) => issues.push(`page:${error.message}`));
    page.on('requestfailed', (request) => { if (!isBenignNextPrefetchCancellation(request)) issues.push(`request:${request.url()}:${request.failure()?.errorText}`); });
    try {
      const response = await page.goto('/console', { waitUntil: 'networkidle' });
      expect(response?.headers()['content-security-policy']).toContain("default-src 'self'");
      await expect(page.locator('body')).not.toContainText(/hydration failed|server rendered html/i);
      await testInfo.attach('t16-final-browser-log', { body: Buffer.from(JSON.stringify({ issues }, null, 2)), contentType: 'application/json' });
      expect(issues, issues.join('\n')).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
