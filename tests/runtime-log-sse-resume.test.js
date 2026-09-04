import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { signJwtHs256 } from '../packages/core/src/auth.ts';
import { hashPassword } from '../packages/core/src/identity.ts';
import { createOpenApiDocument } from '../packages/schemas/src/api-contract.ts';
import { bootParityApi } from './fixtures/api-parity-runtime.mjs';
import {
  decodeServiceLogResumeToken,
} from '../packages/core/src/sse.ts';

test('Given a service log cursor, When reconnecting, Then only later equal-timestamp rows are emitted', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const organization = controlPlane.store.createOrganization({ name: 'Resume', slug: 'resume' });
  const project = controlPlane.store.createProject({ organizationId: organization.id, name: 'App', slug: 'app' });
  const service = controlPlane.store.createService({ projectId: project.id, name: 'web' });
  const timestamp = '2026-09-04T00:00:00.000Z';
  controlPlane.store.runtimeLogs = [
    { id: 'log-a', serviceId: service.id, line: 'first', timestamp },
    { id: 'log-b', serviceId: service.id, line: 'second', timestamp },
  ];
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'disabled', allowDisabled: true } }));
  server.listen(0);
  await once(server, 'listening');

  try {
    const first = await requestSse(server, `/services/${service.id}/logs/stream`);
    const resumeToken = eventId(first.body);
    controlPlane.store.runtimeLogs.push({ id: 'log-c', serviceId: service.id, line: 'third', timestamp });
    const resumed = await requestSse(server, `/services/${service.id}/logs/stream`, resumeToken);

    assert.doesNotMatch(resumed.body, /first|second/);
    assert.match(resumed.body, /log-c/);
    assert.equal(decodeServiceLogResumeToken(eventId(resumed.body), { projectId: project.id, serviceId: service.id }).logCursor?.id, 'log-c');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Given a scoped resume token, When another service uses it, Then the request is rejected without log disclosure', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const organization = controlPlane.store.createOrganization({ name: 'Isolation', slug: 'isolation' });
  const project = controlPlane.store.createProject({ organizationId: organization.id, name: 'App', slug: 'app' });
  const firstService = controlPlane.store.createService({ projectId: project.id, name: 'first' });
  const secondService = controlPlane.store.createService({ projectId: project.id, name: 'second' });
  controlPlane.store.appendRuntimeLog({ serviceId: firstService.id, sourceInstanceId: 'first-service-runtime', line: 'FIRST_SERVICE_SECRET' });
  controlPlane.store.appendRuntimeLog({ serviceId: secondService.id, sourceInstanceId: 'second-service-runtime', line: 'SECOND_SERVICE_SECRET' });
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'disabled', allowDisabled: true } }));
  server.listen(0);
  await once(server, 'listening');

  try {
    const first = await requestSse(server, `/services/${firstService.id}/logs/stream`);
    const response = await requestSse(server, `/services/${secondService.id}/logs/stream`, eventId(first.body));

    assert.equal(response.statusCode, 400);
    assert.doesNotMatch(response.body, /FIRST_SERVICE_SECRET|SECOND_SERVICE_SECRET/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Given malformed or oversized Last-Event-ID, When opening runtime logs, Then bounded validation returns 400', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const organization = controlPlane.store.createOrganization({ name: 'Bounds', slug: 'bounds' });
  const project = controlPlane.store.createProject({ organizationId: organization.id, name: 'App', slug: 'app' });
  const service = controlPlane.store.createService({ projectId: project.id, name: 'web' });
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'disabled', allowDisabled: true } }));
  server.listen(0);
  await once(server, 'listening');

  try {
    for (const value of ['not-a-token', 'a'.repeat(4097)]) {
      const response = await requestSse(server, `/services/${service.id}/logs/stream`, value);
      assert.equal(response.statusCode, 400);
    }
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Given a valid resume token, When authentication or project access is missing, Then reconnect fails closed', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const organization = controlPlane.store.createOrganization({ name: 'Private', slug: 'private' });
  const project = controlPlane.store.createProject({ organizationId: organization.id, name: 'App', slug: 'app' });
  const service = controlPlane.store.createService({ projectId: project.id, name: 'web' });
  const member = controlPlane.store.createUser({ email: 'member@example.test', role: 'USER', approvalStatus: 'APPROVED' });
  const outsider = controlPlane.store.createUser({ email: 'outsider@example.test', role: 'USER', approvalStatus: 'APPROVED' });
  controlPlane.store.addMember({ organizationId: organization.id, userId: member.id, role: 'viewer' });
  controlPlane.store.appendRuntimeLog({ serviceId: service.id, sourceInstanceId: 'private-service-runtime', line: 'PRIVATE_LOG' });
  const secret = 'runtime-resume-test-secret';
  const memberToken = signJwtHs256({ sub: member.id, role: 'viewer', organizationId: organization.id }, secret);
  const outsiderToken = signJwtHs256({ sub: outsider.id, role: 'viewer' }, secret);
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');

  try {
    const initial = await requestSse(server, `/services/${service.id}/logs/stream`, undefined, memberToken);
    const resumeToken = eventId(initial.body);
    const unauthenticated = await requestSse(server, `/services/${service.id}/logs/stream`, resumeToken);
    const forbidden = await requestSse(server, `/services/${service.id}/logs/stream`, resumeToken, outsiderToken);

    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(forbidden.statusCode, 403);
    assert.doesNotMatch(`${unauthenticated.body}${forbidden.body}`, /PRIVATE_LOG/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Given the runtime stream contract, When OpenAPI is generated, Then Last-Event-ID bounds and resume semantics agree', async () => {
  const artifact = YAML.parse(await readFile(new URL('../openapi/raibitserver.yaml', import.meta.url), 'utf8'));
  const generated = createOpenApiDocument();
  const path = '/services/{serviceId}/logs/stream';

  assert.deepEqual(artifact.paths[path].get, JSON.parse(JSON.stringify(generated.paths[path].get)));
  assert.equal(artifact.paths[path].get.parameters.find((parameter) => parameter.name === 'Last-Event-ID').schema.maxLength, 2048);
  assert.equal(artifact.paths[path].get['x-sse'].reconnect, 'strictly-after-accepted-cursor');
});

test('Given the Nest runtime stream, When reconnecting with its event ID, Then the HTTP route resumes without duplicates', async () => {
  const runtime = await bootParityApi();
  try {
    const user = runtime.repository.store.createUser({ email: 'nest-resume@example.test', passwordHash: hashPassword('test-password'), role: 'USER', approvalStatus: 'APPROVED' });
    const organization = runtime.repository.store.createOrganization({ name: 'Nest Resume', slug: 'nest-resume' });
    runtime.repository.store.addMember({ userId: user.id, organizationId: organization.id, role: 'viewer' });
    const project = runtime.repository.store.createProject({ organizationId: organization.id, name: 'App', slug: 'app' });
    const service = runtime.repository.store.createService({ projectId: project.id, name: 'web' });
    const timestamp = '2026-09-04T00:00:00.000Z';
    runtime.repository.store.runtimeLogs = [{ id: 'nest-a', serviceId: service.id, line: 'first', timestamp }];
    const login = await fetch(`${runtime.baseUrl}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password: 'test-password' }) }).then((response) => response.json());
    const headers = { authorization: `Bearer ${login.token}` };
    const firstResponse = await fetch(`${runtime.baseUrl}/services/${service.id}/logs/stream`, { headers });
    const first = await readFirstSseFrame(firstResponse);
    runtime.repository.store.runtimeLogs.push({ id: 'nest-b', serviceId: service.id, line: 'second', timestamp });
    const resumedResponse = await fetch(`${runtime.baseUrl}/services/${service.id}/logs/stream`, { headers: { ...headers, 'last-event-id': eventId(first) } });
    const resumed = await readFirstSseFrame(resumedResponse);

    assert.doesNotMatch(resumed, /nest-a/);
    assert.match(resumed, /nest-b/);
    const invalid = await fetch(`${runtime.baseUrl}/services/${service.id}/logs/stream`, { headers: { ...headers, 'last-event-id': 'malformed' } });
    assert.equal(invalid.status, 400);
  } finally {
    await runtime.app.close();
  }
});

function requestSse(server, path, lastEventId, authorization) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const request = http.request({
      port: address.port,
      path,
      headers: {
        ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
        ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

function eventId(body) {
  const match = body.match(/^id: (\S+)$/m);
  assert.ok(match);
  return match[1];
}

async function readFirstSseFrame(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!text.includes('data: ')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
