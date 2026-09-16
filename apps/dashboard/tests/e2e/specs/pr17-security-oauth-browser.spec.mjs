import assert from 'node:assert/strict';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { bootSecurityBrowser, browserName, transientNames, callbackPath, loginPath } from '../fixture/pr17-security-browser.mjs';
import { navigate, start, transaction, complete, snapshot, assertCleared, assertDeletion, screenshotClean, duplicateRequest } from '../fixture/pr17-security-assertions.mjs';

let fx;
let actors = [];
const outcomes = [];

async function actor() {
  const context = await fx.browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1120, height: 720 }, serviceWorkers: 'block' });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return [fx.origin, fx.tenantOrigin].includes(url.origin) || url.hostname === 'github.com' && url.pathname === '/login/oauth/authorize'
      ? route.continue() : route.abort('blockedbyclient');
  });
  const value = { context, page: await context.newPage() };
  actors.push(value);
  return value;
}

before(async () => { fx = await bootSecurityBrowser(); }, { timeout: 60_000 });
beforeEach(() => { for (const surface of fx.runtime.surfaces) surface.store.authRateLimits.clear(); });
afterEach(async () => { await Promise.all(actors.map(({ context }) => context.close())); actors = []; fx.injection = []; });
after(async () => {
  if (!fx) return;
  await fx.close();
  const serialized = JSON.stringify({
    mode: fx.mode, chromium: fx.version, headed: process.env.RAIBIT_PR17_HEADLESS !== '1',
    harness: 'HTTPS actual NextRequest/NextResponse + unchanged GET handler + real Nest HTTP/in-memory store; mock GitHub provider',
    sourceSeam: 'actual api.ts; AsyncLocalStorage next/headers injection', siblingObservation: fx.siblingObservation, outcomes, api: fx.api, bff: fx.bff, faults: fx.faults,
  }, null, 2);
  assert.equal([...fx.runtime.secrets].some((secret) => typeof secret === 'string' && secret.length >= 16 && serialized.includes(secret)), false, 'retained report must not contain runtime secrets');
  await fs.writeFile(path.join(fx.evidence, `pr17-security-${fx.mode}-results.json`), serialized);
});

test('sibling Domain injection is rejected before callback reaches API or creates session', { timeout: 45_000 }, async () => {
  // Given: a valid browser identity remains, but the only transaction cookies arrive from a sibling HTTP response.
  const a = await actor();
  await start(a, fx);
  const tuple = await transaction(a, fx);
  await a.context.clearCookies({ name: /raibitserver_github_oauth_(state|verifier)$/ });
  fx.injection = [...transientNames, browserName].flatMap((name, index) => {
    const value = [tuple.state, tuple.verifier, tuple.identity][index];
    return [name.replace('__Host-', ''), name].map((target) => `${target}=${value}; Domain=raibit.test; Path=/; Secure; HttpOnly; SameSite=Lax`);
  });
  const cdp = await a.context.newCDPSession(a.page);
  await cdp.send('Network.enable');
  const blocked = [];
  cdp.on('Network.responseReceivedExtraInfo', (event) => {
    for (const item of event.blockedCookies || []) blocked.push({ name: item.cookieLine.split('=', 1)[0], reasons: item.blockedReasons });
  });
  // When: Chromium navigates to tenant.raibit.test and processes its real Set-Cookie headers.
  const injection = await navigate(a.page, `${fx.tenantOrigin}/pr17-security/inject`);
  assert.equal((await injection.headersArray()).filter((header) => header.name.toLowerCase() === 'set-cookie').length, 6);
  const jar = await a.context.cookies(fx.origin);
  assert.equal(jar.filter((cookie) => cookie.domain === '.raibit.test' && cookie.name.startsWith('raibitserver_github_oauth_')).length, 3);
  assert.equal(jar.filter((cookie) => transientNames.includes(cookie.name)).length, 0);
  assert.equal(jar.find((cookie) => cookie.name === browserName)?.value === tuple.identity, true);
  assert.deepEqual(blocked.map(({ name }) => name).sort(), [...transientNames, browserName].sort());
  assert.ok(blocked.every(({ reasons }) => reasons.includes('InvalidPrefix')), 'Chromium must identify Domain violation as InvalidPrefix');
  const before = snapshot(fx);
  const response = await complete(a, fx, tuple);
  const after = snapshot(fx);
  fx.siblingObservation = { blocked, apiCallbacks: after.apiCallback - before.apiCallback, tokenExchanges: after.token - before.token,
    consumed: after.consumed - before.consumed, landing: new URL(a.page.url()).pathname,
    sessions: (await a.context.cookies()).filter((cookie) => cookie.name === '__Host-raibitserver_session').length };
  // Then: even with a valid browser ID, legacy state/verifier are not accepted by the actual BFF.
  assert.equal(after.apiCallback - before.apiCallback, 0, 'legacy sibling cookies must not reach the Nest callback');
  assert.equal(new URL(a.page.url()).pathname, '/login');
  assert.equal(after.token - before.token, 0);
  assert.equal(after.consumed - before.consumed, 0);
  assert.equal((await a.context.cookies()).some((cookie) => cookie.name === '__Host-raibitserver_session'), false);
  await assertDeletion(response);
  await assertCleared(a, fx);
  outcomes.push({ case: 'sibling-domain', actualSetCookieHeaders: 6, legacyParentCookiesAccepted: 3, blocked, apiCallbacks: 0, tokenExchanges: 0, sessions: 0, transientDeletion: true });
  await screenshotClean(a, fx, 'pr17-security-sibling-rejected');
});

