import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';

test('beta project/service/deployment contract queues supported services and exposes log/event evidence', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'disabled', allowDisabled: true, defaultRole: 'owner' } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const org = await request(port, 'POST', '/organizations', { name: 'Beta Org', slug: 'beta-org' });
    assert.equal(org.statusCode, 201, JSON.stringify(org.body));
    const project = await request(port, 'POST', `/organizations/${org.body.id}/projects`, { name: 'Beta Project', slug: 'beta-project' });
    assert.equal(project.statusCode, 201, JSON.stringify(project.body));

    const serviceTypes = ['web', 'private', 'worker', 'cron', 'job'];
    for (const type of serviceTypes) {
      const created = await request(port, 'POST', `/projects/${project.body.id}/services`, {
        name: `${type}-service`,
        type,
        sourceType: 'image',
        image: `localhost:5000/beta/${type}:latest`,
      });
      assert.equal(created.statusCode, 201, `${type} service create failed: ${JSON.stringify(created.body)}`);
      assert.equal(created.body.type, type);
      assert.equal(created.body.projectId, project.body.id);
    }

    const dockerfile = await createService(port, project.body.id, {
      name: 'dockerfile-app',
      type: 'web',
      sourceType: 'github',
      buildMode: 'dockerfile',
      repoUrl: 'https://github.com/example/dockerfile-app.git',
      branch: 'release',
      dockerfilePath: 'Dockerfile',
    });
    const generated = await createService(port, project.body.id, {
      name: 'generated-app',
      type: 'worker',
      sourceType: 'local',
      buildMode: 'auto',
      localPath: '/workspace/generated-app',
      buildCommand: 'npm run build',
      startCommand: 'node server.js',
    });
    const prebuilt = await createService(port, project.body.id, {
      name: 'prebuilt-app',
      type: 'job',
      sourceType: 'image',
      image: 'localhost:5000/beta/prebuilt:latest',
    });

    const queuedDeployments = await Promise.all([
      queueDeployment(port, project.body.id, dockerfile.id, { commitSha: 'dockerfile-sha' }),
      queueDeployment(port, project.body.id, generated.id, { commitSha: 'generated-sha' }),
      queueDeployment(port, project.body.id, prebuilt.id, {
        imageUrl: 'localhost:5000/beta/prebuilt:latest',
        imageDigest: 'sha256:abc123',
      }),
    ]);

    for (const deployment of queuedDeployments) {
      assert.equal(deployment.status, 'queued');
      assert.equal(deployment.workflowJob.status, 'queued');
      assert.equal(deployment.workflowJob.type, 'build-and-deploy');
      assert.equal(deployment.workflowJob.targetType, 'deployment');
      assert.equal(deployment.workflowJob.targetId, deployment.id);
      assert.equal(deployment.workflowJob.payload.deploymentId, deployment.id);
      assert.equal(deployment.workflowJob.payload.projectId, project.body.id);
    }
    assert.equal(queuedDeployments[0].branch, 'release');
    assert.equal(queuedDeployments[0].workflowJob.payload.branch, 'release');

    const deployment = queuedDeployments[0];
    controlPlane.store.appendBuildLog({ deploymentId: deployment.id, step: 'clone', line: 'git clone completed' });
    controlPlane.store.appendBuildLog({ deploymentId: deployment.id, step: 'build', line: 'docker buildx build --push completed' });
    controlPlane.store.appendRuntimeLog({ serviceId: dockerfile.id, deploymentId: deployment.id, podName: 'beta-pod', containerName: 'app', line: 'GET /health 200' });
    controlPlane.store.appendDeploymentEvent({ deploymentId: deployment.id, type: 'rollout.ready', message: 'Kubernetes rollout ready' });

    const logs = await request(port, 'GET', `/deployments/${deployment.id}/logs`);
    const events = await request(port, 'GET', `/deployments/${deployment.id}/events`);
    const runtimeLogs = await request(port, 'GET', `/services/${dockerfile.id}/logs`);
    assert.equal(logs.statusCode, 200);
    assert.equal(events.statusCode, 200);
    assert.equal(runtimeLogs.statusCode, 200);
    assert.deepEqual(logs.body.logs.map((row) => row.step), ['clone', 'build']);
    assert.equal(events.body.events.some((row) => row.type === 'rollout.ready'), true);
    assert.equal(runtimeLogs.body.logs.some((row) => row.line === 'GET /health 200'), true);
  } finally {
    server.close();
  }
});

async function createService(port, projectId, input) {
  const response = await request(port, 'POST', `/projects/${projectId}/services`, input);
  assert.equal(response.statusCode, 201, `service create failed: ${JSON.stringify(response.body)}`);
  return response.body;
}

async function queueDeployment(port, projectId, serviceId, input = {}) {
  const response = await request(port, 'POST', `/projects/${projectId}/services/${serviceId}/deployments`, {
    deploymentType: 'production',
    ...input,
  });
  assert.equal(response.statusCode, 202, `deployment queue failed: ${JSON.stringify(response.body)}`);
  return response.body;
}

function request(port, method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {};
    const req = http.request({ port, host: '127.0.0.1', path: requestPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ statusCode: res.statusCode, body: raw ? JSON.parse(raw) : null });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
