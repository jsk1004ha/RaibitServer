import AxeBuilder from '@axe-core/playwright';
import { expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';

export const DASHBOARD_ORIGIN = 'http://console.localhost:3410';
export const FIXTURE_ORIGIN = 'http://127.0.0.1:3411';
export const VIEWPORT_MATRIX = [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }] as const;

export async function installSession(context: BrowserContext, token: string): Promise<void> {
  await context.addCookies([{ name: 'raibitserver_session', value: token, domain: 'console.localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
}

export async function nativeFormData(page: Page, selector: string): Promise<readonly [string, string][]> {
  return page.locator(selector).evaluate((form) => {
    if (!(form instanceof HTMLFormElement)) throw new Error('selector_is_not_form');
    return [...new FormData(form).entries()].map(([key, value]) => [key, typeof value === 'string' ? value : `${value.name}:${value.type}:${value.size}`] as [string, string]);
  });
}

export async function expectRoute(page: Page, path: string, query: Readonly<Record<string, string>> = {}): Promise<void> {
  await expect.poll(() => new URL(page.url()).pathname).toBe(path);
  const url = new URL(page.url());
  for (const [key, value] of Object.entries(query)) expect(url.searchParams.get(key)).toBe(value);
  expect(url.host).toBe('console.localhost:3410');
}

export async function expectAccessible(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
}

export function observeBrowserErrors(page: Page, expectedStatuses: readonly number[] = []): () => void {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console:${message.text()}`); });
  page.on('pageerror', (error) => errors.push(`page:${error.message}`));
  page.on('requestfailed', (request) => errors.push(`request:${request.url()}:${request.failure()?.errorText || 'failed'}`));
  page.on('response', (response) => { if (response.status() >= 400 && !expectedStatuses.includes(response.status())) errors.push(`response:${response.status()}:${response.url()}`); });
  return () => expect(errors, errors.join('\n')).toEqual([]);
}

export async function captureScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<string> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
  return path;
}
