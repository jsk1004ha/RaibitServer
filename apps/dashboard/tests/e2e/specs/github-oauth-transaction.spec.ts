import { test, expect } from '@playwright/test';
import type { Page, BrowserContext, APIRequestContext } from '@playwright/test';
import { RAIBITSERVERClient } from '@raibitserver/api-client';
import { z } from 'zod';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const evidence = process.env.RAIBIT_OAUTH_EVIDENCE_DIR || '';
const manifest = z.object({ origin: z.url(), managementOrigin: z.url(), surfaces: z.array(z.object({ name: z.string(), baseUrl: z.url() })) })
  .parse(JSON.parse(await fs.readFile(path.join(evidence, 'runtime-manifest.json'), 'utf8')));
const callbackPath = '/api/control/auth/github/callback';
const stateCookie = 'raibitserver_github_oauth_state';
const verifierCookie = 'raibitserver_github_oauth_verifier';
const sessionCookie = 'raibitserver_session';
const secrets = new Set<string>();
const outcomes: object[] = [];
let deniedRequests = 0;

test.beforeEach(async ({ context }) => {
  deniedRequests = 0;
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === manifest.origin || (url.hostname === 'github.com' && url.pathname === '/login/oauth/authorize')) return route.continue();
    if (url.hostname === 'avatars.githubusercontent.com') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#345"/></svg>' });
    deniedRequests += 1;
    await route.abort('blockedbyclient');
  });
});
test.afterEach(async ({}, testInfo) => { expect(deniedRequests).toBe(testInfo.title.includes('@oauth-egress-guard') ? 1 : 0); });

test('@oauth-egress-guard denies unrelated browser destinations before network access', async ({ page }) => {
  let blocked = false;
  try { await page.goto('https://unrelated.example.invalid'); } catch { blocked = true; }
  expect(blocked).toBe(true);
  outcomes.push({ scenario: 'egress-denial', blocked: true });
});

