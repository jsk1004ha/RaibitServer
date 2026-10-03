import assert from 'node:assert/strict';
import test from 'node:test';
import '../fixtures/resource-runtime.mjs';
import { bootParityApi } from '../fixtures/api-parity-runtime.mjs';
import { createSessionToken } from '../../packages/core/src/identity.ts';
import { openSecret } from '../../packages/core/src/secret-vault.ts';
import { TemplateCatalogResponseSchema, TemplatePreflightResponseSchema, TemplateInstallationResponseSchema, TemplateInstallationListResponseSchema } from '../../packages/schemas/src/templates.ts';

test('template HTTP flow scopes access, seals direct tokens, replays safely and restores durable progress', async t => {
  Object.assign(process.env, { RAIBITSERVER_OPERATIONAL_IMPLEMENTATION_AVAILABLE: '1', RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED: '1', RAIBITSERVER_OPERATIONAL_PROTOCOL_VERSION: '2', RAIBITSERVER_OPERATIONAL_CONTRACT_DIGEST: 'a'.repeat(64), RAIBITSERVER_RELEASE_REVISION: 'b'.repeat(40), RAIBITSERVER_RELEASE_SOURCE_CLEAN: '1' });
  const runtime = await bootParityApi();
  const r = runtime.repository;
  try {
    const org = await r.createOrganization({ name: 'Template API', slug: 'template-api' });
    const foreignOrg = await r.createOrganization({ name: 'Foreign templates', slug: 'foreign-templates' });
    const tokens = {};
    for (const [name, role, organizationId] of [['owner', 'OWNER', org.id], ['reader', 'VIEWER', org.id], ['maintainer', 'MAINTAINER', org.id], ['outsider', 'OWNER', foreignOrg.id]]) {
      const user = await r.createUser({ name, email: `template-${name}@example.test`, approvalStatus: 'APPROVED', role: 'USER', accountType: 'NON_CLUB' });
      const member = await r.addMember({ userId: user.id, organizationId, role });
      await r.setQuota({ userId: user.id, maxServices: 30, maxCpuMillicores: 10000, maxMemoryMb: 32768, maxDbStorageMb: 10000 });
      tokens[name] = createSessionToken(user, [member], process.env.RAIBITSERVER_AUTH_JWT_SECRET);
    }
    const project = await r.createProject({ organizationId: org.id, name: 'Templates', slug: 'templates' });
    const dev = await r.createEnvironment({ projectId: project.id, kind: 'dev', expectedVersion: 0 });
    const req = async (method, route, body, who = 'owner') => {
      const result = await fetch(runtime.baseUrl + route, { method, headers: { authorization: `Bearer ${tokens[who]}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      return { status: result.status, body: await result.json() };
    };
    const catalog = (await req('GET', '/templates')).body;
    TemplateCatalogResponseSchema.parse(catalog);
    const starter = catalog.starters.find(row => row.id === 'discord-bot');
    const token = 'private-token-never-in-public-results';
    const input = { requiredProtocolVersion: 2, catalogId: starter.id, catalogVersion: starter.version, catalogDigest: catalog.catalogDigest, sourceDigest: starter.source.digest, requestIdempotencyKey: 'http-install-discord-001', inputs: { DISCORD_TOKEN: token } };
    const path = `/projects/${project.id}/template-installations`;
    let installation;

    await t.test('catalog is readable with safe disabled availability and preflight makes no writes', async () => {
      process.env.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED = '0';
      const disabled = await req('GET', '/templates');
      assert.deepEqual(disabled.body.availability, { enabled: false, reasonCode: 'TEMPLATE_UNAVAILABLE' });
      const blocked = await req('POST', `${path}/preflight`, input);
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.code, 'TEMPLATE_UNAVAILABLE');
      process.env.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED = '1';
      const before = JSON.stringify(r.store.snapshot());
      const preview = await req('POST', `${path}/preflight`, input);
      assert.equal(preview.status, 200);
      TemplatePreflightResponseSchema.parse(preview.body);
      assert.equal(JSON.stringify(preview.body).includes(token), false);
      assert.equal(JSON.stringify(r.store.snapshot()), before);
    });

    await t.test('install seals the direct token once, returns narrow fields, and rejects changed replay', async () => {
      const installed = await req('POST', path, input);
      assert.equal(installed.status, 202);
      installation = TemplateInstallationResponseSchema.parse(installed.body);
      assert.equal(installation.progress.status, 'building');
      for (const forbidden of [token, 'secret:', 'requestFingerprint', 'actorUserId', 'buildJobPayload']) assert.equal(JSON.stringify(installed.body).includes(forbidden), false);
      const secrets = [...r.store.secrets.values()];
      assert.equal(secrets.length, 1);
      assert.equal(openSecret(secrets[0].sealedValue), token);
      assert.equal(secrets[0].metadata.environmentId, installation.installation.environmentId);
      assert.equal(JSON.stringify(r.store.snapshot()).includes(token), false);
      const replay = await req('POST', path, input);
      assert.equal(replay.status, 202);
      assert.deepEqual(replay.body, installed.body);
      const changed = await req('POST', path, { ...input, inputs: { DISCORD_TOKEN: 'changed-token' } });
      assert.equal(changed.status, 409);
      assert.equal(changed.body.code, 'TEMPLATE_VERSION_CONFLICT');
      assert.equal(r.store.secrets.size, 1);
    });

    await t.test('reload lists only selected environment and reader access cannot mutate', async () => {
      const listed = await req('GET', path, undefined, 'reader');
      TemplateInstallationListResponseSchema.parse(listed.body);
      assert.deepEqual(listed.body.installations, [installation]);
      assert.deepEqual((await req('GET', `${path}?environmentId=${dev.id}`)).body.installations, []);
      assert.equal((await req('GET', `/template-installations/${installation.installation.id}`, undefined, 'reader')).status, 200);
      assert.equal((await req('GET', `/template-installations/${installation.installation.id}?environmentId=${dev.id}`)).status, 404);
      assert.equal((await req('GET', path, undefined, 'outsider')).status, 404);
      assert.equal((await req('POST', `${path}/preflight`, input, 'reader')).status, 403);
      assert.equal((await req('POST', `${path}/preflight`, input, 'outsider')).status, 404);
      assert.equal((await req('POST', `/template-installations/${installation.installation.id}/retry`, { requiredProtocolVersion: 2, expectedVersion: 1, requestIdempotencyKey: 'retry-reader-001' }, 'reader')).status, 403);
      assert.equal((await req('POST', `/template-installations/${installation.installation.id}/retry`, { requiredProtocolVersion: 2, expectedVersion: 1, requestIdempotencyKey: 'retry-foreign-001' }, 'outsider')).status, 404);
      assert.equal((await req('POST', `${path}/preflight`, { ...input, requestIdempotencyKey: 'maintainer-preflight-001' }, 'maintainer')).body.code, 'TEMPLATE_SLUG_CONFLICT');
    });

    await t.test('progress waits for deployment READY and failed build retry is idempotent', async () => {
      const id = installation.installation.id;
      const deployment = r.store.deployments.get(installation.services[0].deploymentId);
      const job = r.store.workflowJobs.find(row => row.payload.deploymentId === deployment.id);
      deployment.status = 'IMAGE_READY';
      assert.equal((await req('GET', `/template-installations/${id}`)).body.progress.status, 'building');
      const noop = { requiredProtocolVersion: 2, expectedVersion: 1, requestIdempotencyKey: 'retry-noop-001' };
      assert.equal((await req('POST', `/template-installations/${id}/retry`, noop)).status, 202);
      deployment.status = 'FAILED'; job.status = 'failed'; job.attempts = 3;
      assert.equal((await req('GET', `/template-installations/${id}`)).body.progress.status, 'failed');
      assert.equal((await req('POST', `/template-installations/${id}/retry`, noop)).body.progress.status, 'failed');
      assert.equal(job.status, 'failed');
      const retry = { requiredProtocolVersion: 2, expectedVersion: 1, requestIdempotencyKey: 'retry-build-001' };
      const restarted = await req('POST', `/template-installations/${id}/retry`, retry);
      assert.equal(restarted.status, 202);
      assert.equal(restarted.body.progress.status, 'building');
      assert.equal(job.status, 'queued');
      assert.equal((await req('POST', `/template-installations/${id}/retry`, retry)).status, 202);
      assert.equal(r.store.auditLogs.filter(row => row.action === 'template:retry' && row.targetId === id && row.metadata.requestIdempotencyKey === retry.requestIdempotencyKey).length, 1);
      assert.equal((await req('POST', `/deployments/${deployment.id}/cancel`, {})).status, 200);
      assert.equal((await req('GET', `/template-installations/${id}`)).body.progress.status, 'failed');
      const canceledRetry = await req('POST', `/template-installations/${id}/retry`, { ...retry, requestIdempotencyKey: 'retry-canceled-001' });
      assert.equal(canceledRetry.status, 202);
      assert.equal(canceledRetry.body.progress.status, 'building');
      assert.equal(r.store.workflowJobs.find(row => row.id === job.id).status, 'queued');
      r.store.deployments.get(deployment.id).status = 'READY';
      assert.equal((await req('GET', `/template-installations/${id}`)).body.progress.status, 'ready');
    });
  } finally { await runtime.app.close(); }
});
