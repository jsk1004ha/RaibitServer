import assert from 'node:assert/strict';
import test from 'node:test';
import { bootOAuthRuntime, verifierPair } from './fixtures/github-oauth-runtime.mjs';
import { enforceAuthAbuseLimits } from '../packages/core/src/security.ts';
import { ControlPlaneStore } from '../packages/core/src/store.ts';
import { oauthAttempt } from '../packages/core/src/oauth-security.ts';

async function request(surface, path, query, headers = {}) {
  const response = await fetch(`${surface.baseUrl}/auth/github/${path}?${new URLSearchParams(query)}`, { headers });
  return { status: response.status, retry: response.headers.get('retry-after'), body: await response.json() };
}
async function start(surface) {
  const pair = verifierPair();
  const response = await request(surface, 'login', { codeChallenge: pair.codeChallenge });
  assert.equal(response.status, 200);
  return { ...pair, state: response.body.state };
}
function events(store) { return store.auditLogs.filter((row) => row.action.startsWith('auth.github-oauth')); }

for (const name of ['nest', 'core']) {
  test(`OAuth abuse trusted-source happy path on ${name}`, async () => {
    // Given: real HTTP adapters with real default budgets and an approved account.
    const runtime = await bootOAuthRuntime();
    const surface = runtime.surfaces.find((item) => item.name === name);
    try {
      let flow;
      for (let i = 0; i < 29; i += 1) flow = await start(surface);
      // When: one callback follows 29 starts.
      const response = await request(surface, 'callback', { state: flow.state, codeVerifier: flow.codeVerifier, code: runtime.issueCode({ challenge: flow.codeChallenge }) });
      // Then: one exchange/session, with exactly one audit per attempt and no double charge.
      assert.equal(response.status, 200); assert.equal(Boolean(response.body.token), true);
      assert.equal(runtime.counters.token, 1); assert.equal(events(surface.store).length, 30);
      assert.equal(events(surface.store).at(-1).metadata.outcome, 'success');
      assert.deepEqual([...surface.store.authRateLimits.values()].map((row) => row.count).sort((a, b) => a - b), [1, 1, 29, 30, 30]);
    } finally { await runtime.close(); }
  });

  test(`OAuth abuse adversarial matrix on ${name}`, async (t) => {
    for (const scenario of ['source-cap', 'denial', 'email-cap', 'cleanup', 'audit-failure', 'cleanup-failure', 'failure-cleanup-failure', 'missing-limiter', 'ambiguous-denial', 'callback-audit-failure']) await t.test(scenario, async () => {
      // Given: a fresh real runtime per boundary; no cross-scenario budget pollution.
      const runtime = await bootOAuthRuntime();
      const surface = runtime.surfaces.find((item) => item.name === name);
      try {
        if (scenario === 'source-cap') {
          process.env.RAIBITSERVER_TRUST_PROXY_HEADERS = '1';
          process.env.RAIBITSERVER_AUTH_RATE_LIMIT_TRUST_PROXY = '1';
          for (let i = 0; i < 30; i += 1) await start(surface);
          // When: attacker rotates forwarded headers on attempt 31.
          const response = await request(surface, 'login', {}, { 'x-forwarded-for': '198.51.100.19', forwarded: 'for=198.51.100.20', 'x-real-ip': '198.51.100.21' });
          // Then: rate rejection happens even before invalid input parsing.
          assert.equal(response.status, 429); assert.equal(Number(response.retry) >= 1 && Number(response.retry) <= 3600, true);
          assert.equal(surface.store.oauthTransactions.size, 30); assert.equal(runtime.counters.token, 0);
          assert.equal(events(surface.store).length, 31); assert.equal(events(surface.store).at(-1).metadata.outcome, 'rate_limited');
        }
        if (scenario === 'denial') {
          const flow = await start(surface);
          const input = { state: flow.state, codeVerifier: flow.codeVerifier, error: 'access_denied' };
          // When: a valid bound denial completes the flow.
          const response = await request(surface, 'callback', input);
          // Then: consumed once, no provider/session, replay remains rejected.
          assert.equal(response.status, 400); assert.equal(Boolean(response.body.token), false);
          assert.equal([...surface.store.oauthTransactions.values()][0].consumedAt !== null, true);
          assert.equal((await request(surface, 'callback', input)).status, 409); assert.equal(runtime.counters.token, 0);
          assert.deepEqual(events(surface.store).map((row) => row.metadata.outcome), ['start', 'denial', 'replay']);
        }
        if (scenario === 'email-cap') {
          let response;
          // When: 11 different bound transactions return the same verified email.
          for (let i = 0; i < 11; i += 1) {
            const flow = await start(surface);
            response = await request(surface, 'callback', { state: flow.state, codeVerifier: flow.codeVerifier, code: runtime.issueCode({ challenge: flow.codeChallenge }) });
            if (i < 10) assert.equal(response.status, 200);
          }
          // Then: only email budget rejects; request budgets are charged once each.
          assert.equal(response.status, 429); assert.equal(Boolean(response.body.token), false);
          assert.deepEqual([...surface.store.authRateLimits.values()].map((row) => row.count).sort((a, b) => a - b), [10, 11, 11, 22, 22]);
          assert.equal([...surface.store.oauthTransactions.values()].every((row) => row.consumedAt !== null), true);
        }
        if (scenario === 'cleanup') {
          for (let i = 0; i < 260; i += 1) surface.store.createOAuthTransaction({ state: `expired${String(i).padStart(36, '0')}`, source: 'fixture', sourceSecret: 'x'.repeat(32), redirectUri: 'https://fixture.test/callback', codeChallenge: verifierPair().codeChallenge, now: 0, ttlMs: 1 });
          // When: a current start performs one bounded sweep.
          await start(surface);
          // Then: exactly 256 expired rows gone, active state retained.
          assert.equal(surface.store.oauthTransactions.size, 5);
          await start(surface); assert.equal(surface.store.oauthTransactions.size, 2);
        }
        if (scenario === 'audit-failure') {
          surface.store.recordOAuthAudit = () => { throw new Error('private-runtime-value'); };
          // When: audit storage refuses a would-be successful start.
          const response = await request(surface, 'login', { codeChallenge: verifierPair().codeChallenge });
          // Then: no plan/state is delivered, fixed unavailable response.
          assert.equal(response.status, 503); assert.equal(response.body.message, 'github_oauth_audit_unavailable');
          assert.equal(Boolean(response.body.state), false);
        }
        if (scenario === 'cleanup-failure' || scenario === 'failure-cleanup-failure') {
          surface.store.deleteExpiredOAuthTransactions = () => { throw new Error('private-runtime-value'); };
          // When: cleanup fails after either success or an already-classified auth refusal.
          const response = await request(surface, 'login', scenario === 'cleanup-failure' ? { codeChallenge: verifierPair().codeChallenge } : {});
          // Then: would-be success fails closed; original validation failure retains400.
          assert.equal(response.status, scenario === 'cleanup-failure' ? 503 : 400);
          assert.equal(Boolean(response.body.state), false);
          assert.equal(events(surface.store).length, 1); assert.equal(events(surface.store)[0].metadata.cleanup, 'failed');
          assert.equal(events(surface.store)[0].metadata.outcome, scenario === 'cleanup-failure' ? 'denial' : 'mismatch');
        }
        if (scenario === 'missing-limiter') {
          const repository = name === 'nest' ? runtime.nest.repository : surface.store;
          repository.consumeAuthRateLimit = undefined;
          // When: durable rate capacity is unavailable.
          const response = await request(surface, 'login', { codeChallenge: verifierPair().codeChallenge });
          // Then: never create or expose a transaction.
          assert.equal(response.status, 503); assert.equal(surface.store.oauthTransactions.size, 0);
        }
        if (scenario === 'ambiguous-denial') {
          const flow = await start(surface);
          // When: code and denial are supplied together.
          const response = await request(surface, 'callback', { state: flow.state, codeVerifier: flow.codeVerifier, code: runtime.issueCode(), error: 'access_denied' });
          // Then: no consume, provider or session.
          assert.equal(response.status, 400); assert.equal([...surface.store.oauthTransactions.values()][0].consumedAt, null);
          assert.equal(runtime.counters.token, 0); assert.equal(events(surface.store).at(-1).metadata.outcome, 'mismatch');
        }
        if (scenario === 'callback-audit-failure') {
          const flow = await start(surface); let attempts = 0;
          surface.store.recordOAuthAudit = () => { attempts += 1; throw new Error('private-runtime-value'); };
          // When: the final session-prepared audit fails.
          const response = await request(surface, 'callback', { state: flow.state, codeVerifier: flow.codeVerifier, code: runtime.issueCode({ challenge: flow.codeChallenge }) });
          // Then: no response token and no recursive retry; consumed transaction stays one-use.
          assert.equal(response.status, 503); assert.equal(Boolean(response.body.token), false); assert.equal(attempts, 1);
          assert.equal([...surface.store.oauthTransactions.values()][0].consumedAt !== null, true);
        }
      } finally { await runtime.close(); }
    });
  });
}

