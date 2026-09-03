import http from 'node:http';
import { once } from 'node:events';
import { createApiHandler } from '../../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../../packages/core/src/control-plane.ts';
import { InMemoryControlPlaneRepository } from '../../packages/core/src/persistence.ts';
import { createSessionToken } from '../../packages/core/src/identity.ts';
import { bootParityApi } from './api-parity-runtime.mjs';

export async function bootLineageApi(t, transport) {
  const jwtSecret = 'local-semantic-parity-test-secret-only';
  let repository;
  let baseUrl;
  if (transport === 'nest') {
    const runtime = await bootParityApi();
    repository = runtime.repository;
    baseUrl = runtime.baseUrl;
    t.after(() => runtime.app.close());
  } else {
    const controlPlane = new RAIBITSERVERControlPlane();
    repository = new InMemoryControlPlaneRepository(controlPlane.store);
    const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret, issuer: 'raibitserver' } }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  }
  const organization = await repository.createOrganization({ name: 'HTTP lineage', slug: 'http-lineage' });
  const user = await repository.createUser({ email: 'lineage@example.test', name: 'Lineage', approvalStatus: 'APPROVED' });
  const membership = await repository.addMember({ userId: user.id, organizationId: organization.id, role: 'OWNER' });
  const outsider = await repository.createUser({ email: 'outside@example.test', name: 'Outside', approvalStatus: 'APPROVED' });
  const reader = await repository.createUser({ email: 'reader@example.test', name: 'Reader', approvalStatus: 'APPROVED' });
  const readerMembership = await repository.addMember({ userId: reader.id, organizationId: organization.id, role: 'VIEWER' });
  const project = await repository.createProject({ organizationId: organization.id, name: 'App', slug: 'app' });
  const service = await repository.createService({ projectId: project.id, name: 'Web', type: 'web', image: 'example/app:v1', port: 3000 });
  const token = createSessionToken(user, [membership], jwtSecret);
  const outsideToken = createSessionToken(outsider, [], jwtSecret);
  const readerToken = createSessionToken(reader, [readerMembership], jwtSecret);
  async function post(path, body, authorization = token) {
    const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${authorization}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  }
  return { repository, service, project, user, baseUrl, token, outsideToken, readerToken, post };
}
