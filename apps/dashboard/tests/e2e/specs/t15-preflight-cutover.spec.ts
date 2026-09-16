import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { expectAccessible, FIXTURE_ORIGIN, installSession, isBenignNextPrefetchCancellation } from '../helpers/contracts';

const fixtureEnabled = process.env.RAIBITSERVER_E2E_FIXTURES === '1';
const resourceBase = '/org/raibit/projects/prj_fixture_001/resources/res_fixture_pg/console';

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function expectViewport(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  expect(await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))).toEqual({ width, height });
}

function observeT15BrowserErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console:${message.text()}`); });
  page.on('pageerror', (error) => errors.push(`page:${error.message}`));
  page.on('requestfailed', (request) => {
    if (!isBenignNextPrefetchCancellation(request)) errors.push(`request:${request.url()}:${request.failure()?.errorText || 'failed'}`);
  });
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`response:${response.status()}:${response.url()}`); });
  return () => expect(errors, errors.join('\n')).toEqual([]);
}

test.describe('@t15-preflight', () => {
  test.skip(!fixtureEnabled, 'requires RAIBITSERVER_E2E_FIXTURES=1');

  test.beforeEach(async ({ request }) => {
    const reset = await request.post(`${FIXTURE_ORIGIN}/__fixture/reset`);
    expect(reset.ok()).toBe(true);
  });

  test('native checkbox, select, and table styles survive Preflight at mobile and desktop widths', async ({ adminPage, userPage }) => {
    await expectViewport(adminPage, 1280, 800);
    const assertNoAdminErrors = observeT15BrowserErrors(adminPage);
    await adminPage.goto('/admin');

    const table = adminPage.locator('[data-slot="table"]').first();
    await expect(table).toBeVisible();
    await expect(table).toHaveCSS('border-collapse', 'collapse');
    const nativeCheckbox = adminPage.locator('input[type="checkbox"]').first();
    await expect(nativeCheckbox).toBeVisible();
    expect(await nativeCheckbox.evaluate((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }))).toEqual({ width: 16, height: 16 });
    await expectAccessible(adminPage);
    await expectNoDocumentOverflow(adminPage);
    assertNoAdminErrors();

    await expectViewport(userPage, 375, 812);
    const assertNoUserErrors = observeT15BrowserErrors(userPage);
    await userPage.goto('/github?step=import');
    const select = userPage.locator('select').first();
    await expect(select).toBeVisible();
    await expect(select).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    const selectStyle = await select.evaluate((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return {
        appearance: style.appearance,
        borderStyle: style.borderStyle,
        height: bounds.height,
        usable: element instanceof HTMLSelectElement && !element.disabled && element.options.length > 0,
      };
    });
    expect(selectStyle.appearance.length).toBeGreaterThan(0);
    expect(selectStyle.borderStyle).not.toBe('none');
    expect(selectStyle.height).toBeGreaterThanOrEqual(36);
    expect(selectStyle.usable).toBe(true);
    await select.focus();
    await expect(select).toBeFocused();
    await userPage.keyboard.press('Tab');
    await expect(select).not.toBeFocused();
    await userPage.goto(`${resourceBase}?view=query`);
    const confirmation = userPage.getByLabel('변경 쿼리 확인');
    await expect(confirmation).toBeVisible();
    expect(await confirmation.evaluate((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }))).toEqual({ width: 20, height: 20 });
    await expectAccessible(userPage);
    await expectNoDocumentOverflow(userPage);
    assertNoUserErrors();
  });

  test('Base UI dialog and sheet stay bounded after Preflight', async ({ userPage }) => {
    await expectViewport(userPage, 1280, 800);
    const assertNoErrors = observeT15BrowserErrors(userPage);
    await userPage.goto('/console');
    const searchTrigger = userPage.locator('[aria-label="콘솔 도구"] button[aria-label="메뉴 검색"]');
    await expect(searchTrigger).toBeVisible();
    await expect(searchTrigger).toBeEnabled();
    await searchTrigger.focus();
    await searchTrigger.click();
    const dialog = userPage.getByRole('dialog', { name: '메뉴 검색' });
    const searchInput = userPage.getByPlaceholder('메뉴 또는 프로젝트 화면 검색');
    await expect(dialog).toBeVisible();
    await expect(searchInput).toBeFocused();
    await userPage.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(searchTrigger).toBeFocused();
    await userPage.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    expect(await userPage.evaluate(() => document.activeElement === document.body)).toBe(true);
    await userPage.keyboard.press('/');
    await expect(dialog).toBeVisible();
    await expect(searchInput).toBeFocused();
    await expect(dialog).toHaveCSS('position', 'fixed');
    await expectNoDocumentOverflow(userPage);
    await userPage.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await expectViewport(userPage, 768, 1024);
    await expect(userPage.locator('aside[aria-label="콘솔 사이드바"]')).toBeVisible();
    await expect(userPage.getByRole('button', { name: '콘솔 메뉴 열기' })).toBeHidden();
    await expectViewport(userPage, 767, 1024);
    await expect(userPage.locator('aside[aria-label="콘솔 사이드바"]')).toBeHidden();
    await expect(userPage.getByRole('button', { name: '콘솔 메뉴 열기' })).toBeVisible();
    await expectViewport(userPage, 375, 812);
    await userPage.getByRole('button', { name: '콘솔 메뉴 열기' }).click();
    const sheet = userPage.getByRole('dialog', { name: 'RAIBIT SERVER 콘솔' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveCSS('opacity', '1');
    expect(await sheet.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(375);
    await expectAccessible(userPage, '[data-slot="sheet-content"]');
    await expectNoDocumentOverflow(userPage);
    assertNoErrors();
  });

  test('print, reduced motion, and long text keep intentional base behavior', async ({ adminPage, userContext, userPage }) => {
    await expectViewport(adminPage, 1280, 800);
    await adminPage.goto('/admin');
    await adminPage.emulateMedia({ media: 'print' });
    await expect(adminPage.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');

    await installSession(userContext, 'fixture-user-long');
    await userPage.emulateMedia({ media: 'screen', reducedMotion: 'reduce' });
    await expectViewport(userPage, 375, 812);
    const assertNoErrors = observeT15BrowserErrors(userPage);
    await userPage.goto('/console');
    const newProject = userPage.getByRole('link', { name: '새 프로젝트', exact: true });
    await expect(newProject).toBeVisible();
    const transitionSeconds = await newProject.evaluate((element) => Number.parseFloat(getComputedStyle(element).transitionDuration));
    expect(transitionSeconds).toBeLessThanOrEqual(0.001);
    await expectNoDocumentOverflow(userPage);
    await expectAccessible(userPage);
    assertNoErrors();
  });
});
