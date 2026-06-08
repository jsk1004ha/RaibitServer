import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneStore, WORKFLOW_STATUSES, WORKFLOW_TYPES, DEPLOYMENT_STATUSES, createWorkflowJobRecord, createDeploymentWorkflowHandlers, processNextWorkflowJob, reconcileDeploymentRollout } from '../packages/core/src/index.ts';

test('workflow processor claims one due job and prevents duplicate active claims', () => {
  const store = new ControlPlaneStore();
  const job = store.enqueueWorkflowJob({
    type: 'build-and-deploy',
    targetType: 'deployment',
    targetId: 'dep-1',
    payload: { serviceId: 'svc-1', token: 'secret-token' },
    runAfter: '2026-01-01T00:00:00.000Z',
  });

  const claimed = store.claimNextWorkflowJob({ workerId: 'worker-a', now: '2026-01-01T00:00:01.000Z' });
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, WORKFLOW_STATUSES.RUNNING);
  assert.equal(claimed.lockedBy, 'worker-a');
  assert.equal(claimed.attempts, 1);
  assert.equal(store.claimNextWorkflowJob({ workerId: 'worker-b', now: '2026-01-01T00:00:02.000Z' }), null);
  assert.equal(JSON.stringify(claimed).includes('secret-token'), false);
});

test('workflow processor retries failures with sanitized errors before final failure', () => {
  const store = new ControlPlaneStore();
  store.enqueueWorkflowJob({ targetId: 'dep-2', maxAttempts: 2, runAfter: '2026-01-01T00:00:00.000Z' });

  const first = store.claimNextWorkflowJob({ workerId: 'worker-a', now: '2026-01-01T00:00:01.000Z' });
  const retry = store.failWorkflowJob(first.id, 'DATABASE_URL=postgres://user:pass@db/app failed', { workerId: 'worker-a', now: '2026-01-01T00:00:01.000Z', retryDelayMs: 0 });
  assert.equal(retry.status, WORKFLOW_STATUSES.QUEUED);
  assert.match(retry.payload.lastError, /DATABASE_URL=\*\*\*\*/);
  assert.equal(retry.payload.lastError.includes('user:pass'), false);

  const second = store.claimNextWorkflowJob({ workerId: 'worker-a', now: '2026-01-01T00:00:02.000Z' });
  const failed = store.failWorkflowJob(second.id, 'TOKEN=abc123 failed', { workerId: 'worker-a', now: '2026-01-01T00:00:02.000Z' });
  assert.equal(failed.status, WORKFLOW_STATUSES.FAILED);
  assert.match(failed.payload.lastError, /TOKEN=\*\*\*\*/);
  assert.equal(failed.payload.lastErrorSpec.code, 'UNKNOWN_INFRA_ERROR');
  assert.equal(failed.payload.lastErrorSpec.message.includes('abc123'), false);
});

test('workflow processor completes jobs with masked result metadata', async () => {
  const store = new ControlPlaneStore();
  store.enqueueWorkflowJob({ targetId: 'dep-3', runAfter: '2026-01-01T00:00:00.000Z' });
  const result = await processNextWorkflowJob(store, {
    'build-and-deploy': async () => ({ image: 'demo:latest', registryToken: 'raw-token' }),
  }, { workerId: 'worker-a', now: '2026-01-01T00:00:01.000Z' });

  assert.equal(result.ok, true);
  assert.equal(result.job.status, WORKFLOW_STATUSES.SUCCEEDED);
  assert.equal(result.job.lockedBy, null);
  assert.equal(JSON.stringify(result).includes('raw-token'), false);
  assert.equal(store.snapshot().workflowJobs[0].payload.lastResult.registryToken, 'ra****en');
});

test('workflow job records mask secret payloads at creation', () => {
  const job = createWorkflowJobRecord({ targetId: 'dep-4', payload: { nested: { apiKey: 'super-secret-api-key' }, plain: 'ok' } });
  assert.equal(job.payload.plain, 'ok');
  assert.equal(job.payload.nested.apiKey, 'su****ey');
});