test('OAuth phase accounting preserves default all and email-only isolation', async () => {
  // Given: known key, clock, and the real existing limiter/store.
  const store = new ControlPlaneStore();
  const input = { action: 'github-oauth-callback', source: 'fixture', email: 'verified@example.test', now: 1000, env: { RAIBITSERVER_AUTH_RATE_LIMIT_KEY_SECRET: 'x'.repeat(32) } };
  // When: request and provider-verified email phases run once.
  await enforceAuthAbuseLimits(store, { ...input, phase: 'request' });
  await enforceAuthAbuseLimits(store, { ...input, phase: 'email' });
  // Then: four dimensions, each charged once.
  assert.deepEqual([...store.authRateLimits.values()].map((row) => row.count), [1, 1, 1, 1]);
});

test('OAuth abuse adversarial matrix shares flow/global budgets and keeps defaults bounded', async () => {
  // Given: same source, separate actions; actual memory limiter with fixed clock.
  const store = new ControlPlaneStore();
  const env = { RAIBITSERVER_AUTH_RATE_LIMIT_KEY_SECRET: 'x'.repeat(32) };
  const seen = [];
  const consume = store.consumeAuthRateLimit.bind(store);
  store.consumeAuthRateLimit = (input) => { seen.push({ limit: input.limit, windowMs: input.windowMs }); return consume(input); };
  // When: 60 requests rotate3actions while staying below each30action bucket.
  for (let i = 0; i < 60; i += 1) await enforceAuthAbuseLimits(store, { action: `action-${i % 3}`, phase: 'request', source: 'same', env, now: 1000 });
  // Then: request61 is flow-limited; default global/window are exactly5000/60000.
  await assert.rejects(enforceAuthAbuseLimits(store, { action: 'fresh-action', phase: 'request', source: 'same', env, now: 1000 }), (error) => error.statusCode === 429);
  assert.deepEqual(seen.slice(0, 3), [{ limit: 30, windowMs: 60000 }, { limit: 60, windowMs: 60000 }, { limit: 5000, windowMs: 60000 }]);
  const globalStore = new ControlPlaneStore();
  for (let i = 0; i < 2; i += 1) await enforceAuthAbuseLimits(globalStore, { phase: 'request', source: `source-${i}`, env: { ...env, RAIBITSERVER_AUTH_GLOBAL_RATE_LIMIT: '2' }, now: 1000 });
  const size = globalStore.authRateLimits.size;
  await assert.rejects(enforceAuthAbuseLimits(globalStore, { source: 'rotated-source', env: { ...env, RAIBITSERVER_AUTH_GLOBAL_RATE_LIMIT: '2' }, now: 1000 }), (error) => error.statusCode === 429);
  assert.equal(globalStore.authRateLimits.size, size);
});

