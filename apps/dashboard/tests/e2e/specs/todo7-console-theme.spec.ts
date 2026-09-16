import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { expectAccessible, observeBrowserErrors } from '../helpers/contracts';

const fixtureEnabled = process.env.RAIBITSERVER_E2E_FIXTURES === '1';
const evidenceDirectory = process.env.RAIBITSERVER_EVIDENCE_DIR;

function themeTriggers(page: Page) {
  return page.locator('button[aria-label^="테마 설정: 현재"]');
}

function visibleThemeTrigger(page: Page) {
  return page.locator('button[aria-label^="테마 설정: 현재"]:visible');
}

async function expectThemeState(page: Page, preference: 'dark' | 'light', label: string): Promise<void> {
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe(preference);
  await expect(themeTriggers(page)).toHaveCount(2);
  await expect.poll(() => themeTriggers(page).evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))).toEqual([
    `테마 설정: 현재 ${label}`,
    `테마 설정: 현재 ${label}`,
  ]);
}

async function selectTheme(page: Page, label: '다크' | '라이트'): Promise<void> {
  const trigger = visibleThemeTrigger(page);
  await expect(trigger).toHaveCount(1);
  await trigger.click();
  const choice = page.getByRole('menuitemradio', { name: label });
  await expect(choice).toBeVisible();
  await choice.click();
  await expect(choice).toBeHidden();
}

async function expectBoundedChrome(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.locator('[data-console-shell]').evaluate((shell) => {
    const shellRect = shell.getBoundingClientRect();
    const header = shell.querySelector('header.md\\:hidden');
    const main = shell.querySelector('#main-content');
    if (!(header instanceof HTMLElement) || !(main instanceof HTMLElement)) return false;
    const headerRect = header.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    return headerRect.right <= shellRect.right && mainRect.top >= headerRect.bottom;
  })).toBe(true);
}

test.describe('@todo7-console-theme', () => {
  test.skip(!fixtureEnabled || !evidenceDirectory, 'requires local fixture and explicit evidence directory');

  test.beforeAll(async () => {
    await mkdir(evidenceDirectory!, { recursive: true });
  });

  test('console theme menus remain synchronized across responsive chrome', async ({ userPage: page }) => {
    const assertNoErrors = observeBrowserErrors(page);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/console');
    await expect(page.locator('aside[aria-label="콘솔 사이드바"]')).toBeVisible();
    await expect(page.getByRole('link', { name: '사용 설명서' })).toBeVisible();
    await expect(page.locator('aside').getByRole('button', { name: '로그아웃' })).toBeVisible();
    await selectTheme(page, '다크');
    await expectThemeState(page, 'dark', '다크');
    await selectTheme(page, '라이트');
    await expectThemeState(page, 'light', '라이트');
    await page.reload();
    await expectThemeState(page, 'light', '라이트');
    await page.locator('[aria-label="콘솔 도구"] button[aria-label="메뉴 검색"]').click();
    const searchDialog = page.getByRole('dialog', { name: '메뉴 검색' });
    await expect(searchDialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(searchDialog).toBeHidden();
    await expectAccessible(page);
    await expectBoundedChrome(page);
    await page.screenshot({ path: resolve(evidenceDirectory!, 'task-7-console-light-1280.png'), fullPage: true });

    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.locator('aside[aria-label="콘솔 사이드바"]')).toBeHidden();
    await expect(page.getByRole('button', { name: '콘솔 메뉴 열기' })).toBeVisible();
    await selectTheme(page, '다크');
    await expectThemeState(page, 'dark', '다크');
    await selectTheme(page, '라이트');
    await expectThemeState(page, 'light', '라이트');
    await page.getByRole('button', { name: '콘솔 메뉴 열기' }).click();
    const sheet = page.getByRole('dialog', { name: 'RAIBIT SERVER 콘솔' });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('button[aria-label^="테마 설정: 현재"]')).toHaveCount(0);
    await expect(sheet.getByRole('link', { name: '개요' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: '로그아웃' })).toBeVisible();
    await page.getByRole('button', { name: '메뉴 닫기' }).click();
    await expect(sheet).toBeHidden();
    await page.locator('[aria-label="모바일 콘솔 도구"] button[aria-label="메뉴 검색"]').click();
    await expect(searchDialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(searchDialog).toBeHidden();
    await expectAccessible(page);
    await expectBoundedChrome(page);
    await page.screenshot({ path: resolve(evidenceDirectory!, 'task-7-console-light-375.png'), fullPage: true });

    await page.setViewportSize({ width: 767, height: 812 });
    await selectTheme(page, '다크');
    await expectThemeState(page, 'dark', '다크');
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.locator('aside[aria-label="콘솔 사이드바"]')).toBeVisible();
    const desktopTrigger = visibleThemeTrigger(page);
    await expect(desktopTrigger).toHaveCount(1);
    await expect(desktopTrigger).toHaveAttribute('aria-label', '테마 설정: 현재 다크');
    await desktopTrigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitemradio', { name: '다크' })).toHaveAttribute('aria-checked', 'true');
    const lightChoice = page.getByRole('menuitemradio', { name: '라이트' });
    await lightChoice.focus();
    await expect(lightChoice).toBeFocused();
    await page.keyboard.press('Enter');
    await expectThemeState(page, 'light', '라이트');
    await expect(desktopTrigger).toBeFocused();
    await expectAccessible(page);
    await expectBoundedChrome(page);
    await page.screenshot({ path: resolve(evidenceDirectory!, 'task-7-console-light-768.png'), fullPage: true });

    await page.evaluate(() => window.dispatchEvent(new CustomEvent('raibit-theme-change', { detail: 'dark' })));
    await expectThemeState(page, 'dark', '다크');
    await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'raibit-theme', newValue: 'light' })));
    await expectThemeState(page, 'light', '라이트');
    await expect.poll(() => page.evaluate(() => document.cookie.includes('raibit-theme=light'))).toBe(true);
    assertNoErrors();
  });
});
