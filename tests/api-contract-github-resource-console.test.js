import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { signJwtHs256 } from '../packages/core/src/auth.ts';

const auth = { mode: 'disabled', allowDisabled: true, defaultRole: 'owner' };

test('resource console OpenAPI endpoints are implemented by prototype handler', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const org = controlPlane.store.createOrganization({ name: 'Console Org', slug: 'console-org' });
  const project = controlPlane.store.createProject({ organizationId: org.id, name: 'Console Project', slug: 'console-project' });
  const redis = controlPlane.store.createResource({ projectId: project.id, name: 'cache', type: 'cache', engine: 'redis', desiredSpec: { keys: ['session:1', 'queue:jobs'] } });
  const pg = controlPlane.store.createResource({ projectId: project.id, name: 'pg', engine: 'postgresql' });
  const server = await serve(controlPlane);
  try {
    const schema = await request(server.port, 'GET', `/resources/${redis.id}/console/schema`);
    assert.equal(schema.statusCode, 200);
    assert.deepEqual(schema.body.schema.keys, ['session:1', 'queue:jobs']);

    const keys = await request(server.port, 'GET', `/resources/${redis.id}/console/keys`);
    assert.equal(keys.statusCode, 200);
    assert.deepEqual(keys.body.keys, ['session:1', 'queue:jobs']);

    const command = await request(server.port, 'POST', `/resources/${redis.id}/console/command`, { command: 'GET session:1' });
    assert.equal(command.statusCode, 200);
    assert.equal(command.body.guard.providerCommand, true);
    assert.match(command.body.command, /SCAN/);

    const tables = await request(server.port, 'GET', `/resources/${pg.id}/console/tables`);
    assert.equal(tables.statusCode, 200);
    assert.deepEqual(tables.body.tables, []);
    assert.match(tables.body.warning, /PostgreSQL browser requires/);
  } finally {
    server.close();
  }
});