test('OAuth abuse adversarial matrix fake-clock cleanup preserves active rows during consumption', async (t) => {
  // Given: fixed time and real memory repository, expired consumed/unconsumed plus active rows.
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const store = new ControlPlaneStore();
  const pair = verifierPair();
  const binding = { source: 'fixture', sourceSecret: 'x'.repeat(32), redirectUri: 'https://fixture.test/callback' };
  for (let i = 0; i < 260; i += 1) {
    const state = `expired${String(i).padStart(36, '0')}`;
    store.createOAuthTransaction({ ...binding, state, codeChallenge: pair.codeChallenge, now: 0, ttlMs: 1000 });
    if (i % 2 === 0) store.consumeOAuthTransaction({ ...binding, state, codeVerifier: pair.codeVerifier, now: 999 });
  }
  const state = 'A'.repeat(43);
  store.createOAuthTransaction({ ...binding, state, codeChallenge: pair.codeChallenge, now: 1000 });
  // When: a bounded sweep races with two consumers at the fixed expiry boundary.
  const result = await Promise.allSettled([
    oauthAttempt(store, 'github-oauth-start', async () => true),
    Promise.resolve().then(() => store.consumeOAuthTransaction({ ...binding, state, codeVerifier: pair.codeVerifier, now: 1000 })),
    Promise.resolve().then(() => store.consumeOAuthTransaction({ ...binding, state, codeVerifier: pair.codeVerifier, now: 1000 })),
  ]);
  // Then: one consumer wins, active row retained; later bounded sweep removes only remainder.
  assert.equal(result.filter((item) => item.status === 'fulfilled').length, 2);
  assert.equal(store.oauthTransactions.size, 5);
  await oauthAttempt(store, 'github-oauth-start', async () => true);
  assert.equal(store.oauthTransactions.size, 1);
  assert.equal([...store.oauthTransactions.values()][0].consumedAt, 1000);
});