async function management(request: APIRequestContext, action: string, body?: object) {
  const response = body ? await request.post(`${manifest.managementOrigin}/__oauth/${action}`, { data: body }) : await request.get(`${manifest.managementOrigin}/__oauth/${action}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function navigate(page: Page, url: string) {
  try { return await page.goto(url); } catch { throw new Error('oauth_navigation_failed'); }
}
async function start(page: Page, context: BrowserContext) {
  await navigate(page, `${manifest.origin}/login`);
  await page.getByRole('link', { name: 'GitHub로 로그인' }).click();
  await expect.poll(() => new URL(page.url()).hostname === 'github.com' && new URL(page.url()).pathname === '/login/oauth/authorize').toBe(true);
  await expect(page).toHaveTitle('OAuth provider fixture');
  const authorization = new URL(page.url());
  const cookies = await context.cookies(`${manifest.origin}${callbackPath}`);
  const state = cookies.find((cookie) => cookie.name === stateCookie)?.value || '';
  const verifier = cookies.find((cookie) => cookie.name === verifierCookie)?.value || '';
  secrets.add(state); secrets.add(verifier);
  expect(state.length).toBe(43); expect(verifier.length >= 43).toBe(true);
  expect(authorization?.searchParams.get('state') === state).toBe(true);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  expect(authorization?.searchParams.get('code_challenge') === challenge).toBe(true);
  expect(authorization?.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorization?.searchParams.get('redirect_uri')).toBe(`${manifest.origin}${callbackPath}`);
  expect(cookies.filter((cookie) => [stateCookie, verifierCookie].includes(cookie.name)).map(({ name, secure, httpOnly, sameSite, path: cookiePath, domain }) =>
    ({ name, secure, httpOnly, sameSite, path: cookiePath, domain })).sort((a, b) => a.name.localeCompare(b.name))).toEqual(
    [stateCookie, verifierCookie].sort().map((name) => ({ name, secure: true, httpOnly: true, sameSite: 'Lax', path: callbackPath, domain: 'console.localhost' })));
  return { state, verifier, challenge, cookies: cookies.filter((cookie) => [stateCookie, verifierCookie].includes(cookie.name)) };
}
async function issue(request: APIRequestContext, profile: object) {
  const response = await management(request, 'code', profile);
  const code = z.string().parse(response.code); secrets.add(code); return code;
}
async function callback(page: Page, input: Record<string, string>) {
  const response = await navigate(page, `${manifest.origin}${callbackPath}?${new URLSearchParams(input)}`);
  expect(Boolean(response)).toBe(true);
}
async function cleared(context: BrowserContext) {
  const cookies = await context.cookies(`${manifest.origin}${callbackPath}`);
  expect(cookies.some((cookie) => [stateCookie, verifierCookie].includes(cookie.name))).toBe(false);
  for (const cookie of cookies) secrets.add(cookie.value);
  return cookies;
}
test.afterAll(async () => { await fs.writeFile(path.join(evidence, 'browser-outcomes.json'), JSON.stringify(outcomes, null, 2)); });

test('@github-oauth-transaction browser completes real start and callback with authenticated console avatar', async ({ page, context, request }) => {
  await management(request, 'reset-account', {});
  await page.route('https://avatars.githubusercontent.com/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#345"/></svg>' }));
  const before = await management(request, 'counters');
  const flow = await start(page, context);
  const code = await issue(request, { challenge: flow.challenge });
  await callback(page, { state: flow.state, code });
  expect(new URL(page.url()).pathname).toBe('/console');
  const cookies = await cleared(context);
  expect(cookies.some((cookie) => cookie.name === sessionCookie && cookie.secure && cookie.httpOnly)).toBe(true);
  await expect(page.getByRole('img', { name: 'Approved Name 프로필 사진' }).first()).toBeVisible();
  const current = await page.evaluate(async () => {
    const response = await fetch('/api/control/auth/me');
    const body = await response.json();
    return { status: response.status, avatar: body.user?.avatarUrl, tokenPresent: Boolean(body.token) };
  });
  expect(current).toEqual({ status: 200, avatar: 'https://avatars.githubusercontent.com/u/4242?v=4', tokenPresent: false });
  const after = await management(request, 'counters');
  expect(after.token - before.token).toBe(1); expect(after.pkce - before.pkce).toBe(1);
  expect(after.consumedBeforeExchange - before.consumedBeforeExchange).toBe(1);
  expect((await management(request, 'scan', { values: [...secrets] })).clean).toBe(true);
  await context.tracing.start({ screenshots: true, snapshots: false, sources: false });
  await page.screenshot({ path: path.join(evidence, 'authenticated-console-avatar.png'), fullPage: true });
  const rawTrace = path.join(evidence, 'private-console-trace.zip');
  await context.tracing.stop({ path: rawTrace });
  await sanitizeTrace(rawTrace);
  outcomes.push({ scenario: 'browser-success', console: true, avatar: true, transactionCookiesCleared: true, providerExchanges: after.token - before.token, secretScanClean: true });
});

for (const scenario of ['missing-start', 'missing-cookie', 'wrong-state', 'wrong-verifier', 'missing-code', 'redirect', 'replay', 'denial', 'provider-unverified', 'exchange-failure', 'expiry', 'configuration', 'malformed-provider', 'missing-token', 'timeout', 'pending', 'local-unverified']) {
  test(`@github-oauth-transaction-negative ${scenario} creates no session and clears cookies`, async ({ page, context, request }) => {
    await management(request, 'reset-account', {});
    const flow = scenario === 'missing-start' ? { state: crypto.randomBytes(32).toString('base64url'), verifier: crypto.randomBytes(48).toString('base64url'), challenge: '', cookies: [] } : await start(page, context);
    secrets.add(flow.state); secrets.add(flow.verifier);
    if (scenario === 'missing-start') await context.addCookies([stateCookie, verifierCookie].map((name) => ({ name, value: name === stateCookie ? flow.state : flow.verifier,
      domain: 'console.localhost', path: callbackPath, secure: true, httpOnly: true, sameSite: 'Lax' })));
    if (scenario === 'missing-cookie') await context.clearCookies();
    if (scenario === 'wrong-verifier') await context.addCookies(flow.cookies.map((cookie) => cookie.name === verifierCookie ? { ...cookie, value: crypto.randomBytes(48).toString('base64url') } : cookie));
    if (scenario === 'expiry') await management(request, 'expire', {});
    if (scenario === 'configuration') await management(request, 'configuration-failure', {});
    if (['pending', 'local-unverified'].includes(scenario)) await management(request, 'reset-account', { pending: scenario === 'pending', unverified: scenario === 'local-unverified' });
    const code = await issue(request, { challenge: flow.challenge, verified: scenario !== 'provider-unverified', failure: scenario === 'exchange-failure',
      malformed: scenario === 'malformed-provider', missingToken: scenario === 'missing-token', stall: scenario === 'timeout' });
    const input: Record<string, string> = { state: scenario === 'wrong-state' ? crypto.randomBytes(32).toString('base64url') : flow.state, code };
    if (scenario === 'missing-code') delete input.code;
    if (scenario === 'redirect') input.redirectUri = 'https://attacker.example/callback';
    if (scenario === 'denial') input.error = 'access_denied';
    if (scenario === 'replay') { await callback(page, input); await context.clearCookies(); await context.addCookies(flow.cookies); }
    const before = await management(request, 'counters');
    await callback(page, input);
    expect(new URL(page.url()).pathname).toBe('/login');
    expect((await cleared(context)).some((cookie) => cookie.name === sessionCookie)).toBe(false);
    const after = await management(request, 'counters');
    const expectedExchange = ['provider-unverified', 'exchange-failure', 'malformed-provider', 'missing-token', 'timeout', 'pending', 'local-unverified'].includes(scenario) ? 1 : 0;
    expect(after.token - before.token).toBe(expectedExchange);
    if (['missing-cookie', 'wrong-state', 'missing-code', 'denial'].includes(scenario)) expect(after.apiCallback - before.apiCallback).toBe(0);
    outcomes.push({ scenario, noSession: true, transactionCookiesCleared: true, providerExchanges: after.token - before.token });
  });
}

test('@github-oauth-transaction direct clients use their own start and verifier on both actual APIs', async ({ request }) => {
  await management(request, 'reset-account', {});
  for (const surface of manifest.surfaces) {
    const client = new RAIBITSERVERClient({ baseUrl: surface.baseUrl });
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const started = await client.githubLogin({ codeChallenge: challenge });
    const code = await issue(request, { challenge });
    const result = await client.githubCallback({ state: started.state, codeVerifier: verifier, code });
    secrets.add(verifier); secrets.add(started.state); secrets.add(result.token);
    expect((await client.withToken(result.token).me()).user.githubId).toBe('4242');
    let rejected = false;
    try { await client.githubCallback({ state: started.state, codeVerifier: verifier, code }); } catch { rejected = true; }
    expect(rejected).toBe(true);
    outcomes.push({ scenario: `direct-${surface.name}`, currentSession: true, replayRejected: true });
  }
});

async function sanitizeTrace(rawTrace: string) {
  const directory = await fs.mkdtemp(path.join(evidence, 'private-trace-'));
  const entries = execFileSync('unzip', ['-Z1', rawTrace], { encoding: 'utf8' }).trim().split('\n');
  if (entries.some((entry) => entry.includes('..') || path.isAbsolute(entry))) throw new Error('trace_path_invalid');
  try {
    execFileSync('unzip', ['-q', rawTrace, '-d', directory]);
    for (const entry of entries.filter((entry) => !entry.endsWith('/'))) {
      const filename = path.join(directory, entry);
      if (entry.endsWith('.trace') || entry.endsWith('.network')) {
        const lines = (await fs.readFile(filename, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.stringify(redact(JSON.parse(line))));
        await fs.writeFile(filename, lines.join('\n') + '\n');
      }
      const bytes = await fs.readFile(filename);
      expect([...secrets].filter(Boolean).some((value) => bytes.includes(Buffer.from(value)))).toBe(false);
    }
    const archive = path.join(evidence, 'authenticated-console-sanitized-trace.zip');
    await fs.rm(archive, { force: true });
    execFileSync('zip', ['-q', '-r', archive, '.'], { cwd: directory });
  } finally {
    await fs.rm(rawTrace, { force: true });
    await fs.rm(directory, { recursive: true });
  }
}
function redact(value: unknown): unknown {
  if (typeof value === 'string') { let result = value; for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[REDACTED]'); return result; }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /cookie|authorization|headers/i.test(key) ? '[REDACTED]' : redact(item)]));
  return value;
}