test('GitHub App contract endpoints import/list/sync and webhook push/PR flows', async () => {
  const previousSecret = process.env.RAIBITSERVER_GITHUB_WEBHOOK_SECRET;
  process.env.RAIBITSERVER_GITHUB_WEBHOOK_SECRET = 'fixture-webhook-secret';
  const controlPlane = new RAIBITSERVERControlPlane();
  const org = controlPlane.store.createOrganization({ name: 'GitHub Org', slug: 'github-org' });
  const project = controlPlane.store.createProject({ organizationId: org.id, name: 'GitHub Project', slug: 'github-project' });
  const integration = controlPlane.store.createGitHubIntegration({ organizationId: org.id, accountLogin: 'alice', installationId: 'inst_1', token: 'ghp_fixture_secret' });
  const service = controlPlane.store.createService({ projectId: project.id, name: 'web', sourceType: 'github', repoUrl: 'https://github.com/alice/web.git', githubRepository: 'alice/web', githubIntegrationId: integration.id, branch: 'main' });
  const server = await serve(controlPlane);
  try {
    const installations = await request(server.port, 'GET', `/github/installations?organizationId=${org.id}`);
    assert.equal(installations.statusCode, 200);
    assert.equal(installations.body.installations[0].installationId, 'inst_1');

    const repositories = await request(server.port, 'GET', '/github/installations/inst_1/repositories');
    assert.equal(repositories.statusCode, 200);
    assert.equal(repositories.body.repositories[0].fullName, 'alice/web');

    const imported = await request(server.port, 'POST', '/github/repositories/import', { projectId: project.id, integrationId: integration.id, repository: 'alice/worker', serviceName: 'worker' });
    assert.equal(imported.statusCode, 201);
    assert.equal(imported.body.github.repository, 'alice/worker');

    const sync = await request(server.port, 'POST', '/github/repositories/alice%2Fweb/sync', {});
    assert.equal(sync.statusCode, 202);
    assert.equal(sync.body.workflowJob.type, 'github-repository-sync');

    const push = await webhook(server.port, 'push', 'delivery-push-1', { repository: { full_name: 'alice/web' }, ref: 'refs/heads/main', after: 'abc123' });
    assert.equal(push.statusCode, 202);
    assert.equal(push.body.actions[0].type, 'production-deployment-enqueued');
    assert.equal(controlPlane.store.workflowJobs.some((job) => job.type === 'build-and-deploy'), true);

    const duplicate = await webhook(server.port, 'push', 'delivery-push-1', { repository: { full_name: 'alice/web' }, ref: 'refs/heads/main', after: 'abc123' });
    assert.equal(duplicate.statusCode, 202);
    assert.equal(duplicate.body.duplicate, true);

    const bad = await webhook(server.port, 'push', 'delivery-bad-1', { repository: { full_name: 'alice/web' }, ref: 'refs/heads/main', after: 'bad' }, 'wrong-secret');
    assert.equal(bad.statusCode, 401);

    for (const [action, delivery, sha] of [['opened', 'delivery-pr-opened', 'def456'], ['synchronize', 'delivery-pr-sync', 'fed654'], ['reopened', 'delivery-pr-reopened', 'abc789']]) {
      const pr = await webhook(server.port, 'pull_request', delivery, prPayload(action, sha));
      assert.equal(pr.statusCode, 202);
      assert.equal(pr.body.actions[0].type, 'preview-deployment-enqueued');
      assert.match(pr.body.actions[0].previewUrl, /^https:\/\/pr-7-github-org-github-project\.preview\.raibitserver\.app$/);
      assert.equal(pr.body.actions[0].previewWorkloadName, 'pr-7-web');
      assert.equal(pr.body.outbound.commitStatus.targetUrl, pr.body.actions[0].previewUrl);
      assert.equal(pr.body.outbound.pullRequestComment.pullRequestNumber, 7);
      const job = controlPlane.store.workflowJobs.find((item) => item.id === pr.body.actions[0].workflowJobId);
      assert.equal(job.payload.kubernetes.workloadName, 'pr-7-web');
      assert.equal(job.payload.kubernetes.labels['raibitserver.io/preview'], 'true');
    }

    const closed = await webhook(server.port, 'pull_request', 'delivery-pr-closed', prPayload('closed', 'def456'));
    assert.equal(closed.statusCode, 202);
    assert.equal(closed.body.actions[0].type, 'preview-cleanup-enqueued');
    assert.equal(controlPlane.store.workflowJobs.some((job) => job.type === 'preview-cleanup'), true);
    assert.equal([...controlPlane.store.deployments.values()].some((deployment) => deployment.status === 'PREVIEW_CLEANUP_REQUESTED'), true);
    const cleanupJob = controlPlane.store.workflowJobs.find((job) => job.type === 'preview-cleanup');
    assert.equal(cleanupJob.payload.kubernetes.workloadName, 'pr-7-web');
    assert.match(JSON.stringify(controlPlane.store.deploymentEvents), /preview\.cleanup\.requested/);
    assert.equal(service.id, controlPlane.store.servicesForGitHubRepository('alice/web')[0].id);
  } finally {
    server.close();
    if (previousSecret === undefined) delete process.env.RAIBITSERVER_GITHUB_WEBHOOK_SECRET;
    else process.env.RAIBITSERVER_GITHUB_WEBHOOK_SECRET = previousSecret;
  }
});

