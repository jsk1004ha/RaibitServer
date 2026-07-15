import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { browseDbConsole, resourceConsoleView, runDbConsoleQuery } from '../packages/core/src/db-console.ts';
import { ControlPlaneStore } from '../packages/core/src/store.ts';

test('SQLite console creates parent directories and browses tables', async () => {
  const dbPath = path.resolve('.raibitserver-work/sqlite/tests/nested/console.sqlite');
  await fs.rm(path.resolve('.raibitserver-work/sqlite/tests'), { recursive: true, force: true });
  const resource = { engine: 'sqlite', desiredSpec: { sqlitePath: dbPath } };
  await runDbConsoleQuery(resource, 'CREATE TABLE IF NOT EXISTS health (status TEXT)', { confirmed: true, role: 'db-admin' });
  await runDbConsoleQuery(resource, "INSERT INTO health(status) VALUES ('ok')", { confirmed: true, role: 'db-admin' });
  const result = await runDbConsoleQuery(resource, 'SELECT status FROM health', { role: 'db-admin' });
  assert.equal(result.rows[0].status, 'ok');
  const browse = await browseDbConsole(resource);
  assert.deepEqual(browse.tables, ['health']);
  const rows = await resourceConsoleView(resource, 'table', { table: 'health', role: 'db-admin' });
  assert.equal(rows.rows[0].status, 'ok');
  assert.deepEqual(rows.fields, ['status']);
});

test('PostgreSQL console exposes live execution contract without local credentials', async () => {
  const query = await runDbConsoleQuery({ engine: 'postgresql' }, 'SELECT 1', { role: 'db-admin' });
  assert.equal(query.engine, 'postgresql');
  assert.equal(query.mode, 'connection-info');
  assert.match(query.warning, /provider-owned connection URL/);
  const browse = await browseDbConsole({ engine: 'postgresql' });
  assert.equal(browse.engine, 'postgresql');
  assert.deepEqual(browse.tables, []);
  assert.match(browse.warning, /DATABASE_URL/);
});

test('PostgreSQL console rejects request-supplied URLs and non-admin mutations', async () => {
  const ignoredOverride = await runDbConsoleQuery(
    { engine: 'postgresql' },
    'SELECT 1',
    { role: 'db-admin', connectionUrl: 'postgresql://attacker:secret@127.0.0.1:1/evil' },
  );
  assert.equal(ignoredOverride.mode, 'connection-info');
  assert.match(ignoredOverride.warning, /provider-owned connection URL/);

  await assert.rejects(
    () => runDbConsoleQuery(
      { engine: 'postgresql', providerConnection: { databaseUrl: 'postgresql://provider:secret@127.0.0.1:1/app' } },
      'UPDATE users SET admin = true WHERE id = 1',
      { role: 'developer', confirmed: true },
    ),
    /requires db:query:write permission/,
  );
});

test('resource creation strips provider connection and credential fields from tenant input', async () => {
  const store = new ControlPlaneStore();
  const resource = store.createResource({
    projectId: 'prj_1',
    name: 'pg',
    engine: 'postgresql',
    providerConnection: { databaseUrl: 'postgresql://attacker:secret@127.0.0.1:1/evil' },
    connectionUrl: 'postgresql://attacker:secret@127.0.0.1:1/evil',
    connectionUri: 'postgresql://attacker:secret@127.0.0.1:1/evil',
    databaseUri: 'postgresql://attacker:secret@127.0.0.1:1/evil',
    jdbcUrl: 'jdbc:postgresql://127.0.0.1:5432/evil',
    desiredSpec: {
      sqlitePath: '/data/app.db',
      providerConnection: { databaseUrl: 'postgresql://attacker:secret@127.0.0.1:1/evil' },
      DATABASE_URL: 'postgresql://attacker:secret@127.0.0.1:1/evil',
      connectionUri: 'postgresql://attacker:secret@127.0.0.1:1/evil',
      databaseUri: 'postgresql://attacker:secret@127.0.0.1:1/evil',
      jdbcUrl: 'jdbc:postgresql://127.0.0.1:5432/evil',
      PG_URL: 'postgresql://attacker:secret@127.0.0.1:1/evil',
      PG_URI: 'postgresql://attacker:secret@127.0.0.1:1/evil',
      PG_DSN: 'postgresql://attacker:secret@127.0.0.1:1/evil',
      postgresUri: 'postgresql://attacker:secret@127.0.0.1:1/evil',
      mongoConnectionUri: 'mongodb://attacker:secret@127.0.0.1:27017/evil',
      connectionDsn: 'postgresql://attacker:secret@127.0.0.1:1/evil',
      dsn: 'postgresql://attacker:secret@127.0.0.1:1/evil',
      authToken: 'raw-token',
      apiToken: 'raw-token',
      connectionSecretName: 'sec_unsafe',
      nested: {
        databaseUri: 'postgresql://attacker:secret@127.0.0.1:1/evil',
        jdbcUrl: 'jdbc:postgresql://127.0.0.1:5432/evil',
      },
    },
  });
  assert.equal(resource.providerConnection, undefined);
  assert.equal(resource.connectionUrl, undefined);
  assert.equal(resource.connectionUri, undefined);
  assert.equal(resource.databaseUri, undefined);
  assert.equal(resource.jdbcUrl, undefined);
  assert.equal(resource.desiredSpec.providerConnection, undefined);
  assert.equal(resource.desiredSpec.DATABASE_URL, undefined);
  assert.equal(resource.desiredSpec.connectionUri, undefined);
  assert.equal(resource.desiredSpec.databaseUri, undefined);
  assert.equal(resource.desiredSpec.jdbcUrl, undefined);
  assert.equal(resource.desiredSpec.PG_URL, undefined);
  assert.equal(resource.desiredSpec.PG_URI, undefined);
  assert.equal(resource.desiredSpec.PG_DSN, undefined);
  assert.equal(resource.desiredSpec.postgresUri, undefined);
  assert.equal(resource.desiredSpec.mongoConnectionUri, undefined);
  assert.equal(resource.desiredSpec.connectionDsn, undefined);
  assert.equal(resource.desiredSpec.dsn, undefined);
  assert.equal(resource.desiredSpec.authToken, undefined);
  assert.equal(resource.desiredSpec.apiToken, undefined);
  assert.equal(resource.desiredSpec.connectionSecretName, undefined);
  assert.deepEqual(resource.desiredSpec.nested, {});
  assert.equal(resource.desiredSpec.sqlitePath, undefined);
  const query = await runDbConsoleQuery(resource, 'SELECT 1', { role: 'db-admin' });
  assert.equal(query.mode, 'connection-info');
});

