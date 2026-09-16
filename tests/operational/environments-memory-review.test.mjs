import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { ControlPlaneStore } from '../../packages/core/src/store.ts';
import { InMemoryControlPlaneRepository } from '../../packages/core/src/persistence.ts';
import { EnvironmentError, parseEnvironmentSelector } from '../../packages/core/src/environments.ts';

function fixture() {
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Memory', slug: 'memory' });
  const project = store.createProject({ organizationId: organization.id, name: 'App', slug: 'app' });
  const prod = store.resolveEnvironment(project.id);
  const dev = store.createEnvironment({ projectId: project.id, kind: 'dev', expectedVersion: 0 });
  const service = store.createService({ projectId: project.id, environmentId: dev.id, name: 'web', sourceType: 'image', image: `example/web@sha256:${'a'.repeat(64)}` });
  return { store, organization, project, prod, dev, service };
}

test('F2 successive dev commits and repeated sources retain distinct deployments and jobs', () => {
  // Given a real dev service with the full 62-character ID.
  const { store, service } = fixture();
  assert.equal(service.id.length, 62);
  // When separate admissions include two distinct commits and a repeated commit.
  const deployments = ['a', 'b', 'b'].map((sha) => store.createDeployment({ serviceId: service.id, commitSha: sha.repeat(40) }));
  const jobs = deployments.map((deployment) => store.enqueueWorkflowJob({ type: 'build-and-deploy', targetType: 'deployment', targetId: deployment.id, createdAt: '2026-09-13T00:00:00.000Z' }));
  // Then neither truncation nor same-source admission overwrites a row.
  assert.equal(new Set(deployments.map((row) => row.id)).size, 3);
  assert.equal(new Set(jobs.map((row) => row.id)).size, 3);
  assert.equal(store.snapshot().deployments.length, 3);
  assert.deepEqual(store.snapshot().deployments.map((row) => row.commitSha), ['a', 'b', 'b'].map((sha) => sha.repeat(40)));
  assert.ok([...deployments, ...jobs].every((row) => /^[a-z0-9-]{1,63}$/.test(row.id)));
});

test('F2 dev queue admissions on one target preserve cardinality at the same timestamp', () => {
  // Given one dev deployment.
  const { store, service } = fixture();
  const deployment = store.createDeployment({ serviceId: service.id, commitSha: 'a'.repeat(40) });
  // When two independent workflow admissions have the same target and timestamp.
  const jobs = [0, 1].map(() => store.enqueueWorkflowJob({ type: 'build-and-deploy', targetType: 'deployment', targetId: deployment.id, createdAt: '2026-09-13T00:00:00.000Z' }));
  // Then the second admission does not alias the first job.
  assert.notEqual(jobs[0].id, jobs[1].id);
  assert.equal(store.snapshot().workflowJobs.length, 2);
});

test('F2 retry creates a new job and idempotent replay returns that same successor', async () => {
  // Given a failed image deployment and its completed failed job.
  const { store, service } = fixture();
  const repository = new InMemoryControlPlaneRepository(store);
  const source = store.createDeployment({ serviceId: service.id, imageUrl: `example/web@sha256:${'a'.repeat(64)}`, status: 'FAILED' });
  const oldJob = store.enqueueWorkflowJob({ type: 'build-and-deploy', targetType: 'deployment', targetId: source.id, status: 'failed' });
  const input = { operation: 'retry', serviceId: service.id, sourceDeploymentId: source.id, requestedByUserId: 'system', requestIdempotencyKey: 'retry-1', snapshotVersion: 1 };
  // When a retry request is replayed through the real repository operation.
  const first = await repository.createDeploymentOperation(input);
  const replay = await repository.createDeploymentOperation(input);
  // Then it keeps the original and exactly one distinct successor and job.
  assert.notEqual(first.deployment.id, source.id);
  assert.notEqual(first.workflowJob.id, oldJob.id);
  assert.equal(replay.deployment.id, first.deployment.id);
  assert.equal(replay.workflowJob.id, first.workflowJob.id);
  assert.deepEqual(first.deployment.desiredSpecSnapshot, source.desiredSpecSnapshot);
  assert.equal(store.snapshot().deployments.length, 2);
  assert.equal(store.snapshot().workflowJobs.length, 2);
});

test('production service deployment and workflow IDs retain their exact legacy values', () => {
  // Given an ordinary production service.
  const { store, project } = fixture();
  const service = store.createService({ projectId: project.id, name: 'api', sourceType: 'image', image: 'example/api:v1' });
  // When its first deployment and workflow are admitted.
  const deployment = store.createDeployment({ serviceId: service.id, commitSha: 'abc' });
  const job = store.enqueueWorkflowJob({ type: 'build-and-deploy', targetType: 'deployment', targetId: deployment.id, createdAt: '2026-09-13T00:00:00.000Z' });
  // Then IDs are byte-identical to legacy constructors.
  assert.equal(service.id, 'svc-prj-org-memory-app-api');
  assert.equal(deployment.id, 'dep-svc-prj-org-memory-app-api-abc');
  assert.equal(job.id, 'job-build-and-deploy-deployment-dep-svc-prj-org-memory-app-api-');
});

