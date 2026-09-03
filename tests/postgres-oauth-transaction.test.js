import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';

const require = createRequire(import.meta.url);
const input = { state: 'postgres-state-'.repeat(4), source: '198.51.100.82', sourceSecret: 'postgres-source-key-'.repeat(3), codeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', redirectUri: 'https://console.example.test/callback', now: 1_000_000, ttlMs: 60_000 };

async function fixture(t) {
  assert.ok(process.env.RAIBITSERVER_TEST_DATABASE_URL, 'real disposable PostgreSQL URL required; this suite must not skip');
  const { PrismaClient } = await import('@prisma/client');
  const admin = new PrismaClient({ datasourceUrl: process.env.RAIBITSERVER_TEST_DATABASE_URL });
  const schema = `oauth_t8_${randomUUID().replaceAll('-', '')}`;
  const repositories = [];
  const queryLog = [];
  t.after(async () => {
    await Promise.all(repositories.map((repository) => repository.disconnect()));
    try { await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.$disconnect(); }
    t.diagnostic(JSON.stringify({ cleanup: 'PASS', schema }));
  });
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.RAIBITSERVER_TEST_DATABASE_URL);
  url.searchParams.set('schema', schema);
  url.searchParams.set('connection_limit', '1');
  const migrate = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], { env: { ...process.env, DATABASE_URL: url.href }, encoding: 'utf8', timeout: 120000 });
  assert.equal(migrate.status, 0, 'disposable schema migration must succeed');
  for (let index = 0; index < 20; index++) {
    const repository = await PrismaControlPlaneRepository.connect({ env: { ...process.env, RAIBITSERVER_DB_POOL_SIZE: '1' }, prismaOptions: { datasourceUrl: url.href, log: [{ emit: 'event', level: 'query' }], transactionOptions: { maxWait: 30000, timeout: 30000 } } });
    repository.prisma.$on('query', (event) => queryLog.push({ query: event.query, params: event.params }));
    repositories.push(repository);
  }
  t.after(() => {
    const bytes = JSON.stringify(queryLog);
    assert.ok(queryLog.length > 0);
    for (const secret of [input.state, input.source, input.sourceSecret, input.codeVerifier, 'fixture-pg-code', 'fixture-pg-token', 'fixture-pg-user-agent', 'fixture-pg-cookie']) assert.equal(bytes.includes(secret), false);
    t.diagnostic(JSON.stringify({ queryEvents: queryLog.length, rawLogSecretMatches: 0 }));
  });
  return repositories;
}

test('consume matching OAuth transaction once in durable PostgreSQL', async (t) => {
  const repositories = await fixture(t);
  assert.equal(typeof repositories[0].createOAuthTransaction, 'function');
  const created = await repositories[0].createOAuthTransaction(input);
  const stored = await repositories[0].prisma.oAuthTransaction.findUniqueOrThrow({ where: { id: created.id } });
  assert.equal(stored.createdAt.getTime(), input.now);
  assert.equal(stored.sourceHash, created.sourceHash);
  assert.equal(stored.codeChallenge, input.codeChallenge);
  assert.equal(stored.redirectUri, input.redirectUri);
  await repositories[0].disconnect();
  const consumed = await repositories[1].consumeOAuthTransaction(input);
  assert.equal(consumed.id, created.id);
  assert.equal(consumed.consumedAt, input.now);
});

test('OAuth transaction adversarial matrix in PostgreSQL', async (t) => {
  const repositories = await fixture(t);
  const repository = repositories[0];
  assert.equal(typeof repository.createOAuthTransaction, 'function');
  await repository.createOAuthTransaction(input);
  await assert.rejects(repository.createOAuthTransaction(input), (error) => error.code === 'oauth_transaction_exists' && error.statusCode === 409);
  const outcomes = await Promise.all(repositories.map(async (consumer) => {
    try { return { winner: await consumer.consumeOAuthTransaction(input) }; }
    catch (error) { return { error }; }
  }));
  assert.equal(outcomes.filter((outcome) => outcome.winner).length, 1);
  const failures = outcomes.filter((outcome) => outcome.error);
  assert.equal(failures.length, 19);
  for (const { error } of failures) { assert.equal(error.code, 'oauth_transaction_replayed'); assert.equal(error.statusCode, 409); }
  assert.equal(await repository.prisma.oAuthTransaction.count({ where: { consumedAt: { not: null } } }), 1);
  t.diagnostic(JSON.stringify({ consumers: 20, winners: 1, replayConflicts: 19, consumedRows: 1 }));
  for (const [index, drift] of [{ source: '198.51.100.83' }, { redirectUri: 'https://other.example.test/' }, { codeVerifier: 'x'.repeat(43) }, { now: input.now + input.ttlMs }].entries()) {
    const candidate = { ...input, state: `${input.state}${index}` };
    await repository.createOAuthTransaction(candidate);
    await assert.rejects(repository.consumeOAuthTransaction({ ...candidate, ...drift }), (error) => error.statusCode === 400 && error.code === (drift.now ? 'oauth_transaction_expired' : 'oauth_transaction_mismatch'));
  }
  const ignored = { code: 'fixture-pg-code', token: 'fixture-pg-token', userAgent: 'fixture-pg-user-agent', cookie: 'fixture-pg-cookie' };
  await repository.createOAuthTransaction({ ...input, state: `${input.state}active`, now: input.now + 60_000, ...ignored });
  const bytes = JSON.stringify(await repository.prisma.oAuthTransaction.findMany());
  for (const secret of [input.state, input.source, input.sourceSecret, input.codeVerifier, ...Object.values(ignored)]) assert.equal(bytes.includes(secret), false);
  assert.equal(await repository.deleteExpiredOAuthTransactions({ now: input.now + 60_000, limit: 2 }), 2);
  assert.equal(await repository.deleteExpiredOAuthTransactions({ now: input.now + 60_000, limit: 256 }), 3);
  assert.equal(await repository.prisma.oAuthTransaction.count(), 1);
  t.diagnostic(JSON.stringify({ rawSecretMatches: 0, expiredDeleted: 5, activeRetained: 1 }));
});