test('GitHub installation repositories and sync are scoped to the caller organization', async () => {
  const jwtSecret = 'github-scope-secret-at-least-32-chars';
  const controlPlane = new RAIBITSERVERControlPlane();
  const orgA = controlPlane.store.createOrganization({ name: 'Org A', slug: 'org-a' });
  const orgB = controlPlane.store.createOrganization({ name: 'Org B', slug: 'org-b' });
  const projectA = controlPlane.store.createProject({ organizationId: orgA.id, name: 'Project A', slug: 'project-a' });
  const projectB = controlPlane.store.createProject({ organizationId: orgB.id, name: 'Project B', slug: 'project-b' });
  const integrationA = controlPlane.store.createGitHubIntegration({ organizationId: orgA.id, accountLogin: 'alice', installationId: 'inst_a' });
  const integrationB = controlPlane.store.createGitHubIntegration({ organizationId: orgB.id, accountLogin: 'bob', installationId: 'inst_b' });
  const serviceA = controlPlane.store.createService({ projectId: projectA.id, name: 'web-a', sourceType: 'github', repoUrl: 'https://github.com/alice/web.git', githubRepository: 'alice/web', githubIntegrationId: integrationA.id });
  controlPlane.store.createService({ projectId: projectB.id, name: 'web-b', sourceType: 'github', repoUrl: 'https://github.com/bob/secret.git', githubRepository: 'bob/secret', githubIntegrationId: integrationB.id });
  assert.throws(() => controlPlane.store.importGitHubRepository({ projectId: projectA.id, integrationId: integrationB.id, repository: 'bob/secret' }), /does not belong/);
  assert.throws(() => controlPlane.store.attachGitHubRepositoryToService({ projectId: projectA.id, serviceId: serviceA.id, integrationId: integrationB.id, repoUrl: 'https://github.com/bob/secret.git' }), /does not belong/);
  const server = await serve(controlPlane, { mode: 'jwt', jwtSecret, issuer: 'raibitserver' });
  const tokenA = signJwtHs256({ sub: 'user-a', role: 'developer', organizationId: orgA.id }, jwtSecret, { issuer: 'raibitserver' });
  try {
    const own = await request(server.port, 'GET', '/github/installations/inst_a/repositories', null, tokenA);
    assert.equal(own.statusCode, 200);
    assert.equal(own.body.repositories[0].fullName, 'alice/web');

    const cross = await request(server.port, 'GET', '/github/installations/inst_b/repositories', null, tokenA);
    assert.equal(cross.statusCode, 200);
    assert.deepEqual(cross.body.repositories, []);

    const crossSync = await request(server.port, 'POST', '/github/repositories/bob%2Fsecret/sync', {}, tokenA);
    assert.equal(crossSync.statusCode, 202);
    assert.deepEqual(crossSync.body.services, []);
  } finally {
    server.close();
  }
});

test('GitHub webhook rejects requests when webhook secret is not configured', async () => {
  const previousSecret = process.env.RAIBITSERVER_GITHUB_WEBHOOK_SECRET;
  const previousFallback = process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.RAIBITSERVER_GITHUB_WEBHOOK_SECRET;
  delete process.env.GITHUB_WEBHOOK_SECRET;
  const controlPlane = new RAIBITSERVERControlPlane();
  const server = await serve(controlPlane);
  try {
    const res = await request(server.port, 'POST', '/github/webhooks', JSON.stringify({ repository: { full_name: 'alice/web' }, ref: 'refs/heads/main', after: 'abc123' }), null, {
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-no-secret',
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'GitHub webhook secret is not configured');
  } finally {
    server.close();
    if (previousSecret === undefined) delete process.env.RAIBITSERVER_GITHUB_WEBHOOK_SECRET;
    else process.env.RAIBITSERVER_GITHUB_WEBHOOK_SECRET = previousSecret;
    if (previousFallback === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = previousFallback;
  }
});

function prPayload(action, sha) {
  return {
    action,
    number: 7,
    repository: { full_name: 'alice/web' },
    pull_request: { number: 7, head: { ref: 'feature/demo', sha } },
  };
}

async function webhook(port, event, delivery, payload, secret = 'fixture-webhook-secret') {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return request(port, 'POST', '/github/webhooks', raw, null, {
    'x-github-event': event,
    'x-github-delivery': delivery,
    'x-hub-signature-256': signature,
  });
}

function serve(controlPlane, authOptions = auth) {
  const server = http.createServer(createApiHandler(controlPlane, { auth: authOptions }));
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => ({ port: server.address().port, close: () => server.close() }));
}

function request(port, method, requestPath, body = null, token = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : body ? JSON.stringify(body) : null;
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...extraHeaders } : { ...extraHeaders };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
