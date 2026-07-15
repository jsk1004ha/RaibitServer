import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane, buildResourceProviderPlan } from '../packages/core/src/index.ts';

const auth = { mode: 'disabled', allowDisabled: true, defaultRole: 'owner' };

test('beta resource lifecycle plans through the API and attaches only Go-provisioned Kubernetes Secret refs', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const org = controlPlane.store.createOrganization({ name: 'DB Beta Org', slug: 'db-beta-org' });
  const project = controlPlane.store.createProject({ organizationId: org.id, name: 'DB Beta', slug: 'db-beta' });
  const service = controlPlane.store.createService({ projectId: project.id, name: 'web', type: 'web', attachedResources: [] });
  const server = await serve(controlPlane);
  try {
      const engines = ['postgresql', 'sqlite', 'redis', 'valkey', 'object-storage', 'mysql', 'mariadb', 'mongodb', 'qdrant', 'nats'];
    const resources = [];
    for (const engine of engines) {
      const created = await request(server.port, 'POST', `/projects/${project.id}/resources`, resourceBody(engine));
      assert.equal(created.statusCode, 201, `${engine} create`);
      assert.equal(created.body.engine, engine);
        assert.equal(created.body.connectionSecretName ?? null, null, `${engine} has no control-plane credential secret`);
      resources.push(created.body);
      const provisioned = await request(server.port, 'POST', `/resources/${created.body.id}/provision`, { dryRun: true });
      assert.equal(provisioned.statusCode, 202, `${engine} provision`);
      assert.equal(provisioned.body.resource.status, 'provisioning');
      assert.equal(provisioned.body.result.dryRun, true);
        const blocked = await request(server.port, 'POST', `/resources/${created.body.id}/attach`, { serviceId: service.id });
        assert.equal(blocked.statusCode, 409, `${engine} cannot attach before READY`);
        if (engine !== 'sqlite') {
          const row = controlPlane.store.resources.get(created.body.id);
          const secretName = `${row.slug}-connection`;
          controlPlane.store.resources.set(row.id, {
            ...row,
            status: 'READY',
            connectionSecretName: secretName,
            desiredState: { ...(row.desiredState || {}), providerConnection: { secretName, environmentKeys: providerKeys(engine), endpoint: `${row.slug}.managed-demo.svc.cluster.local` } },
          });
          const attached = await request(server.port, 'POST', `/resources/${created.body.id}/attach`, { serviceId: service.id, envPrefix: engine === 'postgresql' ? 'PGAPP' : '' });
          assert.equal(attached.statusCode, 200, `${engine} attach`);
          assert.ok(Object.values(attached.body.injectedEnv).every((entry) => entry.valueFrom?.secretKeyRef?.name === secretName), `${engine} secretKeyRef injection`);
        }
    }

    const snapshot = controlPlane.store.snapshot();
    assert.equal(snapshot.resources.length, engines.length);
      assert.equal(snapshot.secrets.some((secret) => secret.scopeType === 'resource-provider-connection'), false);
    assert.equal(JSON.stringify(snapshot).includes('local-e2e-postgres-secret'), false);
    assert.ok(snapshot.environmentVariables.some((entry) => entry.key === 'PGAPP_DATABASE_URL'));
    assert.ok(snapshot.environmentVariables.some((entry) => entry.key === 'MYSQL_URL'));
    assert.ok(snapshot.environmentVariables.every((entry) => entry.isSecret ? entry.value === undefined : true));

    const sqlite = resources.find((resource) => resource.engine === 'sqlite');
    assert.equal((await request(server.port, 'POST', `/resources/${sqlite.id}/console/query`, { query: 'CREATE TABLE IF NOT EXISTS health (status TEXT)', confirmed: true })).statusCode, 200);
    assert.equal((await request(server.port, 'POST', `/resources/${sqlite.id}/console/query`, { query: "INSERT INTO health(status) VALUES ('ok')", confirmed: true })).statusCode, 200);
    const sqliteRows = await request(server.port, 'POST', `/resources/${sqlite.id}/console/query`, { query: 'SELECT status FROM health' });
    assert.equal(sqliteRows.body.rows[0].status, 'ok');

    const mysql = resources.find((resource) => resource.engine === 'mysql');
    const mysqlRows = await request(server.port, 'POST', `/resources/${mysql.id}/console/query`, { query: 'SELECT 1' });
    assert.equal(mysqlRows.statusCode, 200);
    assert.equal(mysqlRows.body.rows[0].raibitserver_connection_test, 1);

    const redis = resources.find((resource) => resource.engine === 'redis');
    assert.equal((await request(server.port, 'GET', `/resources/${redis.id}/console/keys`)).body.keys[0], 'health:ready');
    assert.equal((await request(server.port, 'POST', `/resources/${redis.id}/console/command`, { command: 'GET health:ready' })).body.rows[0].value, 'ok');
    assert.equal((await request(server.port, 'POST', `/resources/${redis.id}/console/command`, { command: 'TTL health:ready' })).body.rows[0].ttl, -1);

    const mongodb = resources.find((resource) => resource.engine === 'mongodb');
    assert.deepEqual((await request(server.port, 'GET', `/resources/${mongodb.id}/console/collections`)).body.collections, ['health']);
    assert.equal((await request(server.port, 'POST', `/resources/${mongodb.id}/console/command`, { command: 'db.health.find({})' })).body.rows[0].ok, true);

    const objectStorage = resources.find((resource) => resource.engine === 'object-storage');
    assert.equal((await request(server.port, 'POST', `/resources/${objectStorage.id}/console/browse`, {})).body.buckets[0], 'assets');

    const qdrant = resources.find((resource) => resource.engine === 'qdrant');
    assert.equal((await request(server.port, 'POST', `/resources/${qdrant.id}/console/command`, { command: 'GET /collections' })).body.collections[0], 'vectors');

    const nats = resources.find((resource) => resource.engine === 'nats');
    assert.equal((await request(server.port, 'POST', `/resources/${nats.id}/console/command`, { command: 'subjects' })).body.subjects[0], 'events.>');

    const deleted = await request(server.port, 'DELETE', `/resources/${redis.id}`);
    assert.equal(deleted.statusCode, 200);
    const afterDelete = controlPlane.store.snapshot();
    assert.equal(afterDelete.resources.some((resource) => resource.id === redis.id), false);
    assert.equal(afterDelete.secrets.some((secret) => secret.scopeType === 'resource-provider-connection' && secret.scopeId === redis.id), false);
    assert.ok(afterDelete.auditLogs.some((log) => log.action === 'resource:delete'));
  } finally {
    server.close();
  }
});

