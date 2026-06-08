import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { organizationScopeFromProjectInput } from '../packages/core/src/scope.ts';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { signJwtHs256 } from '../packages/core/src/auth.ts';

test('project create derives scope from nested organization before persistence', async () => {
  assert.equal(organizationScopeFromProjectInput({ organization: { slug: 'org-b' } }, { organizationId: 'org-a' }), 'org-b');

  const secret = 'scope-secret';
  const server = http.createServer(createApiHandler(new RAIBITSERVERControlPlane(), { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const scopedToken = signJwtHs256({ sub: 'admin-1', role: 'admin', organizationId: 'org-a' }, secret);
    const denied = await request(port, 'POST', '/projects', { organization: { slug: 'org-b' }, name: 'demo', slug: 'demo' }, scopedToken);
    assert.equal(denied.statusCode, 403);

    const created = await request(port, 'POST', '/projects', { organizationId: 'org-a', name: 'demo', slug: 'demo' }, scopedToken);
    assert.equal(created.statusCode, 201);
  } finally {
    server.close();
  }
});

test('nested organization project creation requires project:create, not project:update', async () => {
  const secret = 'nested-project-create-rbac-secret';
  const server = http.createServer(createApiHandler(new RAIBITSERVERControlPlane(), { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const maintainerToken = signJwtHs256({ sub: 'maintainer-1', role: 'maintainer', organizationId: 'org-victim' }, secret);
    const denied = await request(port, 'POST', '/organizations/org-victim/projects', { name: 'nested-created', slug: 'nested-created' }, maintainerToken);
    assert.equal(denied.statusCode, 403);
    assert.match(denied.body.error, /project:create/);

    const ownerToken = signJwtHs256({ sub: 'owner-1', role: 'owner', organizationId: 'org-victim' }, secret);
    const created = await request(port, 'POST', '/organizations/org-victim/projects', { name: 'nested-created', slug: 'nested-created' }, ownerToken);
    assert.equal(created.statusCode, 201);
  } finally {
    server.close();
  }
});

function request(port, method, requestPath, body, token = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {};
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ port, path: requestPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
