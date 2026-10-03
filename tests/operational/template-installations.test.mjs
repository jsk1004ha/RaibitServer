import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertTemplateSecretValues, installationProgress, preflightTemplateInstallation, validateTemplateCatalog } from '../../packages/core/src/template-installations.ts';

const catalog = JSON.parse(await readFile(new URL('../../test-fixtures/contracts/starter-catalog-v1.json', import.meta.url), 'utf8'));
const context = { actorUserId: 'user_owner', projectId: 'project_alpha', environmentId: 'env_prod_project_alpha', environmentKind: 'prod', availableServiceSlots: 2, availableResourceSlots: 2, occupiedServiceSlugs: [], occupiedResourceSlugs: [], supportedResourceEngines: ['postgresql'] };
const request = (id, inputs = {}) => ({ requiredProtocolVersion: 2, catalogId: id, catalogVersion: 'v1', catalogDigest: catalog.catalogDigest, sourceDigest: catalog.starters.find(row => row.id === id).source.digest, requestIdempotencyKey: `install-${id}-001`, inputs });
const code = expected => error => error.code === expected;

test('template plans contain references only and bind replay fingerprints to the exact transient secret', () => {
  const token = 'discord-token-only-in-request';
  const input = request('discord-bot', { DISCORD_TOKEN: token });
  const first = preflightTemplateInstallation(catalog, input, context);
  assert.deepEqual(preflightTemplateInstallation(catalog, structuredClone(input), context), first);
  assert.match(first.inputs.DISCORD_TOKEN, /^secret:tmplsec_[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(first).includes(token), false);
  assert.deepEqual(first.services[0].secretRefs, [{ name: 'DISCORD_TOKEN', secretRef: first.inputs.DISCORD_TOKEN }]);
  assert.deepEqual(first.services[0].buildJobPayload.templateResourceIds, []);
  assertTemplateSecretValues(first, input.inputs);
  const changed = preflightTemplateInstallation(catalog, request('discord-bot', { DISCORD_TOKEN: 'different-token' }), context);
  assert.equal(changed.installationId, first.installationId);
  assert.equal(changed.inputs.DISCORD_TOKEN, first.inputs.DISCORD_TOKEN);
  assert.notEqual(changed.requestFingerprint, first.requestFingerprint);
  assert.throws(() => assertTemplateSecretValues(first, { DISCORD_TOKEN: 'different-token' }), code('TEMPLATE_VERSION_CONFLICT'));
  assert.throws(() => assertTemplateSecretValues({ ...first, inputs: { DISCORD_TOKEN: 'secret:foreign' } }, input.inputs), code('TEMPLATE_INPUT_INVALID'));
});

test('preflight enforces bounded inputs, pinned identities, capacity, resource support, and occupied names', () => {
  assert.throws(() => preflightTemplateInstallation(catalog, request('discord-bot'), context), code('TEMPLATE_REQUIRED_INPUT_MISSING'));
  for (const inputs of [{ DISCORD_TOKEN: 'secret', arbitrary: 'x' }, { DISCORD_TOKEN: '\nunsafe' }, { DISCORD_TOKEN: 'x'.repeat(16385) }]) {
    assert.throws(() => preflightTemplateInstallation(catalog, request('discord-bot', inputs), context), code('TEMPLATE_INPUT_INVALID'));
  }
  const input = request('next-postgres');
  assert.throws(() => preflightTemplateInstallation(catalog, { ...input, sourceUrl: 'https://untrusted.invalid/' }, context), code('TEMPLATE_INPUT_INVALID'));
  assert.throws(() => preflightTemplateInstallation(catalog, { ...input, sourceDigest: `sha256:${'0'.repeat(64)}` }, context), code('TEMPLATE_SOURCE_DIGEST_MISMATCH'));
  assert.throws(() => preflightTemplateInstallation(catalog, input, { ...context, availableServiceSlots: 0 }), code('TEMPLATE_CAPACITY_EXCEEDED'));
  assert.throws(() => preflightTemplateInstallation(catalog, input, { ...context, supportedResourceEngines: [] }), code('TEMPLATE_RESOURCE_UNSUPPORTED'));
  assert.throws(() => preflightTemplateInstallation(catalog, input, { ...context, occupiedServiceSlugs: ['web'] }), code('TEMPLATE_SLUG_CONFLICT'));
  const changed = structuredClone(catalog);
  changed.starters[0].defaults.ATTACK = 'value';
  assert.throws(() => validateTemplateCatalog(changed), code('TEMPLATE_CATALOG_DIGEST_MISMATCH'));
});

test('template graph preserves immutable source, environment, resource dependencies and Dockerfile contract', () => {
  const plan = preflightTemplateInstallation(catalog, request('next-postgres'), context);
  assert.deepEqual(plan.services[0].healthCheck, { path: '/healthz' });
  assert.equal(plan.services[0].source.type, 'template');
  assert.equal(plan.services[0].buildJobPayload.environmentId, context.environmentId);
  assert.equal(plan.services[0].buildJobPayload.dockerfilePath, 'Dockerfile');
  assert.deepEqual(plan.services[0].buildJobPayload.templateResourceIds, plan.resources.map(row => row.id));
  assert.deepEqual(plan.services[0].resourceDependencies, [{ name: 'DATABASE_URL', resourceLogicalSlug: 'postgres', secretKey: 'DATABASE_URL' }]);
  const dev = preflightTemplateInstallation(catalog, request('next-postgres'), { ...context, environmentKind: 'dev', environmentId: 'env_dev_alpha' });
  assert.notEqual(dev.installationId, plan.installationId);
  assert.notEqual(dev.services[0].id, plan.services[0].id);
});

test('progress waits for runtime readiness and reports failed or canceled deployments without false success', () => {
  assert.deepEqual(installationProgress({ resourceStates: ['READY'], buildStates: ['IMAGE_READY'] }), { status: 'building', completed: 1, total: 2 });
  assert.deepEqual(installationProgress({ resourceStates: ['READY'], buildStates: ['READY'] }), { status: 'ready', completed: 2, total: 2 });
  assert.equal(installationProgress({ resourceStates: ['PROVISIONING'], buildStates: ['QUEUED'] }).status, 'provisioning');
  for (const failed of ['FAILED', 'BUILD_FAILED', 'CANCELED']) assert.equal(installationProgress({ resourceStates: [], buildStates: [failed] }).status, 'failed');
});