test('browser A has 30 starts, stable identity and bounded A31 rejection while fresh B is allowed', { timeout: 45_000 }, async () => {
  // Given: A and B use the same real Nest socket peer and independent Chromium cookie jars.
  const a = await actor();
  const b = await actor();
  const apiBefore = fx.api.length;
  let identity;
  // When: A starts OAuth 31 times, then B starts once.
  for (let count = 1; count <= 30; count++) {
    const response = await start(a, fx);
    assert.equal(response.status(), 302);
    assert.equal(new URL(a.page.url()).hostname, 'github.com');
    const cookies = await a.context.cookies(fx.origin);
    for (const name of [...transientNames, browserName]) {
      const cookie = cookies.find((item) => item.name === name);
      assert.ok(Boolean(cookie));
      assert.equal(cookie.domain, 'console.raibit.test');
      assert.equal(cookie.path, '/'); assert.equal(cookie.secure, true); assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, 'Lax');
    }
    const current = cookies.find((cookie) => cookie.name === browserName).value;
    identity ??= current;
    assert.equal(current === identity, true, 'browser identity must be stable across starts');
  }
  const limited = await start(a, fx);
  assert.equal(limited.status(), 302);
  assert.equal(new URL(a.page.url()).searchParams.get('error'), 'rate_limit_exceeded');
  const retry = Number((await limited.allHeaders())['retry-after']);
  assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 3600);
  assert.equal((await a.context.cookies(fx.origin)).find((cookie) => cookie.name === browserName)?.value === identity, true);
  await start(b, fx);
  // Then: API is the source of A's 429; B's request is accepted despite an identical peer.
  assert.equal(new URL(b.page.url()).hostname, 'github.com');
  const rows = fx.api.slice(apiBefore).filter((row) => row.operation === '/auth/github/login');
  assert.equal(rows.length, 32);
  assert.equal(rows.slice(0, 30).every((row) => row.status === 200), true);
  assert.equal(rows[30].status, 429); assert.equal(rows[31].status, 200);
  assert.equal(new Set(rows.map((row) => row.peer)).size, 1);
  assert.equal((await b.context.cookies(fx.origin)).find((cookie) => cookie.name === browserName)?.value === identity, false);
  outcomes.push({ case: 'browser-rate-isolation', acceptedA: 30, rejectedA: 31, apiStatusA31: 429, browserStatusA31: 302, retryAfter: retry, browserB: 200, sameApiPeer: true, identityStable: true, cookieAttributes: true });
  await screenshotClean(a, fx, 'pr17-security-a-rate-limited');
});

