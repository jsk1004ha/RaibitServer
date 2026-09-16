import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import http from 'node:http';
import { RAIBITSERVERClient } from '../packages/api-client/src/index.ts';
import { GitHubOAuthStartInput, GitHubOAuthCallbackInput } from '../packages/schemas/src/api-contract.ts';
import { bootOAuthRuntime, oauthRequest, verifierPair, OAUTH_CALLBACK, OAUTH_AVATAR } from './fixtures/github-oauth-runtime.mjs';

for (const surfaceName of ['nest', 'core']) test(`reject callback without start on actual ${surfaceName} route before provider exchange`, async () => {
  // Given: real Nest/core routes and a verified approved account, but no transaction.
  const runtime = await bootOAuthRuntime();
  try {
    for (const surface of runtime.surfaces.filter((entry) => entry.name === surfaceName)) {
      const pair = verifierPair();
      // When: an attacker invents syntactically valid state and verifier.
      const result = await oauthRequest(surface.baseUrl, '/auth/github/callback', {
        code: runtime.issueCode(), state: crypto.randomBytes(32).toString('base64url'), codeVerifier: pair.codeVerifier,
      });
      // Then: fail before any provider call, account linking or session issuance.
      assert.equal(result.status, 400, `${surface.name}: no-start callback must fail closed`);
      assert.equal(Boolean(result.body.token), false);
      assert.equal(runtime.counters.token, 0);
      assert.equal(surface.store.findUserByEmail('oauth-member@example.test').githubId, null);
    }
  } finally { await runtime.close(); }
});

