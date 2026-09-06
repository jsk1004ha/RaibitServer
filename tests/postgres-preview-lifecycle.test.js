import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';

const secret = 'task18-local-only-secret';
const postgresConfigured = Boolean(process.env.RAIBITSERVER_TEST_DATABASE_URL && process.env.RAIBITSERVER_TEST_PRISMA_MODULE);
const postgresOptions = { skip: !postgresConfigured && process.env.RAIBITSERVER_REQUIRE_POSTGRES_TESTS !== '1' ? 'NOT_RUN: disposable PostgreSQL URL/module not configured' : false };
function signed(action, updatedAt, deliveryId = randomUUID(), headSha = 'a'.repeat(40), before, repository = { id: 101, full_name: 'club/repo' }) {
  const value = { action, number: 7, installation: { id: 900 }, repository, pull_request: { number: 7, state: action === 'closed' ? 'closed' : 'open', head: { sha: headSha, ref: 'topic' }, base: { ref: 'main' }, updated_at: updatedAt }, ...(before ? { before } : {}) };
  const body = JSON.stringify(value);
  return { event: 'pull_request', deliveryId, body, payload: { malicious: true }, secret, signature: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` };
}

test('signed preview admission dedupes twenty clients and fences close resolver reopen on PostgreSQL', postgresOptions, async t => {
  assert.ok(process.env.RAIBITSERVER_TEST_DATABASE_URL, 'real disposable PostgreSQL URL required; this suite must not skip');
  assert.ok(process.env.RAIBITSERVER_TEST_PRISMA_MODULE, 'generated PostgreSQL Prisma module required; this suite must not skip');
  const { PrismaClient } = await import(process.env.RAIBITSERVER_TEST_PRISMA_MODULE);
  const clients = Array.from({ length: 20 }, () => new PrismaClient({ datasourceUrl: process.env.RAIBITSERVER_TEST_DATABASE_URL, transactionOptions: { maxWait: 30000, timeout: 30000 } }));
  const repositories = clients.map(client => new PrismaControlPlaneRepository(client));
  t.after(() => Promise.all(clients.map(client => client.$disconnect())));
  const db = clients[0];
  await db.organization.create({ data: { id: 'org', name: 'Club', slug: 'club' } });
  await db.user.create({ data: { id: 'user', email: 'owner@example.test', approvalStatus: 'APPROVED', accountType: 'NON_CLUB' } });
  await db.membership.create({ data: { id: 'member', organizationId: 'org', userId: 'user', role: 'owner' } });
  await db.quota.create({ data: { id: 'quota', userId: 'user', accountType: 'NON_CLUB', maxDeploymentsPerDay: 20, maxPreviewDeployments: 20 } });
  await db.project.create({ data: { id: 'project', organizationId: 'org', name: 'Project', slug: 'project', status: 'ACTIVE' } });
  await db.gitHubInstallation.create({ data: { id: 'install', installationId: '900', accountLogin: 'club', accountType: 'Organization' } });
  await db.gitHubIntegration.create({ data: { id: 'integration', organizationId: 'org', userId: 'user', installationId: '900', accountLogin: 'club', verifiedAt: new Date() } });
  await db.gitHubRepository.create({ data: { id: 'repo', installationId: '900', githubRepoId: '101', owner: 'club', name: 'repo', fullName: 'club/repo' } });
  await db.service.create({ data: { id: 'service', projectId: 'project', name: 'Web', slug: 'web', type: 'web', sourceType: 'github', branch: 'main', githubRepositoryId: '101', desiredSpec: { port: 3000 }, desiredState: { githubIntegrationId: 'integration', githubInstallationId: '900', githubRepositoryId: '101', githubRepository: 'club/repo', github: { integrationId: 'integration', installationId: '900', repositoryId: '101', repository: 'club/repo' } } } });
  const opened = signed('opened', '2026-09-03T00:00:00Z');
  const results = await Promise.all(repositories.map(repository => repository.handleGitHubWebhook(opened)));
  assert.equal(results.filter(result => result.duplicate === false).length, 1);
  assert.equal(results.filter(result => result.duplicate === true).length, 19);
  assert.equal(await db.previewLineage.count(), 1);
  assert.equal(await db.deployment.count({ where: { previewLineageId: { not: null } } }), 1);
  assert.equal(await db.workflowJob.count({ where: { type: 'preview-deploy' } }), 1);
  const accepted = results.find(result => result.duplicate === false);
  const persistedWebhook = await db.webhookEvent.findUnique({ where: { deliveryId: opened.deliveryId } });
  const expectedWebhook = {
    deliveryId: opened.deliveryId,
    installationId: '900',
    repositoryId: '101',
    repository: 'club/repo',
    pullRequestNumber: 7,
    action: 'opened',
    headSha: 'a'.repeat(40),
    headRef: 'topic',
    baseRef: 'main',
    beforeSha: null,
    updatedAt: '2026-09-03T00:00:00Z',
  };
  assert.deepEqual(persistedWebhook.payload, expectedWebhook);
  assert.equal(accepted.webhookEvent.id, persistedWebhook.id);
  const firstPreviewDeployment = await db.deployment.findFirst({ where: { previewLineageId: { not: null } } });
  const previewAdmissionEvent = await db.deploymentEvent.findFirst({ where: { deploymentId: firstPreviewDeployment.id, type: 'preview.workload.queued' } });
  assert.deepEqual(previewAdmissionEvent.metadata, { source: 'github-webhook', webhookEventId: persistedWebhook.id, lineageId: firstPreviewDeployment.previewLineageId, ...expectedWebhook });
  assert.equal(JSON.stringify(persistedWebhook.payload).includes('signature'), false);
  assert.equal(JSON.stringify(persistedWebhook.payload).includes('secret'), false);
  const beforeReplayRejection = [await db.webhookEvent.count(), await db.previewLineage.count(), await db.deployment.count(), await db.workflowJob.count(), await db.deploymentEvent.count(), await db.auditLog.count()];
  await assert.rejects(
    repositories[0].handleGitHubWebhook(signed('reopened', '2026-09-03T00:00:01Z', opened.deliveryId, 'b'.repeat(40))),
    error => error?.code === 'preview_delivery_conflict' && error?.statusCode === 409,
  );
  assert.deepEqual([await db.webhookEvent.count(), await db.previewLineage.count(), await db.deployment.count(), await db.workflowJob.count(), await db.deploymentEvent.count(), await db.auditLog.count()], beforeReplayRejection);
  const invalidSignature = { ...signed('opened', '2026-09-03T00:00:01Z'), signature: `sha256=${'0'.repeat(64)}` };
  await assert.rejects(repositories[0].handleGitHubWebhook(invalidSignature), error => error?.statusCode === 401);
  assert.deepEqual([await db.webhookEvent.count(), await db.previewLineage.count(), await db.deployment.count(), await db.workflowJob.count(), await db.deploymentEvent.count(), await db.auditLog.count()], beforeReplayRejection);
  const lineage = await db.previewLineage.findFirst();
  assert.equal(lineage.state, 'OPEN');

  await repositories[0].handleGitHubWebhook(signed('closed', '2026-09-03T00:00:00Z'));
  const ambiguous = await db.previewLineage.findUnique({ where: { id: lineage.id } });
  assert.equal(ambiguous.state, 'AMBIGUOUS');
  assert.equal(await db.workflowJob.count({ where: { type: 'github.preview-resolve', targetId: lineage.id } }), 1);
  await repositories[1].handleGitHubWebhook(signed('closed', '2026-09-03T00:00:00Z'));
  assert.equal(await db.workflowJob.count({ where: { type: 'github.preview-resolve', targetId: lineage.id } }), 1);

  const observation = { version: 1, lineageId: lineage.id, lineageVersion: ambiguous.version, installationId: '900', repositoryId: '101', pullRequestNumber: 7, state: 'closed', headSha: 'a'.repeat(40), headRef: 'topic', baseRef: 'main', updatedAt: '2026-09-03T00:00:00Z', observedAt: '2026-09-03T00:00:01Z' };
  await db.previewLineage.update({ where: { id: lineage.id }, data: { resolutionObservation: observation } });
  await db.workflowJob.create({ data: { id: `preview-apply:${lineage.id}:${ambiguous.version}`, type: 'github.preview-apply', targetType: 'preview-lineage', targetId: lineage.id, payload: { version: 1, lineageId: lineage.id, lineageVersion: ambiguous.version } } });
  const applied = await repositories[2].applyNextPreviewObservation({ workerId: 'api-1' });
  assert.equal(applied.decision, 'close');
  assert.equal((await db.previewLineage.findUnique({ where: { id: lineage.id } })).state, 'CLOSED');
  const reopened = await repositories[3].handleGitHubWebhook(signed('reopened', '2026-09-03T00:00:02Z', randomUUID(), 'b'.repeat(40)));
  assert.equal(reopened.actions[0].type, 'preview-deployment-enqueued');
  const final = await db.previewLineage.findUnique({ where: { id: lineage.id } });
  assert.deepEqual([final.state, final.generation], ['OPEN', 2]);
  assert.equal((await db.deployment.findUnique({ where: { id: lineage.candidateDeploymentId } })).status, 'PREVIEW_CLEANUP_REQUESTED');
  const beforeRollback = [await db.deployment.count(), await db.workflowJob.count(), await db.webhookEvent.count(), (await db.previewLineage.findUnique({ where: { id: lineage.id } })).generation];
  const synchronize = signed('synchronize', '2026-09-03T00:00:03Z', randomUUID(), 'c'.repeat(40), 'b'.repeat(40));
  await db.$executeRawUnsafe('ALTER TABLE "WorkflowJob" ADD CONSTRAINT "task18_force_rollback" CHECK ("type" <> \'preview-deploy\') NOT VALID');
  await assert.rejects(repositories[4].handleGitHubWebhook(synchronize));
  await db.$executeRawUnsafe('ALTER TABLE "WorkflowJob" DROP CONSTRAINT "task18_force_rollback"');
  assert.deepEqual([await db.deployment.count(), await db.workflowJob.count(), await db.webhookEvent.count(), (await db.previewLineage.findUnique({ where: { id: lineage.id } })).generation], beforeRollback);
  await repositories[4].handleGitHubWebhook(synchronize);
  assert.equal((await db.previewLineage.findUnique({ where: { id: lineage.id } })).generation, 3);
  const attempts = await db.deployment.findMany({ where: { previewLineageId: lineage.id }, orderBy: { previewGeneration: 'asc' } });
  await db.deployment.updateMany({ where: { previewLineageId: lineage.id }, data: { status: 'FAILED' } });
  const source = attempts.at(-1);
  const retry = await repositories[5].createDeploymentOperation({ operation: 'retry', sourceDeploymentId: source.id, serviceId: 'service', requestIdempotencyKey: 'preview-retry', snapshotVersion: 1, requestedByUserId: 'user' });
  assert.equal(retry.deployment.previewGeneration, 4);
  assert.equal(retry.deployment.commitSha, 'c'.repeat(40));
  const closeAfterRetry = signed('closed', '2026-09-03T00:00:04Z');
  await repositories[6].handleGitHubWebhook(closeAfterRetry);
  const closedCounts = [await db.deployment.count(), await db.workflowJob.count()];
  await assert.rejects(repositories[7].createDeploymentOperation({ operation: 'retry', sourceDeploymentId: source.id, serviceId: 'service', requestIdempotencyKey: 'closed-retry', snapshotVersion: 1, requestedByUserId: 'user' }), error => error.code === 'PREVIEW_CLOSED');
  assert.deepEqual([await db.deployment.count(), await db.workflowJob.count()], closedCounts);
  const protectedState = await db.previewLineage.findUnique({ where: { id: lineage.id } });
  const protectedCounts = [await db.previewLineage.count(), await db.deployment.count(), await db.workflowJob.count()];
  await db.quota.update({ where: { id: 'quota' }, data: { maxPreviewDeployments: 0 } });
  const quotaBlocked = await repositories[8].handleGitHubWebhook(signed('reopened', '2026-09-03T00:00:05Z', randomUUID(), 'd'.repeat(40)));
  assert.equal(quotaBlocked.actions[0].type, 'github-webhook-quota-blocked');
  assert.deepEqual([await db.previewLineage.count(), await db.deployment.count(), await db.workflowJob.count()], protectedCounts);
  assert.deepEqual(await db.previewLineage.findUnique({ where: { id: lineage.id } }), protectedState);
  const foreign = await repositories[9].handleGitHubWebhook(signed('reopened', '2026-09-03T00:00:06Z', randomUUID(), 'e'.repeat(40), undefined, { id: 102, full_name: 'other/repo' }));
  assert.equal(foreign.matchedServiceCount, 0);
  assert.deepEqual([await db.previewLineage.count(), await db.deployment.count(), await db.workflowJob.count()], protectedCounts);
  await db.project.update({ where: { id: 'project' }, data: { status: 'DELETING' } });
  const inactive = await repositories[10].handleGitHubWebhook(signed('closed', '2026-09-03T00:00:07Z'));
  assert.equal(inactive.matchedServiceCount, 0);
  assert.deepEqual([await db.previewLineage.count(), await db.deployment.count(), await db.workflowJob.count()], protectedCounts);
  assert.deepEqual(await db.previewLineage.findUnique({ where: { id: lineage.id } }), protectedState);
  t.diagnostic(JSON.stringify({ clients: 20, lineages: 1, initialDeployments: 1, resolverJobs: 1, resolvedClose: true, reopenedGeneration: 2, oldCleanupFenced: true, databaseCheckRollback: true, deliveryRetryable: true, retryGeneration: 4, closedRetryAtomic: true, quotaBlockedAtomic: true, foreignRepositoryMutation: false, inactiveParentMutation: false }));
});
