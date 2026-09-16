import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import YAML from 'yaml';
import { apiOperations, z } from '../packages/schemas/src/api-contract.ts';
import { RAIBITSERVERClient } from '../packages/api-client/src/index.ts';
import { hashPassword } from '../packages/core/src/identity.ts';
import { bootParityApi } from './fixtures/api-parity-runtime.mjs';

const canonical = { accountType: 'CLUB_MEMBER', maxProjects: 3, maxServices: 4, maxDeploymentsPerDay: 5, maxPreviewDeployments: 0, maxCpuMillicores: 1000, maxMemoryMb: 1024, maxDbStorageMb: 2048, maxObjectStorageMb: 4096, maxBuildMinutesPerMonth: 120, maxRuntimeHoursPerMonth: 240 };
const quotaOperations = ['admin-quota', 'admin-quota-post'];
const input = body => ({ path: { userId: 'quota-user' }, query: {}, body });
const numericKeys = Object.keys(canonical).filter(key => key !== 'accountType');
const malformed = [
  ...numericKeys.map(key => ({ [key]: '3' })),
  { totallyUnknown: true }, { userId: 'override-user' }, { maxProjects: -1 }, { maxProjects: 1.5 },
  { maxProjects: 2147483648 }, { maxProjects: NaN }, { maxProjects: Infinity }, { maxProjects: null },
  { accountType: 'owner' }, { accountType: 'club-member' }, { accountType: null },
];

test('Given canonical and malformed quota inputs, when both aliases parse, then only optional canonical fields survive unchanged', async () => {
  const document = YAML.parse(await fs.readFile(new URL('../openapi/raibitserver.yaml', import.meta.url), 'utf8'));
  for (const operationId of quotaOperations) {
    const contract = apiOperations[operationId];
    const request = document.paths[contract.path][contract.method].requestBody.content['application/json'].schema;
    const openapi = z.fromJSONSchema(JSON.parse(JSON.stringify({ ...request, $defs: document.components.schemas }).replaceAll('#/components/schemas/', '#/$defs/')));
    for (const body of [canonical, {}, { maxProjects: 0 }, { maxProjects: 2147483647 }, { accountType: 'NON_CLUB' }]) {
      assert.deepEqual(contract.input.parse(input(body)).body, body, operationId);
      assert.deepEqual(openapi.parse(body), body, operationId);
    }
    for (const body of malformed) {
      assert.equal(contract.input.safeParse(input(body)).success, false, `${operationId}: malformed quota accepted ${JSON.stringify(body)}`);
      assert.equal(openapi.safeParse(body).success, false, `${operationId}: OpenAPI accepted malformed quota ${JSON.stringify(body)}`);
    }
  }
});

test('Given malformed quota requests, when actual clients call both aliases, then no quota HTTP request is sent', async () => {
  const runtime = await bootParityApi();
  let quotaRequests = 0;
  runtime.app.getHttpServer().on('request', request => { if (request.url.endsWith('/quota')) quotaRequests += 1; });
  try {
    const client = new RAIBITSERVERClient({ baseUrl: runtime.baseUrl });
    for (const operationId of quotaOperations) {
      for (const body of malformed) {
        await assert.rejects(client.operations[operationId](input(body)), error => error.name === 'ZodError', `${operationId}: must reject before HTTP`);
        assert.equal(quotaRequests, 0, `${operationId}: malformed request reached HTTP`);
      }
    }
    console.log(JSON.stringify({ quotaMalformedCases: malformed.length * quotaOperations.length, quotaWireRequests: quotaRequests }));
  } finally { await runtime.app.close(); }
});

test('Given canonical quota changes, when authenticated clients call both real Nest aliases, then the stored typed response preserves every limit', async () => {
  const runtime = await bootParityApi();
  try {
    const user = runtime.repository.store.createUser({ name: 'Quota', email: 'quota@example.test', passwordHash: hashPassword('quota-password'), role: 'ADMIN', approvalStatus: 'APPROVED', accountType: 'CLUB_MEMBER' });
    const organization = runtime.repository.store.createOrganization({ name: 'Quota', slug: 'quota' });
    runtime.repository.store.addMember({ userId: user.id, organizationId: organization.id, role: 'owner' });
    const publicClient = new RAIBITSERVERClient({ baseUrl: runtime.baseUrl });
    const session = await publicClient.operations['auth-login']({ path: {}, query: {}, body: { email: user.email, password: 'quota-password' } });
    const client = new RAIBITSERVERClient({ baseUrl: runtime.baseUrl, token: session.token });
    for (const operationId of quotaOperations) {
      const quota = await client.operations[operationId]({ ...input(canonical), path: { userId: user.id } });
      for (const [key, value] of Object.entries(canonical)) assert.equal(quota[key], value, `${operationId}: ${key}`);
      assert.equal(quota.userId, user.id);
      assert.ok(quota.id && quota.createdAt && quota.updatedAt);
      assert.equal(apiOperations[operationId].response.safeParse({ ...quota, maxProjects: '3' }).success, false, `${operationId}: wrong response primitive accepted`);
      const { maxServices, ...missingLimit } = quota;
      assert.equal(apiOperations[operationId].response.safeParse(missingLimit).success, false, `${operationId}: missing response limit accepted`);
    }
    console.log(JSON.stringify({ canonicalQuotaAliases: quotaOperations, preservedLimits: numericKeys.length }));
  } finally { await runtime.app.close(); }
});
