import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { compileProject } from '../../packages/core/src/manifest-compiler.ts';

const image = `registry.example.test/web@sha256:${'a'.repeat(64)}`;

function projectInput(overrides = {}) {
  return {
    organization: { id: 'organization-1', slug: 'club' },
    project: { id: 'project-1', slug: 'festival' },
    baseDomain: 'example.test',
    services: [{ id: 'service-1', name: 'web', slug: 'web', type: 'web', sourceType: 'image', image, port: 3000, environment: { API_TOKEN: 'fixture-secret' }, attachedResources: ['postgres'] }],
    resources: [{ id: 'resource-1', name: 'postgres', slug: 'postgres', engine: 'postgresql', provider: 'hybrid-managed', plan: 'shared-small' }],
    ...overrides,
  };
}

const devIdentity = {
  environment: { id: 'env-dev-001', projectId: 'project-1', kind: 'dev' },
  services: [{ serviceId: 'service-1', logicalSlug: 'web', physicalSlug: 'dev-85b178c4c8-web' }],
  resources: [{ resourceId: 'resource-1', logicalSlug: 'postgres', physicalName: 'dev-fe93d1933e-postgres' }],
};

test('happy: legacy production compilation preserves its exact runtime identity', () => {
  // Given: the production input fixed by the Task 8 preparation baseline.
  const input = projectInput();

  // When: the legacy public compiler is called without an environment projection.
  const plan = compileProject(input);
  const explicit = compileProject(input, {}, { runtimeEnvironment: {
    environment: { id: 'env-prod-001', projectId: 'project-1', kind: 'prod' },
    services: [{ serviceId: 'service-1', logicalSlug: 'web', physicalSlug: 'web' }],
    resources: [{ resourceId: 'resource-1', logicalSlug: 'postgres', physicalName: 'postgres' }],
  } });

  // Then: existing production namespace, route, Secret, and TLS names are unchanged.
  assert.equal(plan.metadata.namespace, 'organization-1--festival');
  assert.deepEqual(plan.manifests.filter(({ kind }) => kind === 'Ingress').map((item) => item.spec.rules[0].host), ['apps--club--festival.example.test']);
  assert.deepEqual(plan.manifests.filter(({ kind }) => kind === 'Secret').map(({ metadata }) => metadata.name), ['web-env']);
  assert.deepEqual(plan.manifests.filter(({ kind }) => kind === 'Ingress').flatMap((item) => item.spec.tls.map(({ secretName }) => secretName)), ['web-tls']);
  assert.deepEqual(plan.manifests.filter(({ kind }) => kind === 'PersistentVolumeClaim'), []);
  assert.deepEqual(explicit, plan);
});

test('happy: authoritative dev identity isolates route namespace and physical names', () => {
  // Given: one DB-derived dev environment with bound logical and physical identities.
  const input = projectInput();

  // When: the projection is supplied through trusted compiler options.
  const plan = compileProject(input, {}, { runtimeEnvironment: devIdentity });

  // Then: public identity stays logical while Kubernetes identity is dev-specific.
  assert.equal(plan.metadata.namespace, 'rb-dev-84496d3a91688c7528eb');
  assert.deepEqual(plan.manifests.filter(({ kind }) => kind === 'Ingress').map((item) => item.spec.rules[0].host), ['dev--club--festival.example.test']);
  assert.deepEqual(plan.manifests.filter(({ kind }) => kind === 'Secret').map(({ metadata }) => metadata.name), ['dev-85b178c4c8-web-env']);
  assert.deepEqual(plan.manifests.filter(({ kind }) => kind === 'Ingress').flatMap((item) => item.spec.tls.map(({ secretName }) => secretName)), ['dev-85b178c4c8-web-tls']);
  assert.deepEqual(plan.resourcePlans.map(({ name, namespace }) => ({ name, namespace })), [{ name: 'dev-fe93d1933e-postgres', namespace: 'rb-dev-84496d3a91688c7528eb' }]);
  assert.equal(plan.domainPlan.services[0].internalHostname, 'dev-85b178c4c8-web.rb-dev-84496d3a91688c7528eb.svc.cluster.local');
});