for (const surfaceName of ['nest', 'core']) test(`OAuth transaction adversarial matrix on real ${surfaceName} routes`, async (t) => {
  const runtime = await bootOAuthRuntime({ transactionBudgets: true });
  const surface = runtime.surfaces.find((entry) => entry.name === surfaceName);
  const request = (path, input) => oauthRequest(surface.baseUrl, path, input);
  async function start() {
    const pair = verifierPair();
    const result = await request('/auth/github/login', { codeChallenge: pair.codeChallenge });
    assert.equal(result.status, 200);
    runtime.secrets.add(pair.codeVerifier); runtime.secrets.add(result.body.state);
    return { ...pair, state: result.body.state };
  }
  function callback(flow, extra = {}) { return { state: flow.state, codeVerifier: flow.codeVerifier, code: runtime.issueCode({ challenge: flow.codeChallenge }), ...extra }; }
  function rejected(result, before, status = 400) {
    assert.equal(result.status, status);
    assert.equal(Boolean(result.body.token), false);
    assert.equal(runtime.counters.token, before);
    const serialized = JSON.stringify(result.body);
    assert.equal([...runtime.secrets].some((value) => serialized.includes(value)), false, 'public errors must contain no fixture credentials');
  }
  try {
    await t.test('required canonical challenge and server-owned state', async () => {
      for (const input of [{}, { codeChallenge: 'plain' }, { codeChallenge: 'A'.repeat(42) + 'B' }, { codeChallenge: 'A'.repeat(43), state: 'A'.repeat(43) }]) {
        assert.equal((await request('/auth/github/login', input)).status, 400);
        assert.equal(GitHubOAuthStartInput.safeParse(input).success, false);
      }
      const first = await start(); const second = await start();
      assert.equal(first.state.length, 43); assert.equal(first.state !== second.state, true);
      const result = await request('/auth/github/login', { codeChallenge: first.codeChallenge });
      assert.equal(JSON.stringify(result.body).includes(first.codeVerifier), false);
      const authorize = new URL(result.body.oauthUrl);
      assert.equal(authorize.searchParams.get('code_challenge'), first.codeChallenge);
      assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(authorize.searchParams.get('redirect_uri'), OAUTH_CALLBACK);
      assert.equal(authorize.searchParams.get('state') === result.body.state, true);
    });
    await t.test('direct typed client starts and obtains a current session with provider avatar', async () => {
      const pair = verifierPair();
      const client = new RAIBITSERVERClient({ baseUrl: surface.baseUrl });
      const started = await client.githubLogin({ codeChallenge: pair.codeChallenge });
      const result = await client.githubCallback({ state: started.state, codeVerifier: pair.codeVerifier, code: runtime.issueCode({ challenge: pair.codeChallenge }) });
      runtime.secrets.add(result.token);
      assert.equal(result.user.avatarUrl, OAUTH_AVATAR);
      assert.equal(result.user.name, 'Approved Name');
      const current = await client.withToken(result.token).me();
      assert.equal(current.user.githubId, '4242');
      const claims = JSON.parse(Buffer.from(result.token.split('.')[1], 'base64url').toString());
      assert.equal(claims.sessionVersion, surface.store.findUserByEmail('oauth-member@example.test').sessionVersion);
      assert.equal(runtime.counters.pkce, 1);
      surface.store.users.get(result.user.id).sessionVersion += 1;
      assert.equal((await oauthRequest(surface.baseUrl, '/auth/me', {}, result.token)).status, 401);
    });
    await t.test('missing code/state/verifier and duplicate parameters fail before exchange', async () => {
      const flow = await start(); const before = runtime.counters.token;
      for (const key of ['code', 'state', 'codeVerifier']) {
        const input = callback(flow); delete input[key];
        assert.equal(GitHubOAuthCallbackInput.safeParse(input).success, false);
        rejected(await request('/auth/github/callback', input), before);
      }
      const repeated = new URLSearchParams(callback(flow)); repeated.append('state', flow.state);
      const response = await fetch(`${surface.baseUrl}/auth/github/callback?${repeated}`);
      rejected({ status: response.status, body: await response.json() }, before);
    });
    await t.test('state/verifier/redirect mismatches fail without consuming a matching transaction', async () => {
      const flow = await start(); const before = runtime.counters.token;
      for (const extra of [{ state: crypto.randomBytes(32).toString('base64url') }, { codeVerifier: verifierPair().codeVerifier }, { redirectUri: 'https://attacker.example/callback' }]) {
        rejected(await request('/auth/github/callback', callback(flow, extra)), before);
      }
      rejected(await request('/auth/github/login', { codeChallenge: flow.codeChallenge, redirectUri: 'https://attacker.example/callback' }), before);
      assert.equal((await request('/auth/github/callback', callback(flow))).status, 200);
    });
    await t.test('actual peer drift fails and spoofed forwarded headers do not rebind source', async () => {
      const flow = await start(); const before = runtime.counters.token;
      const url = new URL(`${surface.baseUrl}/auth/github/callback?${new URLSearchParams(callback(flow))}`);
      const result = await new Promise((resolve, reject) => {
        const req = http.get(url, { localAddress: '127.0.0.2', headers: { 'x-forwarded-for': '127.0.0.1' } }, (res) => {
          let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        }); req.on('error', reject);
      });
      rejected(result, before);
      const response = await fetch(`${surface.baseUrl}/auth/github/callback?${new URLSearchParams(callback(flow))}`, { headers: { 'x-forwarded-for': '198.51.100.20' } });
      assert.equal(response.status, 200);
    });
    await t.test('expiry and replay including concurrent callbacks have one exchange winner', async () => {
      const expired = await start(); const before = runtime.counters.token;
      const hash = crypto.createHash('sha256').update(expired.state).digest('hex');
      const row = surface.store.oauthTransactions.get(hash);
      surface.store.oauthTransactions.set(hash, { ...row, expiresAt: 0 });
      rejected(await request('/auth/github/callback', callback(expired)), before);
      const flow = await start(); const input = callback(flow);
      const results = await Promise.all(Array.from({ length: 2 }, () => request('/auth/github/callback', input)));
      assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
      assert.equal(runtime.counters.token, before + 1);
      rejected(await request('/auth/github/callback', input), before + 1, 409);
    });
    await t.test('provider denial never exchanges and upstream failure remains consumed', async () => {
      const denied = await start(); let before = runtime.counters.token;
      rejected(await request('/auth/github/callback', { ...callback(denied), error: 'access_denied', error_description: runtime.issueCode() }), before);
      const flow = await start(); const input = callback(flow, { code: runtime.issueCode({ failure: true }) });
      const failure = await request('/auth/github/callback', input);
      rejected(failure, before + 1, 502);
      before = runtime.counters.token;
      rejected(await request('/auth/github/callback', input), before, 409);
    });
    await t.test('cancelled callback cannot resume a consumed exchange', async () => {
      const flow = await start(); const before = runtime.counters.token;
      const input = callback(flow, { code: runtime.issueCode({ challenge: flow.codeChallenge, stall: true }) });
      const controller = new AbortController();
      const pending = fetch(`${surface.baseUrl}/auth/github/callback?${new URLSearchParams(input)}`, { signal: controller.signal }).then(() => false, (error) => error.name === 'AbortError');
      const deadline = Date.now() + 2000;
      while (runtime.counters.token === before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(runtime.counters.token, before + 1);
      controller.abort();
      assert.equal(await pending, true);
      rejected(await request('/auth/github/callback', input), before + 1, 409);
    });
    await t.test('unverified provider email and unknown or unapproved account never get sessions', async () => {
      const localUser = surface.store.findUserByEmail('oauth-member@example.test');
      const stored = surface.store.users.get(localUser.id);
      for (const policy of ['provider-unverified', 'unknown', 'pending', 'local-unverified']) {
        const flow = await start(); const profile = { challenge: flow.codeChallenge };
        if (policy === 'provider-unverified') profile.verified = false;
        if (policy === 'unknown') { profile.email = 'unknown@example.test'; profile.githubId = 7777; }
        if (policy === 'pending') stored.approvalStatus = 'PENDING';
        if (policy === 'local-unverified') stored.emailVerifiedAt = null;
        const input = callback(flow, { code: runtime.issueCode(profile) });
        const result = await request('/auth/github/callback', input);
        assert.equal(result.status >= 400 && result.status < 500, true); assert.equal(Boolean(result.body.token), false);
        assert.equal((await request('/auth/github/callback', input)).status, 409);
        stored.approvalStatus = 'APPROVED'; stored.emailVerifiedAt = new Date().toISOString();
      }
    });
    await t.test('avatar allowlist and missing-name fill preserve safe identity', async () => {
      const stored = surface.store.users.get(surface.store.findUserByEmail('oauth-member@example.test').id);
      for (const initialAvatar of [OAUTH_AVATAR, null]) {
        stored.name = null; stored.avatarUrl = initialAvatar;
        const flow = await start();
        const result = await request('/auth/github/callback', callback(flow, { code: runtime.issueCode({ avatar: 'https://attacker.example/photo', name: 'Safe Provider' }) }));
        assert.equal(result.status, 200); assert.equal(result.body.user.avatarUrl, initialAvatar); assert.equal(result.body.user.name, 'Safe Provider');
      }
    });
    await t.test('configured malformed preferred key fails closed and raw credentials stay out of rows', async () => {
      const pair = verifierPair(); const before = runtime.counters.token;
      for (const value of ['', 'short', 's'.repeat(513)]) {
        process.env.RAIBITSERVER_AUTH_RATE_LIMIT_KEY_SECRET = value;
        rejected(await request('/auth/github/login', { codeChallenge: pair.codeChallenge }), before, 503);
      }
      delete process.env.RAIBITSERVER_AUTH_RATE_LIMIT_KEY_SECRET;
      const serialized = JSON.stringify([...surface.store.oauthTransactions.values()]);
      assert.equal([...runtime.secrets].some((value) => serialized.includes(value)), false);
      assert.equal(serialized.includes('127.0.0.1'), false);
    });
  } finally { await runtime.close(); }
});