test('developer can browse schema but cannot read DB row data by default', async () => {
  const schema = await browseDbConsole({ engine: 'postgresql' }, { role: 'developer' });
  assert.equal(schema.engine, 'postgresql');
  await assert.rejects(
    () => runDbConsoleQuery({ engine: 'postgresql' }, 'SELECT 1', { role: 'developer' }),
    /requires db:data:read permission/,
  );
});

test('provider-owned connection secrets cannot be injected into control-plane console state', async () => {
  const store = new ControlPlaneStore();
  const resource = store.createResource({ projectId: 'prj_1', name: 'pg-secret', engine: 'postgresql' });
  assert.throws(
    () => store.attachProviderConnectionSecret({
      resourceId: resource.id,
      databaseUrl: 'postgresql://provider:secret@127.0.0.1:1/app',
    }),
    /credentials are written only by the Go provisioner/,
  );
  const snapshotResource = store.snapshot().resources.find((row) => row.id === resource.id);
  assert.equal(snapshotResource.providerConnection, undefined);
  assert.equal(snapshotResource.connectionSecretName, undefined);
  const consoleResource = store.resourceForConsole(snapshotResource);
  assert.equal(consoleResource.providerConnection, undefined);
  assert.equal(store.snapshot().secrets.some((secret) => /provider:secret/.test(JSON.stringify(secret))), false);
});

test('SQLite console ignores request-supplied database paths', async () => {
  const overridePath = path.resolve('.raibitserver-work/tests/override/attacker.sqlite');
  await fs.rm(path.dirname(overridePath), { recursive: true, force: true });
  const result = await runDbConsoleQuery(
    { engine: 'sqlite' },
    'CREATE TABLE IF NOT EXISTS ignored (id INTEGER)',
    { role: 'db-admin', confirmed: true, sqlitePath: overridePath },
  );
  assert.equal(result.dbPath, ':memory:');
  await assert.rejects(() => fs.access(overridePath));
  const browse = await browseDbConsole({ engine: 'sqlite' }, { sqlitePath: overridePath });
  assert.equal(browse.dbPath, ':memory:');
  assert.deepEqual(browse.tables, []);
});

test('SQLite console blocks filesystem-opening statements', async () => {
  const dbPath = path.resolve('.raibitserver-work/sqlite/tests/safety.sqlite');
  const resource = { engine: 'sqlite', desiredSpec: { sqlitePath: dbPath } };
  for (const query of [
    "ATTACH DATABASE '/tmp/other.sqlite' AS other",
    'DETACH DATABASE other',
    "VACUUM INTO '/tmp/copy.sqlite'",
    "SELECT load_extension('/tmp/ext')",
    "SELECT load_extension/**/('/tmp/ext')",
    'PRAGMA writable_schema=ON',
    'PRAGMA/**/writable_schema=ON',
    'PRAGMA journal_mode=WAL',
    'PRAGMA/*x*/journal_mode=WAL',
    'PRAGMA main.writable_schema=ON',
  ]) {
    await assert.rejects(
      () => runDbConsoleQuery(resource, query, { role: 'db-admin', confirmed: true }),
      /filesystem safety policy/,
      query,
    );
  }
});
