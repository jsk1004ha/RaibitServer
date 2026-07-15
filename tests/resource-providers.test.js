import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPostgresProviderPlan, buildResourceProviderPlan, providerConsoleSurface, provisionProjectResources, providerConnectionEnvForResource, provisionPostgresProvider, ControlPlaneStore, browseDbConsole, runDbConsoleQuery } from '../packages/core/src/index.ts';

test('PostgreSQL direct provider plan creates database/user/grant/test/backup contracts without leaking password', () => {
  const plan = buildPostgresProviderPlan({ name: 'Festival PG', databaseName: 'festival', username: 'festival_app', projectSlug: 'festival-2026' }, { password: 'super-secret-db-password', providerAdminUrl: 'postgresql://admin:adminpass@localhost/postgres' });
  assert.equal(plan.databaseName, 'festival');
  assert.equal(plan.username, 'festival_app');
  assert.match(plan.sqlStatements.join('\n'), /CREATE USER/);
  assert.match(plan.sqlStatements.join('\n'), /CREATE DATABASE/);
  assert.match(plan.sqlStatements.join('\n'), /GRANT ALL PRIVILEGES/);
  assert.match(plan.sqlStatements.join('\n'), /CONNECTION LIMIT 20/);
  assert.match(plan.sqlStatements.join('\n'), /statement_timeout = '30000ms'/);
  assert.match(plan.sqlStatements.join('\n'), /idle_in_transaction_session_timeout = '30000ms'/);
  assert.match(plan.sqlStatements.join('\n'), /lock_timeout = '5000ms'/);
  assert.match(plan.commands.backup, /pg_dump/);
  assert.match(plan.commands.restore, /pg_restore/);
  assert.equal(plan.sharedProvider.model, 'shared-postgresql-cluster');
  assert.match(plan.sharedProvider.connectionPath, /PgBouncer/);
  assert.deepEqual(plan.tenantLimits, { connectionLimit: 20, statementTimeoutMs: 30000, idleInTransactionSessionTimeoutMs: 30000, lockTimeoutMs: 5000 });
  assert.equal(plan.riskControls.some((control) => /max_connections|PgBouncer/.test(control)), true);
  assert.equal(JSON.stringify(plan).includes('super-secret-db-password'), false);
  assert.equal(plan.secret.key, 'DATABASE_URL');
  assert.equal(plan.secret.providerOwned, true);
  assert.equal(typeof plan.secret.valueMasked, 'string');
  assert.equal(plan.databaseUrl, undefined);
});

test('PostgreSQL shared provider clamps beta tenant limits into safe local contracts', () => {
  const plan = buildPostgresProviderPlan({ name: 'Beta PG', connectionLimit: 500, statementTimeoutMs: 1, idleInTransactionSessionTimeoutMs: 999999, lockTimeoutMs: 10 }, { password: 'limit-secret' });
  assert.deepEqual(plan.tenantLimits, { connectionLimit: 100, statementTimeoutMs: 1000, idleInTransactionSessionTimeoutMs: 300000, lockTimeoutMs: 500 });
  assert.match(plan.sqlStatements.join('\n'), /CONNECTION LIMIT 100/);
  assert.match(plan.sqlStatements.join('\n'), /statement_timeout = '1000ms'/);
  assert.match(plan.sqlStatements.join('\n'), /idle_in_transaction_session_timeout = '300000ms'/);
  assert.match(plan.sqlStatements.join('\n'), /lock_timeout = '500ms'/);
  assert.equal(JSON.stringify(plan).includes('limit-secret'), false);
});

test('shared Redis and Valkey provider plans use ACL prefixes and never flush the shared DB', () => {
  for (const engine of ['redis', 'valkey']) {
    const plan = buildResourceProviderPlan({ name: `${engine}-cache`, engine, projectSlug: 'festival' }, { password: 'cache-secret-password' });
    const deleteCommand = plan.commands.delete;
    assert.equal(plan.sharedProvider.tenantPrimitive, 'ACL user + key prefix');
    assert.equal(plan.keyPrefix, `festival:${engine}-cache:`);
    assert.match(plan.commands.create, /ACL SETUSER/);
    assert.match(plan.commands.create, /-@dangerous/);
    assert.match(plan.commands.create, new RegExp(`~${plan.keyPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*`));
    assert.match(deleteCommand, /SCAN/);
    assert.match(deleteCommand, /MATCH/);
    assert.match(deleteCommand, /UNLINK/);
    assert.equal(/FLUSHDB|FLUSHALL/.test(deleteCommand), false);
    assert.equal(JSON.stringify(plan).includes('cache-secret-password'), false);
  }
  const unsafe = buildResourceProviderPlan({ name: 'cache', engine: 'redis', projectSlug: 'festival', keyPrefix: "festival:*'; FLUSHALL; #" });
  assert.equal(unsafe.keyPrefix, 'festival:____FLUSHALL___:');
  assert.equal(unsafe.commands.delete.includes("';"), false);
});