test('copied transaction cookies fail browser B binding and legitimate browser A completes', { timeout: 45_000 }, async () => {
  // Given: two legitimate browser identities and an A transaction with a PKCE-bound provider code.
  const a = await actor();
  const b = await actor();
  await start(a, fx); const tuple = await transaction(a, fx);
  await start(b, fx);
  const identityB = (await b.context.cookies(fx.origin)).find((cookie) => cookie.name === browserName)?.value;
  fx.injection = transientNames.map((name, index) => `${name}=${[tuple.state, tuple.verifier][index]}; Path=/; Secure; HttpOnly; SameSite=Lax`);
  await navigate(b.page, `${fx.origin}/pr17-security/transplant`);
  assert.equal((await b.context.cookies(fx.origin)).find((cookie) => cookie.name === browserName)?.value === identityB, true);
  const before = snapshot(fx);
  // When: B submits A's state/code with copied transient cookies but its own signed browser identity.
  const denied = await complete(b, fx, tuple);
  const rejected = snapshot(fx);
  assert.equal(new URL(b.page.url()).pathname, '/login');
  assert.equal(rejected.apiCallback - before.apiCallback, 1);
  assert.equal(fx.api.at(-1).status, 400);
  assert.equal(rejected.token - before.token, 0); assert.equal(rejected.consumed - before.consumed, 0);
  assert.equal((await b.context.cookies()).some((cookie) => cookie.name === '__Host-raibitserver_session'), false);
  await assertDeletion(denied); await assertCleared(b, fx);
  // Then: the rejected attempt leaves A's transaction usable for one real API exchange and session.
  const accepted = await complete(a, fx, tuple);
  assert.equal(new URL(a.page.url()).pathname, '/console');
  const finished = snapshot(fx);
  assert.equal(finished.token - rejected.token, 1); assert.equal(finished.pkce - rejected.pkce, 1); assert.equal(finished.consumed - rejected.consumed, 1);
  const session = (await a.context.cookies(fx.origin)).find((cookie) => cookie.name === '__Host-raibitserver_session')?.value;
  assert.ok(Boolean(session)); fx.runtime.secrets.add(session);
  assert.equal((await fetch(`${fx.runtime.nest.baseUrl}/auth/me`, { headers: { authorization: `Bearer ${session}` }, signal: AbortSignal.timeout(5000) })).status, 200);
  await assertDeletion(accepted); await assertCleared(a, fx);
  assert.equal((await a.context.cookies(fx.origin)).find((cookie) => cookie.name === browserName)?.value === tuple.identity, true);
  outcomes.push({ case: 'copied-binding-and-legitimate-callback', copiedApiStatus: 400, copiedExchanges: 0, copiedSessions: 0, originalExchanges: 1, pkce: 1, consumed: 1, authenticatedMeStatus: 200, transientDeletion: true, browserIdentityRetained: true });
  await screenshotClean(a, fx, 'pr17-security-legitimate-completed');
});

test('browser-supplied reserved relay and raw HTTPS duplicate cookies stop before API', { timeout: 45_000 }, async () => {
  // Given: real browser fetches carry deliberately forged boundary input.
  const a = await actor();
  await navigate(a.page, `${fx.origin}/login`);
  const before = snapshot(fx);
  // When: a browser supplies the reserved relay header.
  const reservedResponse = a.page.waitForResponse((item) => new URL(item.url()).pathname === loginPath);
  const status = await a.page.evaluate(async (url) => (await fetch(url, { headers: { 'x-raibitserver-oauth-relay': 'forged' } })).status, `${fx.origin}${loginPath}`);
  assert.equal(status, 200);
  assert.equal((await reservedResponse).status(), 302);
  assert.equal(new URL((await (await reservedResponse).allHeaders()).location).searchParams.get('error'), 'github_oauth_relay_invalid');
  assert.equal(snapshot(fx).apiStart - before.apiStart, 0);
  // Then: raw HTTPS verifies duplicates. Chromium owns Cookie headers and ignores Playwright overrides.
  for (const name of [browserName, ...transientNames]) {
    const response = await duplicateRequest(fx, name);
    assert.equal(response.status, 302);
    assert.equal(new URL(response.location).pathname, '/login');
    assert.equal(new URL(response.location).searchParams.get('error'), 'github_oauth_state_invalid');
    assert.equal(snapshot(fx).apiStart - before.apiStart, 0);
    assert.equal(fx.bff.at(-1).cookieNames.filter((item) => item === name).length, 2);
  }
  outcomes.push({ case: 'reserved-and-duplicate-input', reservedApiStarts: 0, duplicateNamesTested: 3, duplicateApiStarts: 0, duplicateTransport: 'raw Node HTTPS request; BFF parsing proof, not browser cookie-prefix enforcement' });
});
