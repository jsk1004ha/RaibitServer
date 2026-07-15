import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ControlPlaneStore, provisionPostgresProvider } from '../packages/core/src/index.ts';

function fixture() {
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Managed', slug: 'managed' });
  const project = store.createProject({ organizationId: organization.id, name: 'Demo', slug: 'demo' });
  const service = store.createService({ projectId: project.id, name: 'web', type: 'web' });
  const resource = store.createResource({ projectId: project.id, name: 'database', engine: 'postgresql' });
  return { store, project, service, resource };
}

test('control-plane provider endpoint is plan-only and never makes a dry-run resource READY', async () => {
  const { store, resource } = fixture();
  assert.equal(resource.status.toUpperCase(), 'PROVISIONING');
  assert.equal(resource.connectionSecretName ?? null, null);
  assert.equal(store.snapshot().secrets.some((secret) => secret.scopeType === 'resource-provider-connection'), false);

  const planned = await store.provisionResourceProvider({ resourceId: resource.id, dryRun: true, password: 'must-never-persist' });
  assert.equal(planned.resource.status.toUpperCase(), 'PROVISIONING');
  assert.equal(planned.resource.connectionSecretName ?? null, null);
  assert.equal(JSON.stringify(planned).includes('must-never-persist'), false);
  assert.equal(JSON.stringify(store.snapshot()).includes('must-never-persist'), false);

  await assert.rejects(
    () => store.provisionResourceProvider({ resourceId: resource.id, execute: true, dryRun: false }),
    /Go provisioner|authoritative|live provider/i,
  );
});

test('provider planning cannot requeue a READY resource and rotate live credentials behind attached workloads', async () => {
  const { store, resource } = fixture();
  store.resources.set(resource.id, {
    ...store.resources.get(resource.id),
    status: 'READY',
    connectionSecretName: 'resource-stable-connection',
    desiredState: {
      providerConnection: {
        secretName: 'resource-stable-connection',
        environmentKeys: ['DATABASE_URL'],
        endpoint: 'resource-stable.demo.svc.cluster.local:5432',
      },
    },
  });

  await assert.rejects(
    () => store.provisionResourceProvider({ resourceId: resource.id, dryRun: true }),
    (error) => error?.statusCode === 409 && /READY|rotation|reprovision/i.test(error.message),
  );
  const duplicateCreate = store.createResource({ projectId: resource.projectId, name: resource.name, engine: resource.engine });
  assert.equal(duplicateCreate.status, 'READY');
  assert.equal(duplicateCreate.connectionSecretName, 'resource-stable-connection');
  assert.throws(
    () => store.updateResource(resource.id, { plan: 'larger' }),
    (error) => error?.statusCode === 409 && /READY|replace|recreate/i.test(error.message),
  );
  const unchanged = store.getResource(resource.id);
  assert.equal(unchanged.status, 'READY');
  assert.equal(unchanged.connectionSecretName, 'resource-stable-connection');
});

test('resource attachment is READY-only and stores Kubernetes secretKeyRef metadata without plaintext', () => {
  const { store, service, resource } = fixture();
  assert.throws(() => store.attachResource({ resourceId: resource.id, serviceId: service.id }), /READY/i);

  store.resources.set(resource.id, {
    ...store.resources.get(resource.id),
    status: 'READY',
    connectionSecretName: 'database-connection',
    desiredState: {
      providerConnection: {
        secretName: 'database-connection',
        environmentKeys: ['DATABASE_URL', 'PGHOST'],
        endpoint: 'database.managed-demo.svc.cluster.local:5432',
      },
    },
  });
  const attached = store.attachResource({ resourceId: resource.id, serviceId: service.id, envPrefix: 'APP' });
  assert.deepEqual(attached.injectedEnv.APP_DATABASE_URL, {
    valueFrom: { secretKeyRef: { name: 'database-connection', key: 'DATABASE_URL' } },
  });
  assert.equal(JSON.stringify(attached).includes('postgresql://'), false);
  const updatedService = store.getService(service.id);
  assert.equal(updatedService.desiredSpec.secretEnv.some((entry) => entry.name === 'APP_DATABASE_URL' && entry.valueFrom.secretKeyRef.name === 'database-connection'), true);
    const env = [...store.environmentVariables.values()].find((entry) => entry.key === 'APP_DATABASE_URL');
  assert.match(env.secretRef, /^k8s:/);
    assert.equal(env.value, null);
});

test('Prisma provider endpoint cannot execute legacy TypeScript live provisioning', () => {
  const source = fs.readFileSync(new URL('../packages/core/src/persistence.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /provisionResourceProvider\s+as\s+provisionAnyResourceProvider/);
    assert.match(source, /(?:authoritative[^'"`]*Go provisioner|Go provisioner[^'"`]*authoritative)/i);
  assert.match(source, /status[^\n]*PROVISIONING|PROVISIONING[^\n]*status/i);
  const prismaRepositoryStart = source.indexOf('export class PrismaControlPlaneRepository');
  const desiredWriterStart = source.indexOf('async writeDesiredProject', prismaRepositoryStart);
  const desiredWriter = source.slice(desiredWriterStart, source.indexOf('async snapshot', desiredWriterStart));
  assert.match(desiredWriter, /status[\s\S]{0,160}READY[\s\S]{0,160}resources\.push\(existing\)/i);
});

test('exported TypeScript provider executor rejects live mode even when the legacy allowlist is set', async () => {
  const previous = process.env.RAIBITSERVER_ENABLE_LIVE_PROVIDER_PROVISIONING;
  process.env.RAIBITSERVER_ENABLE_LIVE_PROVIDER_PROVISIONING = 'true';
  try {
    await assert.rejects(
      () => provisionPostgresProvider({ name: 'blocked', engine: 'postgresql' }, { execute: true, dryRun: false }),
      /Go provisioner|authoritative/i,
    );
  } finally {
    if (previous === undefined) delete process.env.RAIBITSERVER_ENABLE_LIVE_PROVIDER_PROVISIONING;
    else process.env.RAIBITSERVER_ENABLE_LIVE_PROVIDER_PROVISIONING = previous;
  }
});
