import test from 'node:test';
import assert from 'node:assert/strict';
import { listCatalog } from '../packages/core/src/catalog.ts';
import { connectionEnvForResource, injectResourceEnv } from '../packages/core/src/env-injection.ts';
import { compileResourceProvisioningPlan } from '../packages/core/src/provisioner.ts';
import { maskSecrets } from '../packages/core/src/secrets.ts';

test('catalog includes relational, cache, storage, vector, and queue resources', () => {
  const keys = listCatalog().map((entry) => entry.key);
  for (const key of ['postgresql', 'mysql', 'mariadb', 'mongodb', 'redis', 'object-storage', 'vector-db', 'message-queue']) {
    assert.equal(keys.includes(key), true, key);
  }
});

test('postgres resource generates standard connection variables', () => {
  const env = connectionEnvForResource({ name: 'todo-postgres', engine: 'postgresql', databaseName: 'todo', username: 'todo_app', password: 'pw' }, 'todo');
  assert.match(env.DATABASE_URL, /^postgresql:\/\/todo_app:pw@pgbouncer\.shared-providers\.svc\.cluster\.local:5432\/todo$/);
  assert.equal(env.PGDATABASE, 'todo');
});

test('shared database resources inject bounded connection limits', () => {
  const pg = connectionEnvForResource({ name: 'todo-postgres', engine: 'postgresql', plan: 'shared-small', databaseName: 'todo', username: 'todo_app', password: 'pw' }, 'todo');
  assert.equal(pg.DATABASE_URL, 'postgresql://todo_app:pw@pgbouncer.shared-providers.svc.cluster.local:5432/todo?connection_limit=3');
  assert.equal(pg.PG_CONNECTION_LIMIT, '3');

  const mysql = connectionEnvForResource({ name: 'todo-mysql', engine: 'mysql', plan: 'shared-small', connectionLimit: 2, databaseName: 'todo', username: 'todo_app', password: 'pw' }, 'todo');
  assert.equal(mysql.MYSQL_URL, 'mysql://todo_app:pw@mysql.shared-providers.svc.cluster.local:3306/todo?connection_limit=2');
  assert.equal(mysql.MYSQL_CONNECTION_LIMIT, '2');
});

test('provider connection env is deterministic when provider owns the live secret', () => {
  const first = connectionEnvForResource({ name: 'todo-postgres', engine: 'postgresql', plan: 'shared-small' }, 'todo');
  const second = connectionEnvForResource({ name: 'todo-postgres', engine: 'postgresql', plan: 'shared-small' }, 'todo');
  assert.equal(first.DATABASE_URL, second.DATABASE_URL);
  assert.match(first.DATABASE_URL, /provider-managed-todo-todo-postgres/);
});

test('resource provisioner never emits deterministic provider placeholders as live credentials', () => {
  const plan = compileResourceProvisioningPlan(
    { name: 'db', engine: 'postgresql', plan: 'shared-small' },
    { namespace: 'victim', projectSlug: 'victim', organizationSlug: 'org' },
  );
  const managed = plan.manifests.find((manifest) => manifest.kind === 'ManagedDatabase');
  const secret = plan.manifests.find((manifest) => manifest.kind === 'Secret');
  assert.equal(secret, undefined, 'provider-generated resources must not apply predictable placeholder Secrets');
  assert.equal(managed.spec.credentialsSecretName, undefined);
  assert.equal(managed.spec.generatedCredentialsSecretName, 'db-connection');
  assert.equal(managed.spec.credentialsMode, 'provider-generated');

  const explicit = compileResourceProvisioningPlan(
    { name: 'db', engine: 'postgresql', username: 'app', generatedPassword: 'random-from-provider' },
    { namespace: 'victim', projectSlug: 'victim', organizationSlug: 'org' },
  );
  const explicitSecret = explicit.manifests.find((manifest) => manifest.kind === 'Secret');
  assert.equal(explicitSecret.metadata.annotations?.['raibitserver.io/provider-contract'], undefined);
  assert.equal(explicitSecret.stringData.PGPASSWORD, 'random-from-provider');
});

test('service env injection attaches selected resources only', () => {
  const env = injectResourceEnv(
    { name: 'api', attachedResources: ['redis'], environment: { NODE_ENV: 'production' } },
    [
      { name: 'postgres', engine: 'postgresql' },
      { name: 'redis', engine: 'redis', password: 'secret' },
    ],
    'demo',
  );
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.POSTGRES_URL, undefined);
  assert.match(env.REDIS_URL, /^redis:\/\/demo_redis_app:secret@redis\.shared-providers\.svc\.cluster\.local:6379$/);
  assert.equal(env.REDIS_KEY_PREFIX, 'demo:redis:');
});

test('secret masking hides secret-looking fields', () => {
  const masked = maskSecrets({ DATABASE_URL: 'postgres://user:password@host/db', visible: 'ok' });
  assert.notEqual(masked.DATABASE_URL, 'postgres://user:password@host/db');
  assert.equal(masked.visible, 'ok');
});
