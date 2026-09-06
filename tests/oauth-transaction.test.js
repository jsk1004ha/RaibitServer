import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { InMemoryControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { enforceAuthAbuseLimits } from '../packages/core/src/security.ts';

export const oauthFixture = Object.freeze({
  state: 'opaque-state-'.repeat(4), source: '192.0.2.123',
  sourceSecret: 'fixture-source-hash-key-'.repeat(3),
  codeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  redirectUri: 'https://console.example.test/auth/callback', now: 1_000_000, ttlMs: 60_000,
});

export const oauthError = (code, statusCode = 400) => (error) => {
  assert.equal(error.code, code);
  assert.equal(error.statusCode, statusCode);
  assert.equal(error.message, code);
  return true;
};

test('consume matching OAuth transaction once', async () => {
  // Given an empty real in-memory repository and an RFC 7636 challenge.
  const repository = new InMemoryControlPlaneRepository();
  assert.equal(typeof repository.createOAuthTransaction, 'function');
  const created = await repository.createOAuthTransaction(oauthFixture);
  // When the matching transaction is consumed.
  const consumed = await repository.consumeOAuthTransaction(oauthFixture);
  // Then its immutable identity and exact timestamp are preserved.
  assert.equal(consumed.id, created.id);
  assert.equal(consumed.consumedAt, oauthFixture.now);
  assert.equal(created.consumedAt, null);
  assert.equal(created.stateHash, createHash('sha256').update(oauthFixture.state).digest('hex'));
  await assert.rejects(repository.consumeOAuthTransaction(oauthFixture), oauthError('oauth_transaction_replayed', 409));
});

test('OAuth transaction adversarial matrix', async (t) => {
  const drifts = [
    ['source', { source: '192.0.2.124' }, 'oauth_transaction_mismatch'],
    ['source key', { sourceSecret: 'different-key-'.repeat(4) }, 'oauth_transaction_mismatch'],
    ['redirect', { redirectUri: 'https://other.example.test/callback' }, 'oauth_transaction_mismatch'],
    ['verifier', { codeVerifier: 'x'.repeat(43) }, 'oauth_transaction_mismatch'],
    ['expiry boundary', { now: oauthFixture.now + oauthFixture.ttlMs }, 'oauth_transaction_expired'],
    ['missing state', { state: 'missing-state-'.repeat(4) }, 'oauth_transaction_missing'],
  ];
  for (const [name, change, code] of drifts) await t.test(name, async () => {
    // Given one pending transaction, when one binding drifts, then no consumption occurs.
    const repository = new InMemoryControlPlaneRepository();
    assert.equal(typeof repository.createOAuthTransaction, 'function');
    await repository.createOAuthTransaction(oauthFixture);
    await assert.rejects(repository.consumeOAuthTransaction({ ...oauthFixture, ...change }), oauthError(code));
    const [stored] = repository.store.oauthTransactions.values();
    assert.equal(stored.consumedAt, null);
    if (code === 'oauth_transaction_mismatch') assert.equal(stored.failureCode, code);
  });
  await t.test('duplicate state never overwrites', async () => {
    const repository = new InMemoryControlPlaneRepository();
    await repository.createOAuthTransaction(oauthFixture);
    await assert.rejects(repository.createOAuthTransaction({ ...oauthFixture, source: 'other' }), oauthError('oauth_transaction_exists', 409));
    assert.equal((await repository.consumeOAuthTransaction(oauthFixture)).consumedAt, oauthFixture.now);
  });
  await t.test('20-way race and returned record mutation', async () => {
    const repository = new InMemoryControlPlaneRepository();
    await repository.createOAuthTransaction(oauthFixture);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => repository.consumeOAuthTransaction(oauthFixture)));
    const winners = results.filter((result) => result.status === 'fulfilled');
    assert.equal(winners.length, 1);
    for (const loser of results.filter((result) => result.status === 'rejected')) oauthError('oauth_transaction_replayed', 409)(loser.reason);
    winners[0].value.consumedAt = null;
    await assert.rejects(repository.consumeOAuthTransaction(oauthFixture), oauthError('oauth_transaction_replayed', 409));
  });
  await t.test('bounded cleanup preserves active rows', async () => {
    const repository = new InMemoryControlPlaneRepository();
    for (let index = 0; index < 3; index++) await repository.createOAuthTransaction({ ...oauthFixture, state: `${oauthFixture.state}${index}` });
    await repository.createOAuthTransaction({ ...oauthFixture, state: `${oauthFixture.state}active`, now: oauthFixture.now + 60_000 });
    assert.equal(await repository.deleteExpiredOAuthTransactions({ now: oauthFixture.now + 60_000, limit: 2 }), 2);
    assert.equal(await repository.deleteExpiredOAuthTransactions({ now: oauthFixture.now + 60_000, limit: 2 }), 1);
    assert.equal(repository.store.oauthTransactions.size, 1);
  });
  for (const change of [{ state: '' }, { codeChallenge: 'x'.repeat(44) }, { codeChallenge: '!'.repeat(43) }, { sourceSecret: '' }, { ttlMs: 0 }, { ttlMs: 600001 }, { now: NaN }, { redirectUri: 'javascript:alert(1)' }, { redirectUri: 'https://user:password@example.test/' }]) await t.test(`invalid create ${Object.keys(change)[0]} ${String(Object.values(change)[0]).length}`, async () => {
    const repository = new InMemoryControlPlaneRepository();
    await assert.rejects(repository.createOAuthTransaction({ ...oauthFixture, ...change }), oauthError('oauth_transaction_invalid'));
    assert.equal(repository.store.oauthTransactions.size, 0);
  });
  await t.test('raw fixture secrets never enter storage or errors', async () => {
    const repository = new InMemoryControlPlaneRepository();
    const ignored = { code: 'fixture-authorization-code', accessToken: 'fixture-access-token', cookie: 'fixture-cookie', userAgent: 'fixture-user-agent' };
    await repository.createOAuthTransaction({ ...oauthFixture, ...ignored });
    await enforceAuthAbuseLimits(repository, { action: 'oauth-start', source: oauthFixture.source, now: oauthFixture.now, env: {} });
    const bytes = JSON.stringify({ rows: [...repository.store.oauthTransactions.values()], keys: [...repository.store.authRateLimits.keys()], snapshot: await repository.snapshot() });
    for (const secret of [oauthFixture.state, oauthFixture.source, oauthFixture.sourceSecret, oauthFixture.codeVerifier, ...Object.values(ignored)]) assert.equal(bytes.includes(secret), false);
  });
});
