import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { bootOAuthRuntime, oauthRequest, verifierPair } from './fixtures/github-oauth-runtime.mjs';
import { InMemoryControlPlaneRepository, PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { publicOAuthError } from '../packages/core/src/oauth-security.ts';
import { startGitHubOAuth } from '../packages/core/src/github-oauth-flow.ts';
import { ControlPlaneStore } from '../packages/core/src/store.ts';

test('OAuth abuse adversarial matrix rejects secret-bearing status exceptions on real routes', async () => {
  // Given: fresh random sentinel and real HTTP surfaces; only repository failure injected.
  const runtime = await bootOAuthRuntime();
  const sentinel = crypto.randomBytes(32).toString('hex');
  try {
    for (const surface of runtime.surfaces) {
      surface.store.createOAuthTransaction = () => { const error = new Error(sentinel); error.statusCode = 502; throw error; };
      // When: an internal typed-looking upstream failure contains a secret.
      const response = await oauthRequest(surface.baseUrl, '/auth/github/login', { codeChallenge: verifierPair().codeChallenge });
      // Then: closed safe error, exactly one sanitized outcome; never print captured material.
      assert.equal(response.status, 502); assert.equal(response.body.message === 'github_oauth_failed', true);
      assert.equal(JSON.stringify({ response, audit: surface.store.auditLogs }).includes(sentinel), false);
      assert.equal(surface.store.auditLogs.filter((row) => row.action.startsWith('auth.github-oauth')).length, 1);
    }
  } finally { await runtime.close(); }
});

test('OAuth audit adapters project only fixed fields with no identity or secret metadata', async () => {
  // Given: both actual adapters; Prisma wire fake captures the existing create invocation.
  const persisted = [];
  const prisma = new PrismaControlPlaneRepository({ auditLog: { create: async ({ data }) => { persisted.push(data); return data; } } });
  const memory = new InMemoryControlPlaneRepository();
  const secret = crypto.randomBytes(32).toString('hex');
  const event = { action: 'github-oauth-callback', outcome: 'denial', errorCode: 'github_oauth_denied', cleanup: 'complete', token: secret, email: secret, source: secret, state: secret };
  // When: both adapters receive an event with unexpected extra secret-bearing fields.
  await memory.recordOAuthAudit(event); await prisma.recordOAuthAudit(event);
  // Then: identical fixed projection; no extra values or IDs become audit dimensions.
  const expected = { actorUserId: null, action: 'auth.github-oauth-callback', targetType: 'auth', targetId: 'github', metadata: { outcome: 'denial', errorCode: 'github_oauth_denied', cleanup: 'complete' } };
  assert.deepEqual(persisted, [expected]);
  const row = memory.store.auditLogs[0];
  assert.deepEqual({ actorUserId: row.actorUserId, action: row.action, targetType: row.targetType, targetId: row.targetId, metadata: row.metadata }, expected);
  assert.equal(JSON.stringify([persisted, row]).includes(secret), false);
});

test('OAuth abuse trusted-source happy path redacts runtime sentinels across real HTTP failures and audit', async () => {
  // Given: distinct random runtime values, retained only in memory.
  const runtime = await bootOAuthRuntime();
  const secrets = new Set([...runtime.secrets].filter((value) => value !== 'oauth-fixture'));
  const captures = [];
  const originalOut = process.stdout.write; const originalErr = process.stderr.write;
  const capture = (chunk, encoding, callback) => { captures.push(String(chunk)); if (typeof encoding === 'function') encoding(); else if (typeof callback === 'function') callback(); return true; };
  process.stdout.write = capture; process.stderr.write = capture;
  try {
    for (const surface of runtime.surfaces) {
      const pair = verifierPair(); secrets.add(pair.codeVerifier);
      const start = await oauthRequest(surface.baseUrl, '/auth/github/login', { codeChallenge: pair.codeChallenge });
      assert.equal(start.status, 200); secrets.add(start.body.state);
      const code = runtime.issueCode({ failure: true }); secrets.add(code);
      // When: the real provider wire returns a secret-bearing exchange failure.
      const response = await oauthRequest(surface.baseUrl, '/auth/github/callback', { state: start.body.state, codeVerifier: pair.codeVerifier, code });
      captures.push(JSON.stringify({ response, events: surface.store.auditLogs.filter((row) => row.action.startsWith('auth.github-oauth')), keys: [...surface.store.authRateLimits.keys()] }));
      // Then: sanitized502, safe event enum, and no raw runtime value in captured sinks.
      assert.equal(response.status, 502); assert.equal(response.body.message, 'github_oauth_exchange_failed');
      assert.equal(surface.store.auditLogs.at(-1).metadata.outcome, 'exchange_failure');
    }
    const email = `${crypto.randomBytes(16).toString('hex')}@example.test`; secrets.add(email);
    const credential = crypto.randomBytes(32).toString('hex'); secrets.add(credential);
    for (const surface of runtime.surfaces) {
      const pair = verifierPair(); secrets.add(pair.codeVerifier);
      const start = await oauthRequest(surface.baseUrl, '/auth/github/login', { codeChallenge: pair.codeChallenge }); secrets.add(start.body.state);
      const code = runtime.issueCode({ email }); secrets.add(code);
      const unknown = await oauthRequest(surface.baseUrl, '/auth/github/callback', { state: start.body.state, codeVerifier: pair.codeVerifier, code });
      assert.equal(unknown.status, 403);
      const invalid = await oauthRequest(surface.baseUrl, '/auth/github/callback', { state: start.body.state, codeVerifier: pair.codeVerifier, error: 'access_denied', error_description: credential });
      assert.equal(invalid.status, 400);
      captures.push(JSON.stringify({ unknown, invalid, events: surface.store.auditLogs.filter((row) => row.action.startsWith('auth.github-oauth')), keys: [...surface.store.authRateLimits.keys()] }));
    }
    secrets.add('127.0.0.1');
    assert.equal([...secrets].some((secret) => captures.some((capture) => capture.includes(secret))), false);
  } finally { process.stdout.write = originalOut; process.stderr.write = originalErr; await runtime.close(); }
});

test('OAuth limits use the injected stable key rather than a different ambient key', async () => {
  // Given: different configured JWT and injected JWT; preferred key deliberately absent.
  const previous = { preferred: process.env.RAIBITSERVER_AUTH_RATE_LIMIT_KEY_SECRET, jwt: process.env.RAIBITSERVER_AUTH_JWT_SECRET };
  delete process.env.RAIBITSERVER_AUTH_RATE_LIMIT_KEY_SECRET;
  process.env.RAIBITSERVER_AUTH_JWT_SECRET = 'ambient-key-'.repeat(4);
  const injected = 'injected-key-'.repeat(4); const source = 'fixture-source';
  const store = new ControlPlaneStore();
  try {
    // When: shared OAuth starts using its actual injected auth context.
    await startGitHubOAuth(store, { codeChallenge: verifierPair().codeChallenge }, { source, jwtSecret: injected, provider: { clientId: 'fixture', clientSecret: 'fixture-secret', redirectUri: 'https://fixture.test/callback' } });
    // Then: independently compute expected keyed request dimension; never unkeyed or ambient.
    const expected = crypto.createHmac('sha256', injected).update(`source:github-oauth-start\0${source}`).digest('base64url');
    assert.equal(store.authRateLimits.has(`auth:source:${expected}`), true);
    assert.equal([...store.authRateLimits.keys()].some((key) => key.includes(source) || key.includes(injected)), false);
    for (const retry of [Infinity, NaN, -10, 100000]) {
      const error = new Error('rate_limit_exceeded'); error.retryAfterSeconds = retry;
      const seconds = publicOAuthError(error).retryAfterSeconds;
      assert.equal(Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600, true);
    }
  } finally {
    if (previous.preferred === undefined) delete process.env.RAIBITSERVER_AUTH_RATE_LIMIT_KEY_SECRET; else process.env.RAIBITSERVER_AUTH_RATE_LIMIT_KEY_SECRET = previous.preferred;
    if (previous.jwt === undefined) delete process.env.RAIBITSERVER_AUTH_JWT_SECRET; else process.env.RAIBITSERVER_AUTH_JWT_SECRET = previous.jwt;
  }
});
