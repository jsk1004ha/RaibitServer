import assert from 'node:assert/strict';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { bootSecurityBrowser } from '../fixture/pr17-security-browser.mjs';
import { navigate, start, transaction, complete } from '../fixture/pr17-security-assertions.mjs';

const sessionName = '__Host-raibitserver_session';
const legacyName = 'raibitserver_session';
const outcomes = [];
let fx;
let actors = [];

before(async () => { fx = await bootSecurityBrowser(); }, { timeout: 60_000 });
beforeEach(() => { for (const surface of fx.runtime.surfaces) surface.store.authRateLimits.clear(); });
afterEach(async () => { await Promise.all(actors.map(({ context }) => context.close())); actors = []; fx.injection = []; });
after(async () => {
  if (!fx) return;
  await fx.close();
  const report = JSON.stringify({ mode: fx.mode, chromium: fx.version, headed: process.env.RAIBIT_PR17_HEADLESS !== '1',
    sourceSeam: 'actual Next route + actual api.ts credential reader; AsyncLocalStorage next/headers request injection; real Nest HTTP; mock GitHub provider',
    outcomes, api: fx.api, bff: fx.bff, faults: fx.faults }, null, 2);
  assert.equal([...fx.runtime.secrets].some((secret) => typeof secret === 'string' && secret.length >= 16 && report.includes(secret)), false);
  await fs.writeFile(path.join(fx.evidence, `pr17-session-${fx.mode}-results.json`), report);
});

async function actor() {
  const context = await fx.browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return [fx.origin, fx.tenantOrigin].includes(url.origin) || url.hostname === 'github.com' && url.pathname === '/login/oauth/authorize'
      ? route.continue() : route.abort('blockedbyclient');
  });
  const value = { context, page: await context.newPage() };
  actors.push(value);
  return value;
}

