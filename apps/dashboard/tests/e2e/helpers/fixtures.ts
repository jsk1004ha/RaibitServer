import { test as base, type BrowserContext, type Page } from '@playwright/test';
import { installSession } from './contracts';

type DashboardFixtures = { readonly userContext: BrowserContext; readonly userPage: Page; readonly adminContext: BrowserContext; readonly adminPage: Page };

export const test = base.extend<DashboardFixtures>({
  userContext: async ({ browser }, use) => { const context = await browser.newContext(); await installSession(context, 'fixture-user-populated'); await use(context); await context.close(); },
  userPage: async ({ userContext }, use) => { const page = await userContext.newPage(); await use(page); },
  adminContext: async ({ browser }, use) => { const context = await browser.newContext(); await installSession(context, 'fixture-admin-populated'); await use(context); await context.close(); },
  adminPage: async ({ adminContext }, use) => { const page = await adminContext.newPage(); await use(page); },
});
export { expect } from '@playwright/test';
