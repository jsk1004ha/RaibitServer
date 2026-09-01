import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const THEME_EVIDENCE_DIRECTORY = process.env.RAIBITSERVER_EVIDENCE_DIR;
export const PUBLIC_ORIGIN = 'http://localhost:3410';
export const CONSOLE_ORIGIN = 'http://console.localhost:3410';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ThemeViewport = { readonly width: 375 | 768 | 1280; readonly height: number };

export const THEME_VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
] as const satisfies readonly ThemeViewport[];

export const DARK_ALIASES = [
  '--canvas', '--background', '--canvas-soft', '--secondary', '--muted', '--card', '--popover',
  '--canvas-night', '--inverse', '--canvas-night-soft', '--inverse-raised', '--ink', '--foreground',
  '--ink-secondary', '--secondary-foreground', '--ink-mute', '--muted-foreground', '--ink-mute-2',
  '--ink-faint', '--hairline', '--border', '--hairline-strong', '--input', '--primary', '--ring',
  '--primary-foreground', '--primary-deep', '--primary-soft', '--accent', '--accent-foreground',
  '--destructive', '--destructive-foreground', '--brand-surface', '--brand-surface-foreground', '--selection',
] as const;

export async function prepareTheme(
  page: Page,
  origin: string,
  preference: ThemePreference,
): Promise<void> {
  await page.context().addCookies([{
    name: 'raibit-theme',
    value: preference,
    domain: new URL(origin).hostname,
    path: '/',
    sameSite: 'Lax',
  }]);
  await page.addInitScript((value) => {
    if (localStorage.getItem('raibit-theme') === null) localStorage.setItem('raibit-theme', value);
  }, preference);
}

export function observeThemeErrors(page: Page, allowGlobalError = false): () => void {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const value = message.text();
    if (allowGlobalError && (value.includes('500 (Internal Server Error)') || value.includes('Server Components render'))) return;
    errors.push(`console:${value}`);
  });
  page.on('pageerror', (error) => errors.push(`page:${error.message}`));
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'failed';
    const url = new URL(request.url());
    const benignPrefetch = failure === 'net::ERR_ABORTED'
      && request.method() === 'GET'
      && request.resourceType() === 'fetch'
      && !request.isNavigationRequest()
      && url.searchParams.has('_rsc')
      && request.headers().rsc === '1';
    if (!benignPrefetch) errors.push(`request:${request.url()}:${failure}`);
  });
  page.on('response', (response) => {
    if (response.status() < 400 || (allowGlobalError && response.status() === 500)) return;
    errors.push(`response:${response.status()}:${response.url()}`);
  });
  return () => expect(errors, errors.join('\n')).toEqual([]);
}

export async function expectThemeAgreement(page: Page, preference: ThemePreference): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-theme', preference);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('raibit-theme'))).toBe(preference);
  const cookies = await page.context().cookies(page.url());
  const themeCookie = cookies.find((cookie) => cookie.name === 'raibit-theme');
  expect(themeCookie?.value).toBe(preference);
  expect(themeCookie?.domain).toBe(new URL(page.url()).hostname);
}

export async function expectThemeSurface(page: Page, placement: 'public' | 'login' | 'console' | 'error'): Promise<void> {
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveCount(1);
  await expect(heading).toBeVisible();
  const trigger = page.locator('button[aria-label^="테마 설정: 현재"]:visible');
  await expect(trigger).toHaveCount(1);

  if (placement === 'public') await expect(page.locator('header').getByRole('button', { name: /테마 설정: 현재/ })).toBeVisible();
  if (placement === 'login' || placement === 'error') await expect(page.locator('[data-slot="theme-utility"]').getByRole('button', { name: /테마 설정: 현재/ })).toBeVisible();
  if (placement === 'console') {
    const tools = page.viewportSize()?.width === 375 ? '모바일 콘솔 도구' : '콘솔 도구';
    await expect(page.locator(`[aria-label="${tools}"]`).getByRole('button', { name: /테마 설정: 현재/ })).toBeVisible();
  }

  const geometry = await Promise.all([heading, trigger].map((locator) => locator.boundingBox()));
  expect(geometry.every((box) => box !== null)).toBe(true);
  const [headingBox, triggerBox] = geometry;
  if (!headingBox || !triggerBox) throw new Error('theme_surface_geometry_missing');
  const overlaps = triggerBox.x < headingBox.x + headingBox.width
    && triggerBox.x + triggerBox.width > headingBox.x
    && triggerBox.y < headingBox.y + headingBox.height
    && triggerBox.y + triggerBox.height > headingBox.y;
  expect(overlaps).toBe(false);
  expect(triggerBox.x).toBeGreaterThanOrEqual(0);
  expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations, JSON.stringify(axe.violations, null, 2)).toEqual([]);
}

export async function saveThemeScreenshot(page: Page, name: string): Promise<void> {
  if (!THEME_EVIDENCE_DIRECTORY) throw new Error('RAIBITSERVER_EVIDENCE_DIR_is_required');
  await mkdir(THEME_EVIDENCE_DIRECTORY, { recursive: true });
  await page.screenshot({ path: resolve(THEME_EVIDENCE_DIRECTORY, `${name}.png`), fullPage: true });
}

export async function readAliases(page: Page): Promise<Readonly<Record<string, string>>> {
  return page.evaluate((aliases) => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(aliases.map((alias) => [alias, style.getPropertyValue(alias).trim()]));
  }, DARK_ALIASES);
}

export function contrastRatio(first: string, second: string): number {
  const luminance = (color: string): number => {
    const hex = color.match(/^#([\da-f]{6})$/i)?.[1];
    const channels = hex
      ? [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map((channel) => Number.parseInt(channel, 16))
      : color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length !== 3) throw new Error(`unsupported_color:${color}`);
    const linear = channels.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
}
