import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const evidence = process.env.RAIBIT_OAUTH_EVIDENCE_DIR || '';
const manifest = z.object({ origin: z.url(), managementOrigin: z.url() }).parse(JSON.parse(await fs.readFile(path.join(evidence, 'runtime-manifest.json'), 'utf8')));
const callback = '/api/control/auth/github/callback';
const cookieNames = ['raibitserver_github_oauth_state', 'raibitserver_github_oauth_verifier'];
const outcomes: object[] = [];

async function navigate(page: Page, url: string) {
  try { await page.goto(url); } catch { throw new Error('oauth_navigation_failed'); }
}
async function deniedCallback(page: Page, state: string) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === callback);
  await navigate(page, `${manifest.origin}${callback}?${new URLSearchParams({ state, error: 'access_denied' })}`);
  return response;
}

test.beforeEach(async ({ context, request }) => {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === manifest.origin || (url.hostname === 'github.com' && url.pathname === '/login/oauth/authorize')) return route.continue();
    return route.abort('blockedbyclient');
  });
  expect((await request.post(`${manifest.managementOrigin}/__oauth/reset-account`, { data: {} })).ok()).toBe(true);
});

test('OAuth BFF denial consumes once without exchange and clears bound cookies', async ({ context, request, page }) => {
  // Given: browser receives a real API-generated state through the real HTTPS BFF.
  await navigate(page, `${manifest.origin}/api/control/auth/github/login`);
  const cookies = await context.cookies(`${manifest.origin}${callback}`);
  const state = cookies.find((cookie) => cookie.name === cookieNames[0])?.value;
  expect(Boolean(state)).toBe(true);
  const before = await (await request.get(`${manifest.managementOrigin}/__oauth/counters`)).json();
  // When: the provider returns a fixed denial with the original cookie binding.
  const response = await deniedCallback(page, state || '');
  // Then: one consumed transaction, no token/session, same strict cookie deletion.
  expect(response.status()).toBe(302);
  expect(new URL(response.headers()['location'] || '').pathname).toBe('/login');
  const after = await (await request.get(`${manifest.managementOrigin}/__oauth/counters`)).json();
  expect(after.apiCallback - before.apiCallback).toBe(1); expect(after.consumed - before.consumed).toBe(1); expect(after.token - before.token).toBe(0);
  expect((await context.cookies()).some((cookie) => [...cookieNames, 'raibitserver_session'].includes(cookie.name))).toBe(false);
  await navigate(page, `${manifest.origin}/login`);
  await page.screenshot({ path: path.join(evidence, 'oauth-denial-login.png') });
  outcomes.push({ scenario: 'bound-denial', apiCallbacks: 1, consumed: 1, exchanges: 0, cookiesCleared: true });
});

test('OAuth BFF rate rejection carries bounded Retry-After and clears callback cookies', async ({ context, request, page }) => {
  // Given: one valid cookie-bound start and a shared default callback bucket.
  await navigate(page, `${manifest.origin}/api/control/auth/github/login`);
  const cookies = await context.cookies(`${manifest.origin}${callback}`);
  const state = cookies.find((cookie) => cookie.name === cookieNames[0])?.value || '';
  const before = await (await request.get(`${manifest.managementOrigin}/__oauth/counters`)).json();
  // When: 30 malformed direct API callback attempts fill the same actual BFF peer budget.
  const runtime = z.object({ surfaces: z.array(z.object({ name: z.string(), baseUrl: z.url() })) }).parse(JSON.parse(await fs.readFile(path.join(evidence, 'runtime-manifest.json'), 'utf8')));
  const api = runtime.surfaces.find((surface) => surface.name === 'nest');
  expect(Boolean(api)).toBe(true);
  for (let i = 0; i < 30; i += 1) expect((await request.get(`${api?.baseUrl}/auth/github/callback`)).status()).toBe(400);
  const response = await deniedCallback(page, state);
  // Then: API429 becomes the existing browser redirect with only a bounded retry hint.
  expect(response.status()).toBe(302);
  const retry = Number(response.headers()['retry-after']);
  expect(Number.isInteger(retry) && retry >= 1 && retry <= 3600).toBe(true);
  expect((await context.cookies()).some((cookie) => [...cookieNames, 'raibitserver_session'].includes(cookie.name))).toBe(false);
  const after = await (await request.get(`${manifest.managementOrigin}/__oauth/counters`)).json();
  expect(after.token - before.token).toBe(0); expect(after.consumed - before.consumed).toBe(0);
  outcomes.push({ scenario: 'callback-rate-limit', retryBounded: true, exchanges: 0, consumed: 0, cookiesCleared: true });
});

test.afterAll(async () => { await fs.writeFile(path.join(evidence, 'browser-abuse-outcomes.json'), JSON.stringify(outcomes, null, 2)); });