test('shared provider tenant names/key prefixes are unique across projects without projectSlug', () => {
  const victim = providerConnectionEnvForResource({ id: 'res_victim', projectId: 'prj_victim', name: 'cache', engine: 'redis' });
  const attacker = providerConnectionEnvForResource({ id: 'res_attacker', projectId: 'prj_attacker', name: 'cache', engine: 'redis' });
  assert.notEqual(victim.REDIS_USERNAME, attacker.REDIS_USERNAME);
  assert.notEqual(victim.REDIS_KEY_PREFIX, attacker.REDIS_KEY_PREFIX);
});

test('shared SQL and document provider plans create tenant primitives instead of containers', () => {
  const mysql = buildResourceProviderPlan({ name: 'orders', engine: 'mysql', projectSlug: 'festival' });
  assert.equal(mysql.sharedProvider.tenantPrimitive, 'database + user');
  assert.match(mysql.commands.create, /CREATE DATABASE IF NOT EXISTS/);
  assert.match(mysql.commands.create, /GRANT ALL PRIVILEGES/);

  const mongo = buildResourceProviderPlan({ name: 'events', engine: 'mongodb', projectSlug: 'festival' });
  assert.equal(mongo.sharedProvider.tenantPrimitive, 'database + user');
  assert.match(mongo.commands.create, /getSiblingDB/);
  assert.match(mongo.commands.create, /createUser/);
  assert.match(mongo.commands.backup, /mongodump .* --db /);
});

test('PostgreSQL provider dry-run keeps the resource provisioning and does not report a live connection', async () => {
  const store = new ControlPlaneStore();
  const resource = store.createResource({ projectId: 'prj_1', name: 'pg-provider', engine: 'postgresql', provider: 'postgresql-direct', databaseName: 'appdb', username: 'app_user' });
  const originalSecretName = resource.connectionSecretName;
  const provisioned = await store.provisionResourceProvider({ resourceId: resource.id, dryRun: true, actorUserId: 'provider-test', password: 'provider-secret-password' });
  assert.equal(provisioned.resource.status, 'provisioning');
  assert.equal(provisioned.resource.connectionSecretName, originalSecretName);
  assert.equal(provisioned.result.dryRun, true);
  assert.equal(JSON.stringify(store.snapshot()).includes('provider-secret-password'), false);
  const consoleResource = store.resourceForConsole(provisioned.resource);
    assert.equal(consoleResource.providerConnection, undefined);
});

test('PostgreSQL live provisioning is delegated exclusively to the Go provisioner', async () => {
  await assert.rejects(
    () => provisionPostgresProvider({ name: 'blocked-live', engine: 'postgresql' }, { execute: true, dryRun: false }),
      /authoritative Go provisioner/,
  );
});

test('project provisioning can include direct PostgreSQL provider dry-run result', async () => {
  const result = await provisionProjectResources({ project: { slug: 'demo' }, resources: [{ name: 'pg', engine: 'postgresql', provider: 'postgresql-direct', databaseName: 'demo' }] }, { dryRun: true, providerMode: 'direct', password: 'secret-db-password' });
  assert.equal(result.apply.dryRun, true);
  assert.equal(result.providerResults.length, 1);
  assert.equal(result.providerResults[0].engine, 'postgresql');
  assert.equal(JSON.stringify(result).includes('secret-db-password'), false);
});

test('resource console surfaces deterministic adapters for Redis and provider contracts for other engines', async () => {
  const redis = await browseDbConsole({ engine: 'redis', desiredSpec: { keys: ['session:1', 'queue:jobs'] } });
  assert.deepEqual(redis.keys, ['session:1', 'queue:jobs']);
  assert.equal(redis.mode, 'deterministic-adapter');
  const redisQuery = await runDbConsoleQuery({ engine: 'redis' }, 'GET session:1', { role: 'db-admin' });
  assert.match(redisQuery.command, /SCAN/);
  for (const [engine, field] of [['mysql', 'tables'], ['mariadb', 'tables'], ['mongodb', 'collections'], ['object-storage', 'buckets'], ['qdrant', 'collections'], ['nats', 'subjects']]) {
    const surface = providerConsoleSurface({ engine, desiredSpec: { [field]: ['sample'] } });
    assert.equal(surface.engine, engine === 'object-storage' ? 'object-storage' : engine);
    assert.ok(surface[field]);
    assert.equal(surface.mode, 'provider-contract');
  }
});