test('provider plans cover beta DB/resource backup, restore, and cleanup contracts', () => {
  for (const engine of ['postgresql', 'sqlite', 'redis', 'object-storage', 'mysql', 'mariadb', 'mongodb', 'qdrant', 'nats']) {
    const plan = buildResourceProviderPlan(resourceBody(engine), { password: 'provider-secret-password' });
    assert.equal(plan.connectionSecret.providerOwned, true, `${engine} provider secret`);
    assert.ok(plan.commands.create, `${engine} create command`);
    assert.ok(plan.commands.test, `${engine} test command`);
    assert.ok(plan.commands.backup || ['qdrant', 'nats'].includes(engine), `${engine} backup command`);
    assert.ok(plan.commands.restore || ['qdrant', 'nats'].includes(engine), `${engine} restore command`);
    assert.ok(plan.commands.delete, `${engine} delete command`);
    assert.equal(JSON.stringify(plan).includes('provider-secret-password'), false, `${engine} secret masked`);
  }
});

function resourceBody(engine) {
  const base = { name: `${engine}-resource`, engine, type: ['redis', 'valkey'].includes(engine) ? 'cache' : engine === 'object-storage' ? 'storage' : ['qdrant'].includes(engine) ? 'vector' : engine === 'nats' ? 'queue' : 'database', provider: 'local', desiredSpec: {} };
  if (engine === 'redis' || engine === 'valkey') base.desiredSpec = { keys: ['health:ready'], values: { 'health:ready': 'ok' }, ttl: { 'health:ready': -1 } };
  if (engine === 'object-storage') base.desiredSpec = { bucket: 'assets', buckets: ['assets'], objects: [{ key: 'hello.txt', size: 5 }] };
  if (engine === 'mongodb') base.desiredSpec = { collections: ['health'], documents: { health: [{ ok: true }] } };
  if (engine === 'qdrant') base.desiredSpec = { collection: 'vectors', collections: ['vectors'] };
  if (engine === 'nats') base.desiredSpec = { topic: 'events', subjects: ['events.>'] };
  if (engine === 'mysql' || engine === 'mariadb') base.desiredSpec = { schemas: ['app'], tables: ['health'] };
  return base;
}

function providerKeys(engine) {
  return {
    postgresql: ['DATABASE_URL'], redis: ['REDIS_URL'], valkey: ['VALKEY_URL'],
    'object-storage': ['S3_ENDPOINT'], mysql: ['MYSQL_URL'], mariadb: ['MARIADB_URL'],
    mongodb: ['MONGODB_URI'], qdrant: ['VECTOR_DB_URL'], nats: ['QUEUE_URL'],
  }[engine] || [];
}

function serve(controlPlane) {
  const server = http.createServer(createApiHandler(controlPlane, { auth }));
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => ({ port: server.address().port, close: () => server.close() }));
}

function request(port, method, requestPath, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {};
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