test('happy: long dev routes and object identities are bounded and collision-resistant', () => {
  // Given: two environments with the same oversized logical service route.
  const logicalSlug = `api-${'c'.repeat(70)}`;
  const input = projectInput({ services: [{ id: 'service-1', name: logicalSlug, slug: logicalSlug, type: 'web', sourceType: 'image', image, port: 8080, environment: { API_TOKEN: 'fixture-secret' } }], resources: [] });
  const identity = (id, physicalSlug) => ({ environment: { id, projectId: 'project-1', kind: 'dev' }, services: [{ serviceId: 'service-1', logicalSlug, physicalSlug }], resources: [] });

  // When: each authoritative environment compiles the same logical service.
  const first = compileProject(input, {}, { runtimeEnvironment: identity('env-dev-001', `dev-9865a194e1-${logicalSlug.slice(0, 48)}`) });
  const second = compileProject(input, {}, { runtimeEnvironment: identity('env-dev-002', `dev-b66536bd7f-${logicalSlug.slice(0, 48)}`) });

  // Then: every label is bounded and the environments cannot collide.
  for (const plan of [first, second]) {
    assert.ok(plan.metadata.namespace.length <= 63);
    assert.ok(plan.manifests.every(({ metadata }) => metadata.name.length <= 63));
    assert.ok(plan.manifests.filter(({ kind }) => kind === 'Ingress').every((item) => item.spec.rules[0].host.split('.')[0].length <= 63));
  }
  assert.notEqual(first.metadata.namespace, second.metadata.namespace);
  assert.notEqual(first.manifests.find(({ kind }) => kind === 'Deployment').metadata.name, second.manifests.find(({ kind }) => kind === 'Deployment').metadata.name);
});

test('failure: forged or incomplete runtime projections are rejected before compilation', () => {
  // Given: payload environment labels plus invalid trusted projections.
  const input = { ...projectInput(), environment: { id: 'payload-dev', projectId: 'attacker', kind: 'dev', namespace: 'attacker' } };
  const invalid = [
    { ...devIdentity, environment: { ...devIdentity.environment, projectId: 'another-project' } },
    { ...devIdentity, services: [] },
    { ...devIdentity, resources: [{ ...devIdentity.resources[0], resourceId: 'resource-other' }] },
  ];

  // When/Then: only the trusted projection is considered and every invalid binding fails closed.
  assert.equal(compileProject(input).metadata.namespace, 'organization-1--festival');
  for (const runtimeEnvironment of invalid) {
    assert.throws(() => compileProject(input, {}, { runtimeEnvironment }), /RUNTIME_ENVIRONMENT_(?:PROJECT_MISMATCH|SERVICE_BINDING_REQUIRED|RESOURCE_BINDING_REQUIRED)/);
  }
});

test('failure: runtime SQL guards bind dev claims to protocol 2 without changing Task 2', () => {
  // Given: the immutable Task 2 migration and its expected follow-up path.
  const task2 = readFileSync(new URL('../../prisma/migrations/202609130001_operational_persistence/migration.sql', import.meta.url), 'utf8');

  // When: the Task 8 runtime protocol migration is inspected.
  const runtime = readFileSync(new URL('../../prisma/migrations/202609130002_runtime_environment_protocol/migration.sql', import.meta.url), 'utf8');

  // Then: authoritative deployment/preview/job guards exist and the Task 2 digest-bearing source is untouched.
  assert.match(runtime, /Deployment_runtime_environment_guard/);
  assert.match(runtime, /PreviewLineage_runtime_environment_guard/);
  assert.match(runtime, /WorkflowJob_runtime_environment_guard/);
  assert.doesNotMatch(runtime, /ALTER TABLE "ResourceBackup" ADD COLUMN "environmentId"/);
  assert.match(runtime, /current_setting\('raibitserver\.operational_protocol', true\)/);
  assert.match(runtime, /EnvironmentService/);
  assert.match(task2, /ResourceBackup_environment_fkey/);
  assert.match(task2, /CREATE FUNCTION raibit_operational_protocol_guard/);
});
