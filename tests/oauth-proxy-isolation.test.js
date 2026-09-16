import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { bootOAuthRuntime, verifierPair } from './fixtures/github-oauth-runtime.mjs';
import * as core from '../packages/core/src/index.ts';

const secret = 'ab'.repeat(32);
const header = 'x-raibitserver-oauth-relay';
const browserA = 'a1'.repeat(32);
const browserB = 'b2'.repeat(32);

// Independent wire implementation: never use the production signer for HTTP regressions.
function relay(query, { browserId = browserA, operation = 'login', now = Date.now(), key = secret, method = 'GET' } = {}) {
  const entries = Object.keys(query).sort().map(name => [name, query[name]]);
  const payload = JSON.stringify([browserId, now, method, operation, entries]);
  const mac = createHmac('sha256', Buffer.from(key, 'hex')).update('raibitserver:oauth-relay:v1\0').update(payload).digest('hex');
  return `v1.${browserId}.${now}.${mac}`;
}

async function request(surface, { operation = 'login', query = {}, headers = {} }) {
  const url = new URL(`/auth/github/${operation}?${new URLSearchParams(query)}`, surface.baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: Array.isArray(headers) ? ['Host', url.host, ...headers] : headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

for (const name of ['core', 'nest']) {
  test(`${name}: authenticated browsers have independent budgets on the same peer`, async () => {
    const runtime = await bootOAuthRuntime();
    process.env.RAIBITSERVER_OAUTH_RELAY_SECRET = secret;
    const surface = runtime.surfaces.find(item => item.name === name);
    const query = { codeChallenge: verifierPair().codeChallenge };
    try {
      // Given A has used all 30 allowed starts, when A retries and B starts on the same socket peer.
      for (let i = 0; i < 30; i++) assert.equal((await request(surface, { query, headers: { [header]: relay(query) } })).status, 200);
      const a = await request(surface, { query, headers: { [header]: relay(query) } });
      const b = await request(surface, { query, headers: { [header]: relay(query, { browserId: browserB }) } });
      // Then A is capped, B starts, and every attempt receives its terminal audit.
      assert.equal(a.status, 429);
      assert.equal(b.status, 200);
      assert.equal(surface.store.oauthTransactions.size, 31);
      assert.equal(surface.store.auditLogs.filter(row => row.action === 'auth.github-oauth-start').length, 32);
    } finally { await runtime.close(); }
  });

  test(`${name}: invalid relay evidence fails closed and is charged to the peer`, async t => {
    const runtime = await bootOAuthRuntime();
    process.env.RAIBITSERVER_OAUTH_RELAY_SECRET = secret;
    const surface = runtime.surfaces.find(item => item.name === name);
    const query = { codeChallenge: verifierPair().codeChallenge };
    const good = relay(query);
    const variants = [
      ['MAC', { query, headers: { [header]: relay(query, { key: 'cd'.repeat(32) }) } }],
      ['expired', { query, headers: { [header]: relay(query, { now: Date.now() - 31_000 }) } }],
      ['future', { query, headers: { [header]: relay(query, { now: Date.now() + 60_000 }) } }],
      ['query mismatch', { query: { codeChallenge: verifierPair().codeChallenge }, headers: { [header]: good } }],
      ['operation mismatch', { query, headers: { [header]: relay(query, { operation: 'callback' }) } }],
      ['method mismatch', { query, headers: { [header]: relay(query, { method: 'POST' }) } }],
      ['repeated headers', { query, headers: { [header]: [good, good] } }],
      ['mixed-case repeats', { query, headers: [header, good, 'X-Raibitserver-Oauth-Relay', good] }],
      ['empty header', { query, headers: { [header]: '' } }],
      ['oversize header', { query, headers: { [header]: 'x'.repeat(161) } }],
      ['duplicate query', { query: [['codeChallenge', query.codeChallenge], ['codeChallenge', query.codeChallenge]], headers: { [header]: good } }],
    ];
    try {
      // Given invalid authenticated-source claims, when either HTTP adapter receives them.
      for (const [variant, input] of variants) await t.test(variant, async () => {
        const result = await request(surface, input);
        // Then fixed denial, no provider work/transaction, one peer/global budget charge.
        assert.equal(result.status, 403);
        assert.equal(result.body.message, 'github_oauth_relay_invalid');
        assert.deepEqual(result.body, { statusCode: 403, message: 'github_oauth_relay_invalid', error: 'github_oauth_relay_invalid' });
      });
      assert.equal(surface.store.oauthTransactions.size, 0);
      assert.equal(runtime.counters.token, 0);
      assert.deepEqual([...surface.store.authRateLimits.values()].map(row => row.count), [variants.length, variants.length, variants.length]);
      const events = surface.store.auditLogs.filter(row => row.action === 'auth.github-oauth-start');
      assert.equal(events.length, variants.length);
      assert.equal(events.every(row => row.metadata.errorCode === 'github_oauth_relay_invalid'), true);
      for (const row of events) assert.deepEqual(row.metadata, { outcome: 'denial', errorCode: 'github_oauth_relay_invalid', cleanup: 'complete' });
      for (const value of [secret, browserA, good, good.split('.').at(-1), header]) assert.equal(JSON.stringify(events).includes(value), false);
      // A present forged relay still gets the fixed denial after exhausting the peer budget.
      for (let i = variants.length; i < 31; i++) assert.equal((await request(surface, variants[0][1])).status, 403);
      assert.equal((await request(surface, { query })).status, 429);
      assert.equal((await request(surface, { query, headers: { [header]: relay(query, { browserId: browserB }) } })).status, 200);
    } finally { await runtime.close(); }
  });

  test(`${name}: missing relay key fails closed while direct callers retain socket limits`, async t => {
    const runtime = await bootOAuthRuntime();
    const surface = runtime.surfaces.find(item => item.name === name);
    const query = { codeChallenge: verifierPair().codeChallenge };
    try {
      // Given configured JWT but no valid dedicated relay secret, when a relay is presented.
      for (const key of [undefined, '', 'AB'.repeat(32), 'a'.repeat(63), 'g'.repeat(64)]) await t.test(String(key), async () => {
        if (key === undefined) delete process.env.RAIBITSERVER_OAUTH_RELAY_SECRET;
        else process.env.RAIBITSERVER_OAUTH_RELAY_SECRET = key;
        const result = await request(surface, { query, headers: { [header]: relay(query) } });
        assert.equal(result.status, 503);
        assert.equal(result.body.message, 'github_oauth_relay_not_configured');
      });
      assert.equal(surface.store.oauthTransactions.size, 0);
      // When direct callers rotate untrusted forwarding headers, then they share the charged peer budget.
      delete process.env.RAIBITSERVER_OAUTH_RELAY_SECRET;
      process.env.RAIBITSERVER_TRUST_PROXY_HEADERS = '1';
      process.env.RAIBITSERVER_AUTH_RATE_LIMIT_TRUST_PROXY = '1';
      for (let i = 5; i < 30; i++) assert.equal((await request(surface, { query, headers: { 'x-forwarded-for': `198.51.100.${i}` } })).status, 200);
      assert.equal((await request(surface, { query, headers: { 'x-forwarded-for': '203.0.113.1' } })).status, 429);
    } finally { await runtime.close(); }
  });

  test(`${name}: callback authenticates browser source before atomic consume and rejects replay`, async () => {
    const runtime = await bootOAuthRuntime();
    process.env.RAIBITSERVER_OAUTH_RELAY_SECRET = secret;
    const surface = runtime.surfaces.find(item => item.name === name);
    const pair = verifierPair();
    const login = { codeChallenge: pair.codeChallenge };
    try {
      const started = await request(surface, { query: login, headers: { [header]: relay(login) } });
      assert.equal(started.status, 200);
      const query = { state: started.body.state, codeVerifier: pair.codeVerifier, code: runtime.issueCode({ challenge: pair.codeChallenge }) };
      // Given A's transaction, when B from the same peer tries its otherwise valid callback.
      const mismatch = await request(surface, { operation: 'callback', query, headers: { [header]: relay(query, { browserId: browserB, operation: 'callback' }) } });
      assert.equal(mismatch.status, 400);
      assert.equal(mismatch.body.message, 'oauth_transaction_mismatch');
      assert.equal(runtime.counters.token, 0);
      assert.equal([...surface.store.oauthTransactions.values()][0].consumedAt, null);
      const headers = { [header]: relay(query, { operation: 'callback' }) };
      const results = await Promise.all([request(surface, { operation: 'callback', query, headers }), request(surface, { operation: 'callback', query, headers })]);
      // Then A completes once with PKCE; replay never reaches the provider a second time.
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
      assert.equal(results.some(result => Boolean(result.body.token)), true);
      assert.equal(runtime.counters.token, 1);
      assert.equal(runtime.counters.pkce, 1);
      assert.equal(runtime.counters.consumedBeforeExchange, 1);
    } finally { await runtime.close(); }
  });
}

test('authenticated source binding survives different dashboard replica peers', async () => {
  const runtime = await bootOAuthRuntime();
  process.env.RAIBITSERVER_OAUTH_RELAY_SECRET = secret;
  const store = runtime.plane.store;
  const pair = verifierPair();
  const login = { codeChallenge: pair.codeChallenge };
  const context = { jwtSecret: process.env.RAIBITSERVER_AUTH_JWT_SECRET };
  try {
    // Given a login relayed by one replica, when another replica relays its callback.
    const plan = await core.oauthAttempt(store, 'github-oauth-start', () => core.startGitHubOAuth(store, login, { ...context, source: '10.0.0.1', rawHeaders: [header, relay(login)] }));
    const query = { state: plan.state, codeVerifier: pair.codeVerifier, code: runtime.issueCode({ challenge: pair.codeChallenge }) };
    const identity = await core.oauthAttempt(store, 'github-oauth-callback', () => core.consumeGitHubOAuthIdentity(store, query, { ...context, source: '10.0.0.2', rawHeaders: [header, relay(query, { operation: 'callback' })] }));
    // Then the authenticated browser identity still matches and exchanges once.
    assert.equal(identity.email, 'oauth-member@example.test');
    assert.equal(runtime.counters.token, 1);
  } finally { await runtime.close(); }
});

test('relay timestamp tolerates bounded clock skew and rejects outside exact boundaries', async t => {
  const { resolveOAuthSource } = await import('@raibitserver/core/oauth-source');
  const now = 1_700_000_000_000;
  const query = { codeChallenge: verifierPair().codeChallenge };
  for (const offset of [-30_001, -30_000, 0, 1, 5_000, 5_001]) await t.test(`${offset}ms`, () => {
    // Given independently signed evidence with a precise issuer/verifier clock difference.
    const input = { source: '10.0.0.1', operation: 'login', query, now, rawHeaders: [header, relay(query, { now: now + offset })] };
    // When verified, then accept the inclusive 30s past/5s future bounds only.
    if (offset < -30_000 || offset > 5_000) assert.throws(() => resolveOAuthSource(input, secret), { message: 'github_oauth_relay_invalid', statusCode: 403 });
    else assert.equal(resolveOAuthSource(input, secret), `dashboard:${browserA}`);
  });
});

test('cookie and relay helpers implement the independent bounded wire contract', async () => {
  // Given the public API, assert exports before use so RED is an assertion, not an import error.
  assert.equal(typeof core.issueOAuthBrowserCookie, 'function');
  assert.equal(typeof core.parseOAuthBrowserCookie, 'function');
  assert.equal(typeof core.signOAuthRelay, 'function');
  assert.equal(core.OAUTH_RELAY_HEADER, header);
  assert.equal(core.OAUTH_BROWSER_COOKIE_NAME, '__Host-raibitserver_github_oauth_browser');
  const subpath = await import('@raibitserver/core/oauth-source');
  assert.equal(subpath.signOAuthRelay, core.signOAuthRelay);
  const cookie = core.issueOAuthBrowserCookie(secret);
  const [, id, mac] = cookie.split('.');
  assert.match(cookie, /^v1\.[a-f0-9]{64}\.[a-f0-9]{64}$/);
  assert.equal(mac, createHmac('sha256', Buffer.from(secret, 'hex')).update('raibitserver:oauth-browser:v1\0').update(id).digest('hex'));
  assert.equal(core.parseOAuthBrowserCookie(cookie, secret), id);
  for (const value of [undefined, '', [cookie], cookie + 'x', `v1.${browserB}.${mac}`, cookie.toUpperCase()]) assert.equal(core.parseOAuthBrowserCookie(value, secret), null);
  assert.equal(core.parseOAuthBrowserCookie(cookie, 'cd'.repeat(32)), null);
  const input = { browserId: id, operation: 'login', query: { redirectUri: 'https://console.localhost/callback', codeChallenge: verifierPair().codeChallenge }, now: 1_700_000_000_000 };
  assert.equal(core.signOAuthRelay(input, secret), relay(input.query, input));
  for (const query of [{ codeChallenge: ['x', 'x'] }, { code: 'x'.repeat(2049) }, Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`field${i}`, 'x']))]) {
    assert.throws(() => core.signOAuthRelay({ ...input, query }, secret), { message: 'github_oauth_relay_invalid' });
  }
  for (const key of [undefined, '', secret.toUpperCase(), 'x'.repeat(64), secret + '\n']) {
    assert.throws(() => core.issueOAuthBrowserCookie(key), { message: 'github_oauth_relay_not_configured', statusCode: 503 });
    assert.throws(() => core.parseOAuthBrowserCookie(undefined, key), { message: 'github_oauth_relay_not_configured', statusCode: 503 });
  }
});
