import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import '../fixtures/resource-runtime.mjs';
import { createSessionToken } from '../../packages/core/src/identity.ts';
import { bootParityApi } from '../fixtures/api-parity-runtime.mjs';
import { apiOperations, createOpenApiDocument } from '../../packages/schemas/src/api-contract.ts';
import { RAIBITSERVERClient } from '../../packages/api-client/src/index.ts';

test('Given published API contracts, When repaired scope and variable fields are generated, Then the checked-in document agrees', async () => {
  const published = YAML.parse(await readFile(new URL('../../openapi/raibitserver.yaml', import.meta.url), 'utf8'));
  assert.deepEqual(published, JSON.parse(JSON.stringify(createOpenApiDocument())));
  const history = published.paths['/projects/{projectId}/deployments/history'].get.parameters;
  assert.deepEqual(history.find(row => row.name === 'environment').schema.enum, ['production', 'preview', 'manual']);
  assert.deepEqual(history.find(row => row.name === 'environmentKind').schema.enum, ['prod', 'dev']);
});

test('Given prod/dev workloads, When public API review scenarios execute, Then authoritative scope and legacy inputs hold', async t => {
  process.env.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED = '1';
  const runtime = await bootParityApi();
  const { repository: r, baseUrl } = runtime;
  const observations = [];
  try {
    const org = await r.createOrganization({ name: 'Review API', slug: 'review-api' });
    const user = await r.createUser({ name: 'Owner', email: 'review-api@example.test', approvalStatus: 'APPROVED', role: 'USER', accountType: 'NON_CLUB' });
    const member = await r.addMember({ userId: user.id, organizationId: org.id, role: 'OWNER' });
    await r.setQuota({ userId: user.id, maxServices: 12, maxCpuMillicores: 10000, maxMemoryMb: 32768 });
    const token = createSessionToken(user, [member], process.env.RAIBITSERVER_AUTH_JWT_SECRET);
    const client = new RAIBITSERVERClient({ baseUrl, token });
    const project = await r.createProject({ organizationId: org.id, name: 'Review', slug: 'review' });
    const prod = await r.resolveEnvironment(project.id);
    const dev = await r.createEnvironment({ projectId: project.id, kind: 'dev', expectedVersion: 0 });
    const image = { sourceType: 'image', image: 'example/review:v1' };
    const prodService = await r.createService({ projectId: project.id, name: 'Web', ...image });
    const devService = await r.createService({ projectId: project.id, name: 'Web', environmentId: dev.id, ...image });
    const devResource = await r.createResource({ projectId: project.id, name: 'Data', environmentId: dev.id, engine: 'postgresql' });
    const foreignOrg = await r.createOrganization({ name: 'Foreign', slug: 'review-foreign' });
    const foreign = await r.createProject({ organizationId: foreignOrg.id, name: 'Foreign', slug: 'foreign' });
    const foreignService = await r.createService({ projectId: foreign.id, name: 'Foreign', ...image });
    const req = async (method, path, body, auth = token) => {
      const response = await fetch(baseUrl + path, { method, headers: { authorization: `Bearer ${auth}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
      const result = { status: response.status, body: await response.json() };
      observations.push({ method, path, input: body, ...result });
      return result;
    };

    await t.test('F4 Given a dev domain, When status and mutations select an environment, Then its service binding governs access', async () => {
      const created = await req('POST', `/projects/${project.id}/domains`, { serviceId: devService.id, hostname: 'review-api.example.test', environmentId: dev.id });
      assert.equal(created.status, 201);
      const id = created.body.domain.id;
      const statuses = [];
      for (const query of ['', '?environment=prod', '?environment=dev']) statuses.push((await req('GET', `/domains/${id}${query}`)).status);
      for (const suffix of ['/rotate', '/verify', '']) {
        const method = suffix ? 'POST' : 'DELETE';
        statuses.push((await req(method, `/domains/${id}${suffix}`, { expectedVersion: 1 })).status);
      }
      assert.deepEqual(statuses, [404, 404, 200, 404, 404, 404]);
      const rotated = await req('POST', `/domains/${id}/rotate?environment=dev`, { expectedVersion: 1 });
      assert.equal(rotated.status, 202);
      const current = await req('GET', `/domains/${id}?environment=dev`);
      assert.equal((await req('POST', `/domains/${id}/verify?environment=dev`, { expectedVersion: current.body.verificationVersion })).status, 202);
      const latest = await req('GET', `/domains/${id}?environment=dev`);
      assert.equal((await req('DELETE', `/domains/${id}?environment=dev`, { expectedVersion: latest.body.verificationVersion })).status, 202);
    });

    await t.test('F9 Given an environment-variable map, When creating prod or dev services, Then the map survives selection and typed transport', async () => {
      for (const [name, selector, expectedId] of [['Vars Prod', {}, prod.id], ['Vars Dev', { environmentKind: 'dev' }, dev.id]]) {
        const input = { name, ...image, environment: { HELLO: 'world' }, ...selector };
        const created = await req('POST', `/projects/${project.id}/services`, input);
        assert.equal(created.status, 201);
        assert.equal(created.body.environmentId, expectedId);
        assert.deepEqual(created.body.environment, { HELLO: 'world' });
        assert.deepEqual(apiOperations['services-create'].input.parse({ path: { projectId: project.id }, query: {}, body: input }).body.environment, { HELLO: 'world' });
      }
    });

    await t.test('F8 Given a dev resource, When backup pagination includes selectors, Then valid scope succeeds and invalid pagination still rejects', async () => {
      const base = `/resources/${devResource.id}/backups`;
      const responses = [];
      for (const query of ['', `?environmentId=${dev.id}`, '?environment=dev&limit=1', '?environment=dev&limit=invalid', '?environment=dev&unexpected=x']) responses.push(await req('GET', base + query));
      assert.deepEqual(responses.map(row => row.status), [404, 200, 200, 400, 400]);
      assert.deepEqual(responses[1].body.backups, []);
      assert.equal(responses[2].body.nextCursor, null);
    });

    await t.test('F10 Given foreign and same-scope subjects, When accessing project resources, Then foreign targets are 404 and same-scope forbidden actions are 403', async () => {
      const maintainer = await r.createUser({ name: 'Maintainer', email: 'review-maintainer@example.test', approvalStatus: 'APPROVED', role: 'USER' });
      const membership = await r.addMember({ userId: maintainer.id, organizationId: org.id, role: 'MAINTAINER' });
      const mt = createSessionToken(maintainer, [membership], process.env.RAIBITSERVER_AUTH_JWT_SECRET);
      const actual = [
        await req('GET', `/projects/${foreign.id}/services`),
        await req('POST', `/projects/${foreign.id}/environments`, { kind: 'dev', expectedVersion: 0 }),
        await req('POST', `/projects/${project.id}/environments`, { kind: 'dev', expectedVersion: 0 }, mt),
        await req('POST', `/resources/${devResource.id}/attach?environment=dev`, { serviceId: foreignService.id }),
        await req('POST', `/projects/${foreign.id}/environments`, { kind: 'dev', expectedVersion: 0 }, mt),
      ];
      assert.deepEqual(actual.map(row => row.status), [404, 404, 403, 404, 404]);
      for (const response of actual.filter(row => row.status === 404)) assert.equal(JSON.stringify(response.body).includes(foreignOrg.id), false);
    });

    await t.test('F5 Given prod and dev deployment histories, When overview, filters and cursors select scope, Then legacy deployment type remains independent', async () => {
      const p = (await req('POST', `/services/${prodService.id}/deployments`, { deploymentType: 'production', commitSha: '1'.repeat(40) })).body;
      const d = (await req('POST', `/services/${devService.id}/deployments?environment=dev`, { deploymentType: 'production', commitSha: '2'.repeat(40) })).body;
      const preview = (await req('POST', `/services/${devService.id}/deployments?environment=dev`, { deploymentType: 'preview', commitSha: '3'.repeat(40) })).body;
      const historyPath = `/projects/${project.id}/deployments/history`;
      const defaultHistory = await req('GET', historyPath);
      const devHistory = await req('GET', historyPath + '?environmentKind=dev');
      const typeFilter = await req('GET', historyPath + '?environmentKind=dev&environment=preview');
      const foreignHistory = await req('GET', historyPath + '?environmentId=env_foreign');
      assert.equal(defaultHistory.status, 200);
      assert.deepEqual(defaultHistory.body.deployments.map(row => row.id), [p.id]);
      assert.equal(devHistory.status, 200);
      assert.deepEqual(new Set(devHistory.body.deployments.map(row => row.id)), new Set([d.id, preview.id]));
      assert.equal(typeFilter.status, 200);
      assert.deepEqual(typeFilter.body.deployments.map(row => row.id), [preview.id]);
      assert.equal(typeFilter.body.deployments[0].environment, 'preview');
      assert.equal(typeFilter.body.deployments[0].environmentKind, 'dev');
      assert.equal(typeFilter.body.deployments[0].environmentId, dev.id);
      assert.equal(foreignHistory.status, 404);
      const typedHistory = await client.listDeploymentHistory(project.id, { environmentKind: 'dev', environment: 'preview' });
      assert.deepEqual(typedHistory.deployments.map(row => row.id), [preview.id]);
      observations.push({ client: 'listDeploymentHistory', input: { projectId: project.id, environmentKind: 'dev', environment: 'preview' }, output: typedHistory });
      for (const [query, status] of [['', 404], ['?environment=prod', 404], ['?environment=dev', 200]]) {
        const detail = await req('GET', `/deployments/${d.id}${query}`);
        assert.equal(detail.status, status);
        if (status === 200) assert.equal(detail.body.environmentId, dev.id);
      }
      for (const [query, ids] of [['', [p.id]], ['?environment=dev', [d.id, preview.id]]]) {
        const overview = await req('GET', `/projects/${project.id}/overview${query}`);
        assert.equal(overview.status, 200);
        assert.deepEqual(new Set(overview.body.deployments.map(row => row.id)), new Set(ids));
        assert.equal(overview.body.services.every(row => row.environmentId === (query ? dev.id : prod.id)), true);
      }
      const page = await req('GET', historyPath + '?environmentKind=dev&limit=1');
      assert.equal(typeof page.body.page.nextCursor, 'string');
      const next = await req('GET', historyPath + `?environmentKind=dev&limit=1&cursor=${page.body.page.nextCursor}`);
      assert.equal(next.status, 200);
      assert.notEqual(next.body.deployments[0].id, page.body.deployments[0].id);
      assert.equal((await req('GET', historyPath + `?limit=1&cursor=${page.body.page.nextCursor}`)).status, 400);
    });

    await t.test('F6 Given the same GitHub repo imported to prod and dev, When sync selects scope, Then only matching bound services reach the job', async () => {
      const integration = r.store.connectVerifiedGitHubInstallation({ organizationId: org.id, userId: user.id, installationId: '79001', accountLogin: 'review' });
      r.store.replaceGitHubInstallationRepositories({ installationId: '79001', repositories: [{ githubRepoId: '79002', fullName: 'review/dual', defaultBranch: 'main', private: false }] });
      const source = { projectId: project.id, integrationId: integration.id, repositoryId: '79002', serviceName: 'Github', serviceSlug: 'github' };
      const prodImport = await req('POST', '/github/repositories/import', { ...source, branch: 'main', idempotencyKey: 'review-prod' });
      const devImport = await req('POST', '/github/repositories/import', { ...source, branch: 'develop', environmentId: dev.id, idempotencyKey: 'review-dev' });
      assert.equal(prodImport.status, 201);
      assert.equal(devImport.status, 201);
      for (const [query, serviceId] of [['', prodImport.body.service.id], ['?environment=dev', devImport.body.service.id], [`?environmentId=${dev.id}`, devImport.body.service.id]]) {
        const synced = await req('POST', '/github/repositories/review%2Fdual/sync' + query, {});
        assert.equal(synced.status, 202);
        assert.deepEqual(synced.body.services.map(row => row.id), [serviceId]);
        assert.deepEqual(synced.body.workflowJob.payload.serviceIds, [serviceId]);
        assert.equal(synced.body.workflowJob.operationalProtocolVersion, query ? 2 : 1);
        assert.equal(synced.body.workflowJob.environmentId, query ? dev.id : prod.id);
      }
      assert.equal((await req('POST', '/github/repositories/review%2Fdual/sync?environmentId=env_foreign', {})).status, 404);
      const typedSync = await client.syncGitHubRepository('review/dual', {}, { environmentId: dev.id });
      assert.deepEqual(typedSync.services.map(row => row.id), [devImport.body.service.id]);
      observations.push({ client: 'syncGitHubRepository', input: { repositoryId: 'review/dual', body: {}, query: { environmentId: dev.id } }, output: typedSync });
    });

    await t.test('F11 Given explicit conflicting selectors, When the API resolves a dev ID, Then aliases fail closed and ID-only stays valid', async () => {
      const base = `/services/${devService.id}`;
      const queries = [`?environmentId=${dev.id}`, `?environmentId=${dev.id}&environment=prod`, '?environment=prod&environmentKind=dev', '?environment='];
      const statuses = [];
      for (const query of queries) statuses.push((await req('GET', base + query)).status);
      assert.deepEqual(statuses, [200, 404, 400, 400]);
    });
  } finally {
    await runtime.app.close();
    t.diagnostic(JSON.stringify({ observations, cleanup: { appClosed: true, persistentResourcesCreated: 0, fixtureRows: 'discarded with process-local memory' } }));
  }
});