async function login(person, profile = {}) {
  await start(person, fx);
  const tuple = await transaction(person, fx);
  const challenge = new URL(person.page.url()).searchParams.get('code_challenge');
  const code = fx.runtime.issueCode({ ...profile, challenge });
  const response = await complete(person, fx, { ...tuple, code });
  assert.equal(new URL(person.page.url()).pathname, '/console');
  const jar = await person.context.cookies(fx.origin);
  const token = jar.find((cookie) => [sessionName, legacyName].includes(cookie.name))?.value;
  assert.ok(Boolean(token), 'real OAuth callback must mint a valid session');
  fx.runtime.secrets.add(token);
  const me = await fetch(`${fx.runtime.nest.baseUrl}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200, 'each actor must hold an actually valid Nest credential');
  const body = await me.json();
  return { token, userId: body.user.id, response };
}

async function current(person) {
  await navigate(person.page, `${fx.origin}/console`);
  return person.page.evaluate(async () => {
    const response = await fetch('/api/control/auth/me');
    const body = await response.json();
    return { status: response.status, userId: body.user?.id ?? null };
  });
}

async function inject(person, lines, sibling = true) {
  fx.injection = lines;
  return navigate(person.page, `${sibling ? fx.tenantOrigin : fx.origin}/pr17-security/${sibling ? 'inject' : 'transplant'}`);
}

function assertAttributes(line) {
  assert.ok(/; Path=\/(?:;|$)/i.test(line), 'session Path=/');
  assert.ok(/; Secure(?:;|$)/i.test(line), 'session always Secure');
  assert.ok(/; HttpOnly(?:;|$)/i.test(line), 'session HttpOnly');
  assert.ok(/; SameSite=Lax(?:;|$)/i.test(line), 'session SameSite=Lax');
  assert.equal(/; Domain=/i.test(line), false, 'session host-only');
}

test('sibling Domain cookies cannot replace the victim identity read by actual dashboard auth/me', { timeout: 45_000 }, async () => {
  // Given: two different users hold real OAuth sessions accepted by Nest.
  const victim = await actor();
  const attacker = await actor();
  const victimSession = await login(victim);
  fx.runtime.nest.repository.store.createUser({ name: 'Attacker', email: 'session-attacker@example.test',
    approvalStatus: 'APPROVED', emailVerifiedAt: new Date().toISOString() });
  const attackerSession = await login(attacker, { githubId: 4343, email: 'session-attacker@example.test' });
  assert.notEqual(victimSession.userId, attackerSession.userId);
  assert.equal(victimSession.token === attackerSession.token, false);
  await victim.context.clearCookies({ name: legacyName });
  await inject(victim, [`${sessionName}=${victimSession.token}; Path=/; Secure; HttpOnly; SameSite=Lax`], false);
  const cdp = await victim.context.newCDPSession(victim.page);
  await cdp.send('Network.enable');
  const blocked = [];
  cdp.on('Network.responseReceivedExtraInfo', (event) => {
    for (const cookie of event.blockedCookies || []) blocked.push({ name: cookie.cookieLine.split('=', 1)[0], reasons: cookie.blockedReasons });
  });
  // When: a sibling sends both old and protected names carrying the attacker's valid credential.
  const response = await inject(victim, [legacyName, sessionName].map((name) =>
    `${name}=${attackerSession.token}; Domain=raibit.test; Path=/; Secure; HttpOnly; SameSite=Lax`));
  assert.equal((await response.headersArray()).filter(({ name }) => name.toLowerCase() === 'set-cookie').length, 2);
  const jar = await victim.context.cookies(fx.origin);
  assert.equal(jar.some((cookie) => cookie.name === legacyName && cookie.domain === '.raibit.test' && cookie.value === attackerSession.token), true);
  assert.equal(jar.some((cookie) => cookie.name === sessionName && cookie.domain === 'console.raibit.test' && cookie.value === victimSession.token), true);
  assert.deepEqual(blocked.map(({ name }) => name), [sessionName]);
  assert.ok(blocked.every(({ reasons }) => reasons.includes('InvalidPrefix')));
  // Then: the real dashboard reader forwards the victim credential to real Nest auth/me.
  const actual = await current(victim);
  outcomes.push({ case: 'sibling-session-injection', distinctValidUsers: true, blocked, status: actual.status,
    remainsVictim: actual.userId === victimSession.userId, becameAttacker: actual.userId === attackerSession.userId });
  assert.deepEqual(actual, { status: 200, userId: victimSession.userId });
});

test('legacy-only valid credential is unauthorized and never migrated into a protected session', { timeout: 45_000 }, async () => {
  // Given: a valid credential is available to a sibling, and the visitor has no session.
  const owner = await actor();
  const session = await login(owner);
  const visitor = await actor();
  await inject(visitor, [`${legacyName}=${session.token}; Domain=raibit.test; Path=/; Secure; HttpOnly; SameSite=Lax`]);
  // When: the visitor calls the dashboard authentication endpoint.
  const actual = await current(visitor);
  // Then: legacy credentials are ignored, with no migration side effect.
  outcomes.push({ case: 'anonymous-legacy-only', status: actual.status, authenticated: actual.userId !== null });
  assert.deepEqual(actual, { status: 401, userId: null });
  assert.equal((await visitor.context.cookies(fx.origin)).some((cookie) => cookie.name === sessionName), false);
});

test('OAuth callback sets protected session attributes and explicitly expires the old host cookie', { timeout: 45_000 }, async () => {
  // Given: an old host session cookie exists before login.
  const person = await actor();
  await inject(person, [`${legacyName}=obsolete; Path=/; Secure; HttpOnly; SameSite=Lax`], false);
  // When: real OAuth login completes.
  const { response } = await login(person);
  // Then: the browser receives the protected contract and explicit old-cookie deletion.
  const lines = (await response.headersArray()).filter(({ name }) => name.toLowerCase() === 'set-cookie').map(({ value }) => value);
  const session = lines.find((line) => line.startsWith(`${sessionName}=`));
  assert.ok(session, 'callback must issue __Host session');
  assertAttributes(session);
  assert.ok(lines.some((line) => line.startsWith(`${legacyName}=`) && /; Max-Age=0(?:;|$)/i.test(line)), 'callback must explicitly expire legacy session');
  const jar = await person.context.cookies(fx.origin);
  assert.equal(jar.some((cookie) => cookie.name === legacyName), false);
  assert.equal(jar.some((cookie) => cookie.name === sessionName && cookie.secure && cookie.httpOnly && cookie.path === '/' && cookie.sameSite === 'Lax' && cookie.domain === 'console.raibit.test'), true);
  outcomes.push({ case: 'callback-cookie-contract', protectedAttributes: true, legacyExplicitlyExpired: true });
});

test('logout clears the protected cookie and subsequent dashboard auth/me is unauthorized', { timeout: 45_000 }, async () => {
  // Given: a real authenticated session is active.
  const person = await actor();
  await login(person);
  // When: the browser submits same-origin logout to the actual dashboard route.
  const pending = person.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/control/auth/logout');
  const status = await person.page.evaluate(async () => (await fetch('/api/control/auth/logout', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' })).status);
  const response = await pending;
  assert.equal(status, 200);
  // Then: the deletion has the host contract and the browser loses authentication.
  const lines = (await response.headersArray()).filter(({ name }) => name.toLowerCase() === 'set-cookie').map(({ value }) => value);
  const deletion = lines.find((line) => line.startsWith(`${sessionName}=`) && /; Max-Age=0(?:;|$)/i.test(line));
  assert.ok(deletion, 'logout must explicitly clear protected session');
  assertAttributes(deletion);
  assert.equal((await person.context.cookies(fx.origin)).some((cookie) => cookie.name === sessionName), false);
  assert.deepEqual(await current(person), { status: 401, userId: null });
  outcomes.push({ case: 'logout', protectedCookieCleared: true, subsequentStatus: 401 });
});
