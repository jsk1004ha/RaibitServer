import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { apiOperations, createOpenApiDocument, ErrorBody, GitHubOAuthCallbackInput, z } from '../packages/schemas/src/api-contract.ts';
import { RAIBITSERVERClient } from '../packages/api-client/src/index.ts';
import { hashPassword } from '../packages/core/src/identity.ts';
import { encodeDeploymentActivityResumeToken } from '../packages/core/src/sse.ts';
import { bootParityApi } from './fixtures/api-parity-runtime.mjs';

const requiredWireBodies = {
  'github-repositories-refresh': { expectedIntegrationVersion: 1, expectedGeneration: 0 },
};

test('OAuth callback contract represents exactly one bound code or fixed denial', () => {
  // Given: the same binding is required for both callback variants.
  const binding = { state: 'A'.repeat(43), codeVerifier: 'B'.repeat(43) };
  // When: parse valid and ambiguous callback inputs through the client contract.
  const valid = [{ ...binding, code: 'fixture-code' }, { ...binding, error: 'access_denied' }];
  const invalid = [binding, { ...binding, code: 'fixture-code', error: 'access_denied' }, { error: 'access_denied' }, { ...binding, error: 'arbitrary' }];
  // Then: strict union and generated query schema retain the cross-field rule.
  assert.equal(valid.every((value) => GitHubOAuthCallbackInput.safeParse(value).success), true);
  assert.equal(invalid.every((value) => !GitHubOAuthCallbackInput.safeParse(value).success), true);
  assert.equal(createOpenApiDocument().paths['/auth/github/callback'].get['x-query-schema'].anyOf.length, 2);
});

test('Given advertised operations, when their success bodies are inspected, then each has a semantic contract', async () => {
  // Given
  const document = YAML.parse(await fs.readFile(new URL('../openapi/raibitserver.yaml', import.meta.url), 'utf8'));
  // When
  const failures = Object.entries(document.paths).flatMap(([path, verbs]) => Object.entries(verbs).flatMap(([method, operation]) => {
    const id = operation.operationId || `${method.toUpperCase()} ${path}`;
    return Object.entries(operation.responses).filter(([status, response]) => Number(status) < 300 && Number(status) !== 204 && !response.content)
      .map(([status]) => `${id}: untyped success body ${status}`);
  }));
  // Then
  assert.deepEqual(failures, []);
});

