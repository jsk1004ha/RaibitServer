import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../fixtures/resource-runtime.mjs';
import { bootParityApi } from '../fixtures/api-parity-runtime.mjs';
import { createSessionToken } from '../../packages/core/src/identity.ts';
import { fixture as recoveryFixture, readyBackup } from '../resource-recovery-fixture.test.js';

test('R3 Given scoped entities and a viewer, When entity routes authorize actions, Then visibility precedes denial', async t => {
  process.env.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED = '1';
  const runtime = await bootParityApi();
  const { repository: r, baseUrl } = runtime;
  const observations = [];
  try {
    const owner = await r.createUser({ email: 'r3-owner@example.test', approvalStatus: 'APPROVED', role: 'USER' });
    const viewer = await r.createUser({ email: 'r3-viewer@example.test', approvalStatus: 'APPROVED', role: 'USER' });
    const ownOrg = await r.createOrganization({ name: 'R3 Own', slug: 'r3-own' });
    const foreignOrg = await r.createOrganization({ name: 'R3 Foreign', slug: 'r3-foreign' });
    const memberships = await Promise.all([ownOrg, foreignOrg].map(org => r.addMember({ organizationId: org.id, userId: owner.id, role: 'OWNER' })));
    const vm = await r.addMember({ organizationId: ownOrg.id, userId: viewer.id, role: 'VIEWER' });
    const token = createSessionToken(viewer, [vm], process.env.RAIBITSERVER_AUTH_JWT_SECRET);
    const ownerToken = createSessionToken(owner, memberships, process.env.RAIBITSERVER_AUTH_JWT_SECRET);
    const ownProject = await r.createProject({ organizationId: ownOrg.id, name: 'Own', slug: 'own', status: 'ACTIVE' });
    const foreignProject = await r.createProject({ organizationId: foreignOrg.id, name: 'Foreign', slug: 'foreign', status: 'ACTIVE' });
    const dev = await r.createEnvironment({ projectId: ownProject.id, kind: 'dev', expectedVersion: 0 });
    const targets = [];
    for (const [label, project, selector] of [['own', ownProject, {}], ['dev', ownProject, { environmentId: dev.id }], ['foreign', foreignProject, {}]]) {
      const service = await r.createService({ projectId: project.id, name: 'Web', sourceType: 'image', image: 'example/r3:v1', ...selector });
      const resource = await r.createResource({ projectId: project.id, name: 'Data', engine: 'postgresql', ...selector });
      const domain = (await r.createCustomDomain({ organizationId: project.organizationId, projectId: project.id, serviceId: service.id, hostname: `r3-${label}.example.test`, actorUserId: owner.id })).domain;
      const deployment = await r.createDeployment({ serviceId: service.id, projectId: project.id, status: 'queued' });
      const raw = r.store.resources.get(resource.id);
      const observed = structuredClone(recoveryFixture().resources[0]);
      // Synthetic provider observation enables real recovery admission; no provider is executed.
      r.store.resources.set(resource.id, { ...raw, status: 'READY', connectionSecretName: observed.connectionSecretName, desiredState: observed.desiredState });
      const recovery = r.resourceRecovery(() => {});
      const scope = { organizationId: project.organizationId, actorUserId: owner.id };
      const backup = (await recovery.createBackup({ ...scope, sourceId: resource.id, body: { requestIdempotencyKey: `r3-${label}`, formatVersion: 1 }, now: '2026-09-03T00:00:00Z' })).operation;
      await readyBackup(recovery, backup.id, { organizationId: project.organizationId });
      const restore = (await recovery.createRestore({ ...scope, sourceId: backup.id, body: { requestIdempotencyKey: `r3-restore-${label}`, formatVersion: 1, name: `restored-${label}` }, now: '2026-09-03T00:01:00Z' })).operation;
      targets.push({ serviceId: service.id, resourceId: resource.id, domainId: domain.id, deploymentId: deployment.id, backupId: backup.id, restoreId: restore.id });
    }
    const req = async (method, path, body, auth = token) => {
      const response = await fetch(baseUrl + path, { method, headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
      const result = { status: response.status, body: await response.json() };
      observations.push({ method, path, input: body, actor: auth === ownerToken ? 'owner' : auth ? 'viewer' : 'anonymous', ...result });
      return result;
    };
    const routes = [
      ['serviceId', 'PATCH', id => `/services/${id}`, { name: 'denied' }],
      ['resourceId', 'GET', id => `/resources/${id}/backups`, undefined],
      ['domainId', 'POST', id => `/domains/${id}/rotate`, { expectedVersion: 1 }],
      ['deploymentId', 'POST', id => `/deployments/${id}/cancel`, {}],
      ['backupId', 'DELETE', id => `/backups/${id}`, { confirmed: true }],
      ['restoreId', 'GET', id => `/restores/${id}`, undefined],
    ];
    for (const [param, method, path, body] of routes) await t.test(`Given ${param}, When viewer selects own/foreign/dev/missing scope, Then return 403/404 before mutation`, async () => {
      const [own, selectedDev, foreign] = targets;
      const cases = [[own[param], '', 403], [foreign[param], '', 404], [selectedDev[param], '', 404], [selectedDev[param], '?environment=prod', 404], [selectedDev[param], '?environment=dev', 403], [selectedDev[param], `?environmentId=${dev.id}`, 403], ['missing-r3', '', 404]];
      const responses = [];
      for (const [id, query, expected] of cases) responses.push({ ...(await req(method, path(id) + query, body)), expected });
      assert.deepEqual(responses.map(row => row.status), responses.map(row => row.expected));
      for (const result of responses.filter(row => row.status === 404)) assert.equal(JSON.stringify(result.body).includes(foreignOrg.id), false);
    });
    await t.test('Given actual JWT scope, When callers forge organization labels or omit auth, Then stored visibility and auth still govern', async () => {
      assert.equal((await req('GET', `/services/${targets[0].serviceId}`)).status, 200);
      assert.equal((await req('GET', `/services/${targets[1].serviceId}?environment=dev`)).status, 200);
      assert.equal((await req('PATCH', `/services/${targets[2].serviceId}?organizationId=${ownOrg.id}&projectId=${ownProject.id}`, { organizationId: ownOrg.id, projectId: ownProject.id, name: 'forged' })).status, 404);
      assert.equal((await req('PATCH', `/services/${targets[2].serviceId}`, {}, '')).status, 401);
      assert.equal((await req('GET', `/restores/${targets[1].restoreId}?environment=dev`, undefined, ownerToken)).status, 200);
      assert.equal(r.store.services.get(targets[0].serviceId).name, 'Web');
      assert.equal(r.store.services.get(targets[2].serviceId).name, 'Web');
    });
  } finally {
    await runtime.app.close();
    t.diagnostic(JSON.stringify({ observations, cleanup: { listening: runtime.app.getHttpServer().listening, persistentResourcesCreated: 0, fixtureState: 'discarded at process exit' } }));
  }
});