function githubFixture() {
  const state = fixture();
  const { store, organization, project, dev } = state;
  const integration = store.connectVerifiedGitHubInstallation({ organizationId: organization.id, userId: 'system', installationId: '78001', accountLogin: 'memory' });
  store.replaceGitHubInstallationRepositories({ installationId: '78001', repositories: [{ githubRepoId: '78002', fullName: 'memory/dual', defaultBranch: 'main', private: false }] });
  const source = { projectId: project.id, integrationId: integration.id, repositoryId: '78002', serviceName: 'github', serviceSlug: 'github' };
  const prodService = store.importGitHubRepository({ ...source, branch: 'main', idempotencyKey: 'prod' }).service;
  const devService = store.importGitHubRepository({ ...source, branch: 'develop', environmentId: dev.id, idempotencyKey: 'dev' }).service;
  return { ...state, integration, source, prodService, devService };
}

test('F3 GitHub import preserves authoritative dev physical slug and logical public slug', () => {
  // Given identical logical slugs imported in both environments.
  const { store, project, dev, prodService, devService } = githubFixture();
  // When runtime and public environment projections are read.
  const runtime = store.runtimeEnvironmentProjection(project.id, { environmentId: dev.id });
  const logical = store.listServicesForEnvironment(project.id, dev.id).find((row) => row.id === devService.id);
  // Then runtime identity uses the D1 hash while the public name stays logical.
  const digest = crypto.createHash('sha256').update(`${dev.id}:github`).digest('hex').slice(0, 10);
  assert.equal(runtime.services.find((row) => row.serviceId === devService.id).physicalSlug, `dev-${digest}-github`);
  assert.equal(store.getService(prodService.id).slug, 'github');
  assert.equal(logical.slug, 'github');
});

test('dev GitHub sync binds its selected environment and protocol and preserves idempotent replay', () => {
  // Given one selected dev repository service.
  const { store, dev, project, devService } = githubFixture();
  const input = { repository: 'memory/dual', serviceIds: [devService.id], idempotencyKey: 'sync-dev' };
  // When the sync request and exact replay are admitted.
  const result = store.syncGitHubRepository(input);
  const replay = store.syncGitHubRepository(input);
  // Then the job records its authoritative scope exactly once.
  assert.equal(result.workflowJob.environmentId, dev.id);
  assert.equal(result.workflowJob.operationalProtocolVersion, 2);
  assert.deepEqual(result.workflowJob.payload.environmentBindings, [{ serviceId: devService.id, projectId: project.id, environmentId: dev.id, environmentKind: 'dev' }]);
  assert.equal(replay.workflowJob.id, result.workflowJob.id);
  assert.equal(store.snapshot().workflowJobs.length, 1);
});

test('GitHub sync preserves multiple project bindings and gives each admission a distinct job', () => {
  // Given selected dev services of the same repository in two projects.
  const { store, organization, source, devService } = githubFixture();
  const project = store.createProject({ organizationId: organization.id, name: 'Second', slug: 'second' });
  const dev = store.createEnvironment({ projectId: project.id, kind: 'dev', expectedVersion: 0 });
  const other = store.importGitHubRepository({ ...source, projectId: project.id, environmentId: dev.id, branch: 'develop', idempotencyKey: 'other-project' }).service;
  // When separate sync admissions select both services.
  const results = [0, 1].map(() => store.syncGitHubRepository({ repository: 'memory/dual', serviceIds: [devService.id, other.id] }));
  // Then no single-environment label is fabricated and no job is overwritten.
  assert.notEqual(results[0].workflowJob.id, results[1].workflowJob.id);
  assert.equal(results[0].workflowJob.environmentId, null);
  assert.equal(results[0].workflowJob.operationalProtocolVersion, 2);
  assert.deepEqual(results[0].workflowJob.payload.environmentBindings.map((row) => row.serviceId).sort(), [devService.id, other.id].sort());
  assert.equal(new Set(results[0].workflowJob.payload.environmentBindings.map((row) => row.projectId)).size, 2);
});