test('quota checks count existing usage before allowing new side effects', () => {
  const store = new ControlPlaneStore();
  const user = store.createUser({ name: 'User', email: 'user@example.com', approvalStatus: 'APPROVED' });
  const org = store.createOrganization({ name: 'Quota Org', slug: 'quota-org' });
  store.addMember({ organizationId: org.id, userId: user.id, role: 'owner' });
  store.setQuota({ userId: user.id, maxProjects: 1 });
  store.createProject({ organizationId: org.id, name: 'First', slug: 'first' });

  assert.throws(() => store.enforceUserCan({ userId: user.id, action: 'project:create', metric: 'maxProjects', increment: 1 }), /quota exceeded: maxProjects \(2\/1\)/);
  assert.equal(store.snapshot().projects.length, 1);
});


test('deployment builder workflow stores image digest, logs, events, and rollout status', async () => {
  const store = new ControlPlaneStore();
  const org = store.createOrganization({ name: 'Builder Org', slug: 'builder-org' });
  const project = store.createProject({ organizationId: org.id, name: 'Demo', slug: 'demo' });
  const service = store.createService({
    projectId: project.id,
    name: 'web',
    type: 'web',
    sourceType: 'local',
    buildMode: 'dockerfile',
    dockerfilePath: 'Dockerfile',
    registry: 'registry.local',
    revision: 'abc123',
    port: 3000,
  });
  const deployment = store.createDeployment({ serviceId: service.id, commitSha: 'abc123' });
  store.enqueueWorkflowJob({
    type: WORKFLOW_TYPES.BUILD_AND_DEPLOY,
    targetType: 'deployment',
    targetId: deployment.id,
    payload: { deploymentId: deployment.id, serviceId: service.id, projectId: project.id, commitSha: 'abc123' },
    maxAttempts: 1,
    runAfter: '2026-01-01T00:00:00.000Z',
  });

  const buildResult = await store.processNextWorkflowJob(createDeploymentWorkflowHandlers(store, {
    dryRun: true,
    filesByService: { [service.id]: { Dockerfile: 'FROM node:24-alpine\nCMD ["node", "server.js"]\n' } },
  }), { workerId: 'builder-1', now: '2026-01-01T00:00:01.000Z' });

  assert.equal(buildResult.ok, true);
  const imageReady = store.snapshot().deployments.find((row) => row.id === deployment.id);
  assert.equal(imageReady.status, DEPLOYMENT_STATUSES.IMAGE_READY);
  assert.match(imageReady.imageUrl, /^registry\.local\/demo\/web:/);
  assert.match(imageReady.imageDigest, /^sha256:/);
  assert.equal(store.snapshot().services.find((row) => row.id === service.id).status, 'image-ready');
  assert.equal(store.snapshot().workflowJobs[0].status, WORKFLOW_STATUSES.SUCCEEDED);
  assert.equal(store.listDeploymentLogs(deployment.id).some((row) => /docker buildx build/.test(row.line)), true);
  assert.equal(store.listDeploymentEvents(deployment.id).some((row) => row.type === 'build.image_ready'), true);

  const rollout = await reconcileDeploymentRollout(store, deployment.id, { dryRun: true, host: 'builder-org-demo.apps.local' });
  assert.equal(rollout.status, DEPLOYMENT_STATUSES.READY);
  const ready = store.snapshot().deployments.find((row) => row.id === deployment.id);
  assert.equal(ready.status, DEPLOYMENT_STATUSES.READY);
  assert.equal(store.listRuntimeLogs(service.id).some((row) => /HTTP 200/.test(row.line)), true);
  assert.equal(store.listDeploymentEvents(deployment.id).some((row) => row.type === 'rollout.ready'), true);
});