test('Given the running Nest graph, when contracts and HTTP are exercised, then every advertised operation agrees', async () => {
  // Given: independent OpenAPI artifact, hand-authored fixtures, real Nest DI/routes.
  const document = YAML.parse(await fs.readFile(new URL('../openapi/raibitserver.yaml', import.meta.url), 'utf8'));
  const fixtures = JSON.parse(await fs.readFile(new URL('./fixtures/openapi/semantic-parity.json', import.meta.url), 'utf8'));
  const mismatches = JSON.parse(await fs.readFile(new URL('./fixtures/openapi/semantic-mismatch.json', import.meta.url), 'utf8'));
  const mutation = JSON.parse(process.env.RAIBIT_API_PARITY_MUTATION || '{}');
  const operations = Object.entries(document.paths).flatMap(([path, verbs]) => Object.entries(verbs).map(([method, operation]) => ({ ...operation, path, method })));
  const target = operations.find((operation) => operation.operationId === mutation.operation);
  const runtime = await bootParityApi({ ...mutation, path: target?.path, method: target?.method });
  const report = { cwd: process.cwd(), operations: [], fixtures: [], http: [], counts: { phantomOperations: 0, missingClientMethods: 0, untypedBodies: 0, schemaMismatches: 0 }, cleanup: false };
  const observed = [];
  const wire = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    observed.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ statusCode: 400, message: 'wire contract probe', error: 'Bad Request' }));
  });
  wire.listen(0, '127.0.0.1');
  await once(wire, 'listening');
  try {
    // When: invoke every client method against a real HTTP listener, independently
    // compare its emitted verb/path/body/query and Nest metadata to the YAML artifact.
    const client = new RAIBITSERVERClient({ baseUrl: `http://127.0.0.1:${wire.address().port}`, token: 'wire-fixture-token' });
    const expectedDocument = JSON.parse(JSON.stringify(createOpenApiDocument()));
    assert.deepEqual(document.components.schemas, expectedDocument.components.schemas, 'OpenAPI/Zod component schema disagreement');
    for (const operation of operations) {
      const id = operation.operationId;
      const route = runtime.routes.find((candidate) => candidate.path === operation.path && candidate.method === operation.method);
      if (!route) report.counts.phantomOperations += 1;
      assert.ok(route, `${id}: Nest/OpenAPI/client disagreement: ${operation.method.toUpperCase()} ${operation.path}`);
      assert.equal(route.status, Number(Object.keys(operation.responses).find((status) => Number(status) < 300)), `${id}: HTTP status disagreement`);
      assert.equal(route.permission, operation['x-permission'], `${id}: authorization metadata disagreement`);
      assert.deepEqual(operation.security, expectedDocument.paths[operation.path][operation.method].security, `${id}: security scheme disagreement`);
      const contract = apiOperations[id];
      assert.ok(contract, `${id}: missing Zod contract`);
      for (const response of Object.values(operation.responses)) {
        const schema = Object.values(response.content || {})[0]?.schema;
        if (!hasTypedBody(schema, document.components.schemas)) report.counts.untypedBodies += 1;
        assert.ok(hasTypedBody(schema, document.components.schemas), `${id}: untyped success/error body`);
      }
      assert.deepEqual(document.paths[operation.path][operation.method], expectedDocument.paths[operation.path][operation.method], `${id}: OpenAPI/Zod schema disagreement`);
      if (typeof client.operations[id] !== 'function') report.counts.missingClientMethods += 1;
      assert.equal(typeof client.operations[id], 'function', `${id}: missing typed client method`);
      const input = { path: Object.fromEntries(operation.parameters.filter((parameter) => parameter.in === 'path').map((parameter) => [parameter.name, `${parameter.name} /+?`])), query: fixtures.wireQueries[id] || {}, body: fixtures.wireBodies[id] || requiredWireBodies[id] || {} };
      await assert.rejects(client.operations[id](input), (error) => error.status === 400, `${id}: client must parse the wire error`);
      const captured = observed.at(-1);
      const expectedPath = operation.path.replace(/\{([^}]+)\}/g, (_match, key) => encodeURIComponent(input.path[key]));
      const expectedQuery = new URLSearchParams(Object.entries(input.query).map(([key, value]) => [key, String(value)])).toString();
      assert.equal(captured.method, operation.method.toUpperCase(), `${id}: client method disagreement`);
      assert.equal(captured.url, expectedPath + (expectedQuery ? `?${expectedQuery}` : ''), `${id}: client path/query disagreement`);
      assert.equal(captured.authorization, 'Bearer wire-fixture-token', `${id}: client authorization missing`);
      if (Object.keys(input.body).length) assert.deepEqual(JSON.parse(captured.body), input.body, `${id}: client body disagreement`);
      else assert.equal(captured.body, '', `${id}: empty request body disagreement`);
      report.operations.push({ operationId: id, method: captured.method, path: operation.path, status: route.status, permission: route.permission, wire: operation.path.startsWith('/auth/github/') ? expectedPath + '?[REDACTED]' : captured.url });
    }
    for (const fixture of fixtures.responseFixtures) {
      const contract = apiOperations[fixture.operation];
      assert.equal(contract.response.safeParse(fixture.body).success, true, `${fixture.operation}: valid fixture rejected by Zod`);
      const operation = operations.find((candidate) => candidate.operationId === fixture.operation);
      const schema = Object.values(operation.responses[contract.status].content)[0].schema;
      const standalone = JSON.parse(JSON.stringify({ ...schema, $defs: document.components.schemas }).replaceAll('#/components/schemas/', '#/$defs/'));
      assert.equal(z.fromJSONSchema(standalone).safeParse(fixture.body).success, true, `${fixture.operation}: valid fixture rejected by OpenAPI`);
      report.fixtures.push({ operationId: fixture.operation, valid: true });
    }
    for (const fixture of mismatches) {
      assert.equal(apiOperations[fixture.operation].response.safeParse(fixture.body).success, false, `${fixture.operation}: invalid fixture accepted`);
      report.fixtures.push({ operationId: fixture.operation, valid: false });
    }
    const user = runtime.repository.store.createUser({ name: 'Parity', email: 'parity@example.test', passwordHash: hashPassword('test-password'), role: 'ADMIN', approvalStatus: 'APPROVED', accountType: 'CLUB_MEMBER' });
    const organization = runtime.repository.store.createOrganization({ name: 'Parity', slug: 'parity' });
    runtime.repository.store.addMember({ userId: user.id, organizationId: organization.id, role: 'owner' });
    const values = {};
    let token;
    for (const scenario of fixtures.http) {
      const contract = apiOperations[scenario.operation];
      const url = scenario.path.replace(/\{([^}]+)\}/g, (_match, key) => values[key]);
      const resumeHeaders = scenario.operation === 'deployments-stream'
        ? { 'last-event-id': encodeDeploymentActivityResumeToken({ projectId: values.projectId, deploymentId: values.deploymentId }, {}) }
        : {};
      const headers = { 'content-type': 'application/json', ...(scenario.public ? {} : { authorization: `Bearer ${token}` }), ...resumeHeaders };
      const response = await fetch(runtime.baseUrl + url, { method: scenario.method, headers, body: scenario.body ? JSON.stringify(scenario.body) : undefined, signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, scenario.status, `${scenario.operation}: real HTTP status mismatch ${await (!response.ok && response.status !== scenario.status ? response.text() : Promise.resolve(''))}`);
      let body;
      if (scenario.stream) {
        assert.match(response.headers.get('content-type'), /^text\/event-stream/, `${scenario.operation}: SSE content type`);
        const reader = response.body.getReader();
        let text = '';
        try {
          while (!text.includes('data: ')) { const chunk = await reader.read(); assert.equal(chunk.done, false); text += new TextDecoder().decode(chunk.value); }
          assert.match(text, /id: .+\nevent: /);
          body = JSON.parse(text.split('\n').find((line) => line.startsWith('data: ')).slice(6));
        } finally { await reader.cancel(); reader.releaseLock(); }
      } else body = await response.json();
      const parsed = (response.ok ? contract.response : ErrorBody).safeParse(body);
      assert.equal(parsed.success, true, `${scenario.operation}: real HTTP schema mismatch ${JSON.stringify(parsed.error?.issues)}`);
      if (scenario.stream) {
        assert.ok(body.service || body.deployment, `${scenario.operation}: initial connection must start with an authorized snapshot`);
        const liveClient = new RAIBITSERVERClient({ baseUrl: runtime.baseUrl, token });
        const streamPath = Object.fromEntries(Object.keys(contract.input.shape.path.shape).map((key) => [key, values[key]]));
        const snapshot = await liveClient.operations[scenario.operation]({ path: streamPath, query: {}, body: {} });
        assert.equal(snapshot.logs.length, 1, `${scenario.operation}: typed client snapshot content`);
      }
      if (scenario.operation === 'projects-list') assert.equal(body.projects.length, 1, 'projects-list: limit must bound the actual response');
      if (scenario.operation === 'deployments-list') {
        const client = new RAIBITSERVERClient({ baseUrl: runtime.baseUrl, token });
        const page = await client.operations['deployments-list']({ path: { serviceId: values.serviceId }, query: { limit: 1, cursor: body.nextCursor }, body: {} });
        assert.equal(page.deployments.length, 1, 'deployments-list: cursor must load the next bounded page');
        assert.notEqual(page.deployments[0].id, body.deployments[0].id, 'deployments-list: cursor must not repeat the previous page');
        report.http.push({ operationId: 'deployments-list', method: 'GET', status: 200, scenario: 'next-page-cursor', schemaValid: true });
      }
      if (scenario.saveToken) token = body.token;
      if (scenario.save) values[scenario.save] = body.id;
      if (scenario.save === 'deploymentId') {
        runtime.repository.store.appendBuildLog({ deploymentId: body.id, line: 'build ready' });
        runtime.repository.store.appendRuntimeLog({ serviceId: values.serviceId, sourceInstanceId: 'semantic-parity-runtime', line: 'runtime ready' });
        runtime.repository.store.createDeployment({ id: 'parity-ready', serviceId: values.serviceId, imageUrl: 'nginx:alpine', status: 'READY' });
      }
      report.http.push({ operationId: scenario.operation, method: scenario.method, status: response.status, contentType: response.headers.get('content-type'), schemaValid: true });
    }
    // Then: every Nest route is covered, and real requests/schema boundaries agree.
    assert.equal(report.operations.length, runtime.routes.length);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = error.message;
    if (error.message.includes('schema')) report.counts.schemaMismatches += 1;
    throw error;
  } finally {
    await runtime.app.close();
    wire.close();
    wire.closeAllConnections();
    await once(wire, 'close');
    report.cleanup = true;
    const reportPath = process.env.RAIBIT_API_PARITY_REPORT;
    if (reportPath) {
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    } else console.log(JSON.stringify({ apiOperationParity: report }));
    console.log(`Operation parity report: ${reportPath || 'stdout'}; checked=${report.operations.length}; HTTP=${report.http.length}; cleanup=${report.cleanup}`);
  }
});

function hasTypedBody(schema, components) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.$ref) return hasTypedBody(components[schema.$ref.split('/').at(-1)], components);
  if (schema.oneOf) return schema.oneOf.every((branch) => hasTypedBody(branch, components));
  if (schema.anyOf) return schema.anyOf.every((branch) => hasTypedBody(branch, components));
  return schema.type === 'object' && Object.keys(schema.properties || {}).length > 0 && (schema.required || []).length > 0;
}