test('GitHub sync rejects an invalid stored environment binding before adding work', () => {
  // Given a catalog-bound service whose environment binding is missing.
  const { store, devService } = githubFixture();
  store.environmentServices.delete(devService.id);
  // When this broken stored target is selected for sync.
  const sync = () => store.syncGitHubRepository({ repository: 'memory/dual', serviceIds: [devService.id] });
  // Then admission fails without leaving a job.
  assert.throws(sync, (error) => error instanceof EnvironmentError && error.statusCode === 404);
  assert.equal(store.snapshot().workflowJobs.length, 0);
});

test('F2 signed dev push fans out to all siblings without deployment or job collisions', () => {
  // Given two dev services bound to one repository and branch.
  const { store, project, dev, source } = githubFixture();
  store.importGitHubRepository({ ...source, serviceName: 'worker', serviceSlug: 'worker', branch: 'develop', environmentId: dev.id, idempotencyKey: 'dev-worker' });
  const payload = { ref: 'refs/heads/develop', after: 'b'.repeat(40), repository: { id: 78002, full_name: 'memory/dual', default_branch: 'main' }, installation: { id: 78001 } };
  const body = JSON.stringify(payload);
  const secret = 'memory-review-synthetic-secret';
  const input = { event: 'push', deliveryId: `long-delivery-${'x'.repeat(64)}`, body, payload, secret, signature: `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}` };
  // When a signed push and the identical delivery replay reach the public store.
  const result = store.handleGitHubWebhook(input);
  const replay = store.handleGitHubWebhook(input);
  // Then all siblings survive and delivery replay adds nothing.
  assert.equal(result.actions.filter((row) => row.type === 'production-deployment-enqueued').length, 2);
  assert.equal(store.snapshot().deployments.length, 2);
  assert.equal(new Set(store.snapshot().workflowJobs.map((row) => row.id)).size, 2);
  assert.equal(replay.duplicate, true);
});

test('memory deployment snapshot and row use binding identity after payload spreads', () => {
  // Given a dev service with stale prod fields in its desired spec.
  const { store, project, prod, dev, service } = fixture();
  const stale = store.createService({ projectId: project.id, environmentId: dev.id, name: 'snapshot', desiredSpec: { kind: 'prod', environmentId: prod.id, environmentKind: 'prod', logicalSlug: 'wrong', physicalSlug: 'wrong' } });
  // When a deployment is admitted with contradictory payload environment fields.
  const row = store.createDeployment({ serviceId: stale.id, environmentId: prod.id, environmentKind: 'prod', commitSha: 'c'.repeat(40) });
  // Then the stored binding wins in the immutable row and captured snapshot.
  assert.equal(row.environmentId, dev.id);
  assert.equal(row.desiredSpecSnapshot.environmentId, dev.id);
  assert.equal(row.desiredSpecSnapshot.environmentKind, 'dev');
  assert.equal(row.desiredSpecSnapshot.kind, 'dev');
  assert.equal(row.desiredSpecSnapshot.logicalSlug, 'snapshot');
  assert.equal(row.desiredSpecSnapshot.physicalSlug, stale.slug);
  assert.notEqual(stale.id, service.id);
});

test('F2 dev rollback admissions preserve the source and each rollback attempt', () => {
  // Given two successful deployments of one dev service.
  const { store, service } = fixture();
  const previous = store.createDeployment({ serviceId: service.id, imageUrl: 'example/web:v1', status: 'READY' });
  const current = store.createDeployment({ serviceId: service.id, imageUrl: 'example/web:v2', status: 'READY' });
  // When rollback is admitted twice against the same source.
  const rollbacks = [0, 1].map(() => store.rollbackDeployment(current.id, { previousDeploymentId: previous.id }));
  // Then all deployment/job identities and immutable source rows survive.
  assert.equal(store.snapshot().deployments.length, 4);
  assert.notEqual(rollbacks[0].deployment.id, rollbacks[1].deployment.id);
  assert.notEqual(rollbacks[0].workflowJob.id, rollbacks[1].workflowJob.id);
  assert.equal(store.getDeployment(current.id).imageUrl, 'example/web:v2');
});

test('F2 dev pull requests retain separate sibling lineages and generations', () => {
  // Given two dev services observing the same repository base branch.
  const { store, dev, source } = githubFixture();
  store.importGitHubRepository({ ...source, serviceName: 'worker', serviceSlug: 'worker', branch: 'develop', environmentId: dev.id, idempotencyKey: 'pr-worker' });
  // When two signed PR generations are delivered with distinct valid delivery UUIDs.
  for (const [action, sha, second] of [['opened', 'a', 0], ['synchronize', 'b', 1]]) {
    const payload = { action, number: 7, installation: { id: 78001 }, repository: { id: 78002, full_name: 'memory/dual' }, pull_request: { number: 7, state: 'open', head: { sha: sha.repeat(40), ref: 'topic' }, base: { ref: 'develop' }, updated_at: `2026-09-13T00:00:0${second}Z` }, ...(second ? { before: 'a'.repeat(40) } : {}) };
    const body = JSON.stringify(payload);
    const secret = 'memory-review-synthetic-secret';
    store.handleGitHubWebhook({ event: 'pull_request', deliveryId: `11111111-1111-4111-8111-${String(second).padStart(12, '0')}`, body, secret, signature: `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}` });
  }
  // Then each service has its own lineage and each generation its own work.
  assert.equal(store.snapshot().deployments.length, 4);
  assert.equal(new Set(store.snapshot().deployments.map((row) => row.previewLineageId)).size, 2);
  assert.equal(new Set(store.snapshot().workflowJobs.map((row) => row.id)).size, 4);
});