test('deployment builder workflow records sanitized BUILD_FAILED status', async () => {
  const store = new ControlPlaneStore();
  const org = store.createOrganization({ name: 'Fail Org', slug: 'fail-org' });
  const project = store.createProject({ organizationId: org.id, name: 'Demo', slug: 'demo' });
  const service = store.createService({ projectId: project.id, name: 'api', sourceType: 'local', buildMode: 'auto', registry: 'registry.local' });
  const deployment = store.createDeployment({ serviceId: service.id, commitSha: 'broken' });
  store.enqueueWorkflowJob({ type: WORKFLOW_TYPES.BUILD_AND_DEPLOY, targetType: 'deployment', targetId: deployment.id, payload: { deploymentId: deployment.id, serviceId: service.id, projectId: project.id }, maxAttempts: 1, runAfter: '2026-01-01T00:00:00.000Z' });

  const result = await store.processNextWorkflowJob(createDeploymentWorkflowHandlers(store, {
    dryRun: true,
    failBuild: new Error('TOKEN=super-secret-value docker build failed'),
  }), { workerId: 'builder-1', now: '2026-01-01T00:00:01.000Z' });

  assert.equal(result.ok, false);
  const failed = store.snapshot().deployments.find((row) => row.id === deployment.id);
  assert.equal(failed.status, DEPLOYMENT_STATUSES.BUILD_FAILED);
  assert.equal(failed.errorCode, 'BUILD_FAILED');
  assert.match(failed.errorMessage, /TOKEN=\*\*\*\*/);
  assert.equal(failed.errorMessage.includes('super-secret-value'), false);
  assert.equal(store.snapshot().workflowJobs[0].status, WORKFLOW_STATUSES.FAILED);
  const buildFailedEvent = store.listDeploymentEvents(deployment.id).find((row) => row.type === 'build.failed');
  assert.ok(buildFailedEvent);
  assert.equal(buildFailedEvent.metadata.errorSpec.code, 'BUILD_FAILED');
});

test('rollout reconciler records sanitized FAILED status', async () => {
  const store = new ControlPlaneStore();
  const org = store.createOrganization({ name: 'Rollout Org', slug: 'rollout-org' });
  const project = store.createProject({ organizationId: org.id, name: 'Demo', slug: 'demo' });
  const service = store.createService({ projectId: project.id, name: 'web', sourceType: 'image', image: 'registry.local/demo/web:abc' });
  const deployment = store.createDeployment({ serviceId: service.id, imageUrl: 'registry.local/demo/web:abc', imageDigest: 'sha256:abc', status: DEPLOYMENT_STATUSES.IMAGE_READY });

  await assert.rejects(
    () => reconcileDeploymentRollout(store, deployment.id, { dryRun: true, failRollout: new Error('DATABASE_URL=postgres://user:pass@db/app rollout failed') }),
    /DATABASE_URL=postgres:\/\/user:pass@db\/app rollout failed/,
  );

  const failed = store.snapshot().deployments.find((row) => row.id === deployment.id);
  assert.equal(failed.status, DEPLOYMENT_STATUSES.FAILED);
  assert.equal(failed.errorCode, 'ROLLOUT_FAILED');
  assert.match(failed.errorMessage, /DATABASE_URL=\*\*\*\*/);
  assert.equal(failed.errorMessage.includes('user:pass'), false);
  const rolloutFailedEvent = store.listDeploymentEvents(deployment.id).find((row) => row.type === 'rollout.failed');
  assert.ok(rolloutFailedEvent);
  assert.equal(rolloutFailedEvent.metadata.errorSpec.code, 'ROLLOUT_FAILED');
});

test('project service API accepts beta service types before deployment queueing', () => {
  const store = new ControlPlaneStore();
  const org = store.createOrganization({ name: 'Types Org', slug: 'types-org' });
  const project = store.createProject({ organizationId: org.id, name: 'Multi', slug: 'multi' });
  for (const type of ['web', 'private', 'worker', 'cron', 'job']) {
    const service = store.createService({ projectId: project.id, name: `${type}-svc`, type, sourceType: 'image', image: `registry.local/multi/${type}:latest` });
    const deployment = store.createDeployment({ serviceId: service.id, imageUrl: service.image });
    assert.equal(service.type, type);
    assert.equal(deployment.projectId, project.id);
    assert.equal(deployment.status, DEPLOYMENT_STATUSES.QUEUED);
  }
  assert.equal(store.snapshot().services.length, 5);
  assert.equal(store.snapshot().deployments.length, 5);
});
