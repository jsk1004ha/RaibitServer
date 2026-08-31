import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import type { MatrixActor, MatrixState, RouteScenario } from '../regression-matrix';
import { DASHBOARD_ORIGIN, installSession, isBenignNextPrefetchCancellation } from './contracts';

export const PUBLIC_ORIGIN = 'http://localhost:3410';
export const LOOPBACK_ORIGIN = 'http://127.0.0.1:3410';
export const CONSOLE_HOST = new URL(DASHBOARD_ORIGIN).host;

const TOKENS = {
  user: { populated: 'fixture-user-populated', empty: 'fixture-user-empty', partial: 'fixture-user-partial', long: 'fixture-user-long', hostile: 'fixture-user-populated', expired: 'fixture-expired' },
  admin: { populated: 'fixture-admin-populated', empty: 'fixture-admin-empty', partial: 'fixture-admin-partial', long: 'fixture-admin-long', hostile: 'fixture-admin-populated', expired: 'fixture-expired' },
} as const satisfies Readonly<Record<Exclude<MatrixActor, 'anonymous'>, Readonly<Record<MatrixState, string>>>>;

export async function contextFor(browser: Browser, actor: MatrixActor, state: MatrixState): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (actor !== 'anonymous') await installSession(context, TOKENS[actor][state]);
  return context;
}

export function routeUrl(scenario: RouteScenario): string {
  return `${scenario.origin === 'public' ? PUBLIC_ORIGIN : DASHBOARD_ORIGIN}${scenario.path}`;
}

export function hostedErrorUrl(origin: string, code: number, maliciousPath: string): string {
  return `${origin}/api/hosted-error?code=${code}&path=${encodeURIComponent(maliciousPath)}&id=fixture-hosted-id`;
}

export async function expectDocument(page: Page): Promise<void> {
  const state = await page.evaluate(() => {
    const main = [...document.querySelectorAll('main#main-content')];
    const headings = [...document.querySelectorAll('h1')];
    const body = document.body.textContent ?? '';
    const rendered = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      if (element.getClientRects().length === 0 || bounds.width <= 0 || bounds.height <= 0) return false;
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (ancestor.hasAttribute('hidden') || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      }
      return true;
    };
    const hiddenFromAccessibility = (element: Element) => !rendered(element)
      || element.closest('[hidden], [aria-hidden="true"], [inert]') !== null;
    const visibleMain = main.filter(rendered);
    const visibleHeadings = headings.filter(rendered);
    const accessibleMain = visibleMain.filter((element) => !hiddenFromAccessibility(element));
    const accessibleHeadings = visibleHeadings.filter((element) => !hiddenFromAccessibility(element));
    const hiddenDuplicates = [...main, ...headings].filter((element) => !rendered(element));
    return {
      rawMainCount: main.length,
      rawHeadingCount: headings.length,
      visibleMainCount: visibleMain.length,
      visibleHeadingCount: visibleHeadings.length,
      accessibleMainCount: accessibleMain.length,
      accessibleHeadingCount: accessibleHeadings.length,
      headingVisible: visibleHeadings[0]?.getBoundingClientRect().height > 0,
      hiddenDuplicatesSafe: hiddenDuplicates.every(hiddenFromAccessibility),
      overflowFree: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      secretFree: !/fixture_internal_secret|provider-managed@fixture|T6_E2E_SECRET/i.test(body),
    };
  });
  expect(state).toMatchObject({ visibleMainCount: 1, visibleHeadingCount: 1, accessibleMainCount: 1, accessibleHeadingCount: 1, headingVisible: true, hiddenDuplicatesSafe: true, overflowFree: true, secretFree: true });
  expect(state.rawMainCount).toBeGreaterThanOrEqual(state.visibleMainCount);
  expect(state.rawHeadingCount).toBeGreaterThanOrEqual(state.visibleHeadingCount);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations, JSON.stringify(axe.violations, null, 2)).toEqual([]);
}

export async function attachA11y(page: Page, testInfo: TestInfo, id: string): Promise<void> {
  const snapshot = await page.locator('body').ariaSnapshot();
  await testInfo.attach(`${id}-accessibility`, { body: Buffer.from(snapshot), contentType: 'text/yaml' });
}

export async function visibleTargetHeights(page: Page, selector: string): Promise<readonly number[]> {
  return page.locator(selector).evaluateAll((elements) => elements
    .filter((element) => element instanceof HTMLElement && element.getClientRects().length > 0)
    .map((element) => element.getBoundingClientRect().height));
}

export function observeScenarioIssues(page: Page, allowedStatuses: readonly number[]): Readonly<{ issues: string[]; dispose(): void }> {
  const issues: string[] = [];
  const allowed = new Set(allowedStatuses);
  const onConsole = (message: { type(): string; text(): string }) => { if (message.type() === 'error') issues.push(`console:${message.text()}`); };
  const onPageError = (error: Error) => issues.push(`page:${error.message}`);
  const onResponse = (response: { status(): number; url(): string }) => { if (response.status() >= 400 && !allowed.has(response.status())) issues.push(`response:${response.status()}:${response.url()}`); };
  const onRequestFailed = (request: import('@playwright/test').Request) => {
    if (!isBenignNextPrefetchCancellation(request)) issues.push(`request:${request.url()}:${request.failure()?.errorText ?? 'failed'}`);
  };
  page.on('console', onConsole); page.on('pageerror', onPageError); page.on('response', onResponse); page.on('requestfailed', onRequestFailed);
  return {
    issues,
    dispose() {
      page.off('console', onConsole); page.off('pageerror', onPageError); page.off('response', onResponse); page.off('requestfailed', onRequestFailed);
    },
  };
}

export const USER_SESSION_TOKEN = TOKENS.user.populated;