test('workflow scope derives from its deployment before contradictory payload service fields', () => {
  // Given a dev deployment and an unrelated prod service.
  const { store, project, service, prod, dev } = fixture();
  const other = store.createService({ projectId: project.id, name: 'prod-other' });
  const deployment = store.createDeployment({ serviceId: service.id });
  // When payload fields claim a prod service/environment for the dev target.
  const job = store.enqueueWorkflowJob({ type: 'build-and-deploy', targetType: 'deployment', targetId: deployment.id, environmentId: prod.id, payload: { serviceId: other.id } });
  // Then protocol and identity still come from the stored target binding.
  assert.equal(job.environmentId, dev.id);
  assert.equal(job.operationalProtocolVersion, 2);
});

test('creation preserves service variable maps and rejects contradictory selector aliases', () => {
  // Given explicit environment identity plus the legacy environment variable map.
  const { store, project, dev } = fixture();
  // When service creation parses identity separately from ordinary variables.
  const service = store.createService({ projectId: project.id, name: 'vars', environmentId: dev.id, environmentKind: 'dev', environment: { HELLO: 'world' } });
  // Then values survive, while contradictory writer aliases fail closed.
  assert.deepEqual(store.getService(service.id).environment, { HELLO: 'world' });
  assert.throws(() => store.createService({ projectId: project.id, name: 'invalid', environmentId: dev.id, environmentKind: 'prod' }), (error) => error.statusCode === 404);
  assert.throws(() => store.createResource({ projectId: project.id, name: 'invalid', engine: 'postgresql', environmentId: dev.id, environmentKind: 'prod' }), (error) => error.statusCode === 404);
});

test('F11 parser preserves omitted kind across reparsing and ID-only resolves stored dev', () => {
  // Given prod and dev in the same project.
  const { store, project, dev, prod } = fixture();
  // When omitted and ID-only inputs are parsed repeatedly.
  const omitted = parseEnvironmentSelector(parseEnvironmentSelector({}));
  const idOnly = parseEnvironmentSelector(parseEnvironmentSelector({ environmentId: dev.id }));
  // Then defaulting happens at resolution and explicit absence survives parsing.
  assert.deepEqual(omitted, {});
  assert.deepEqual(idOnly, { environmentId: dev.id });
  assert.equal(store.resolveEnvironment(project.id, omitted).id, prod.id);
  assert.equal(store.resolveEnvironment(project.id, idOnly).id, dev.id);
});

for (const alias of ['kind', 'environmentKind', 'environment']) {
  test(`F11 explicit ${alias} rejects contradictory ID kind after reparsing`, () => {
    // Given each valid kind alias and both stored environments.
    const { store, project, dev, prod } = fixture();
    // When an explicit alias contradicts the selected row in either direction.
    for (const [id, kind] of [[dev.id, 'prod'], [prod.id, 'dev']]) {
      const selector = parseEnvironmentSelector(parseEnvironmentSelector({ environmentId: id, [alias]: kind }));
      // Then resolution consistently reports wrong environment, not success.
      assert.throws(() => store.resolveEnvironment(project.id, selector), (error) => error instanceof EnvironmentError && error.statusCode === 404);
    }
  });
}

test('F11 conflicting aliases and explicit invalid kinds fail before resolution', () => {
  // Given conflicting alias pairs plus malformed values.
  const inputs = [{ kind: 'prod', environment: 'dev' }, { kind: 'dev', environmentKind: 'prod' }, { environmentKind: 'prod', environment: 'dev' }, { kind: '' }, { kind: null }, { kind: 'prod', environment: 'invalid' }];
  // When each crosses the selector parser boundary.
  for (const input of inputs) {
    // Then no alias is silently discarded by precedence/defaulting.
    assert.throws(() => parseEnvironmentSelector(input), (error) => error instanceof EnvironmentError && error.statusCode === 400);
  }
  assert.deepEqual(parseEnvironmentSelector({ kind: 'dev', environmentKind: 'dev', environment: 'dev' }), { kind: 'dev' });
});
