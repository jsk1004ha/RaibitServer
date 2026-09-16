const previewEvent = Object.freeze({ deliveryId: 'c60b7c80-1cd0-4d7c-a65a-aa642dc1992b', installationId: '900', repositoryId: '101', repository: 'fixture/repository', pullRequestNumber: 14, action: 'opened', headSha: '3'.repeat(40), headRef: 'feature/preview', baseRef: 'main', beforeSha: null, updatedAt: '2026-09-03T01:02:03Z' });
const managedEngines = Object.freeze(['postgresql', 'mysql', 'mariadb', 'mongodb', 'redis', 'valkey']);
export const releaseBindings = Object.freeze([
  { kind: 'organization-membership', organizationId: 'org-1', membershipId: 'member-1', userId: 'user-1', role: 'OWNER' },
  { kind: 'github-repository', installationId: '900', repositoryId: '101', repository: 'fixture/repository', branch: 'main' },
  { kind: 'github-webhook-event', webhookEventId: 'c111111111111111111111111', provider: 'github', eventType: 'pull_request', deliveryId: 'c60b7c80-1cd0-4d7c-a65a-aa642dc1992b', handled: true, event: previewEvent },
  { kind: 'tenant-revision', tenantRevisionId: 'revision-candidate', purpose: 'candidate', observationId: 'observation-candidate', repositoryId: '101', repository: 'fixture/repository', branch: 'main', tenantCommitSha: '1'.repeat(40) },
  { kind: 'tenant-revision', tenantRevisionId: 'revision-failure', purpose: 'failure', observationId: 'observation-failure', repositoryId: '101', repository: 'fixture/repository', branch: 'failure-test', tenantCommitSha: '2'.repeat(40) },
  { kind: 'tenant-revision', tenantRevisionId: 'revision-preview', purpose: 'preview', observationId: 'observation-preview', repositoryId: '101', repository: 'fixture/repository', branch: 'feature/preview', tenantCommitSha: '3'.repeat(40), pullRequestNumber: 14 },
  { kind: 'project', projectId: 'project-1', organizationId: 'org-1' },
  { kind: 'service', serviceId: 'service-1', projectId: 'project-1' },
  ...['candidate', 'rollback'].map((role, index) => ({ kind: 'deployment', role, deploymentId: `deployment-${index}`,
    serviceId: 'service-1', tenantRevisionId: 'revision-candidate', tenantCommitSha: '1'.repeat(40), repositoryId: '101', repository: 'fixture/repository', branch: 'main' })),
  { kind: 'deployment', role: 'preview', deploymentId: 'deployment-preview', serviceId: 'service-1', tenantRevisionId: 'revision-preview',
    tenantCommitSha: '3'.repeat(40), repositoryId: '101', repository: 'fixture/repository', branch: 'feature/preview' },
  { kind: 'deployment', role: 'failed', deploymentId: 'deployment-failed', serviceId: 'service-1', tenantRevisionId: 'revision-failure',
    tenantCommitSha: '2'.repeat(40), repositoryId: '101', repository: 'fixture/repository', branch: 'failure-test' },
  ...managedEngines.flatMap((engine) => [
    { kind: 'resource', role: 'source', engine, resourceId: `${engine}-source`, projectId: 'project-1' },
    { kind: 'resource', role: 'restore-target', engine, resourceId: `${engine}-target`, projectId: 'project-1' },
    { kind: 'backup', engine, backupId: `${engine}-backup`, sourceResourceId: `${engine}-source` },
    { kind: 'restore', engine, restoreId: `${engine}-restore`, backupId: `${engine}-backup`, targetResourceId: `${engine}-target` },
  ]),
]);

export function releaseObservations(manifest, digest) {
  return releaseBindings.filter(({ kind }) => kind === 'tenant-revision').map((revision) => ({
    observationId: revision.observationId, kind: revision.purpose === 'candidate' ? 'builder-deployment-observation' : revision.purpose === 'preview' ? 'github-pull-request-observation' : 'controlled-fixture-observation',
    receiptPath: `artifacts/lifecycle/${revision.purpose}.json`, receiptSha256: revision.tenantCommitSha[0].repeat(64),
    artifactPath: `artifacts/lifecycle/${revision.purpose}-observation.json`, artifactSha256: revision.tenantCommitSha[0].repeat(64),
    identityDigest: digest(manifest.identity), repositoryId: revision.repositoryId, repository: revision.repository,
    branch: revision.branch, tenantCommitSha: revision.tenantCommitSha,
    ...(revision.purpose === 'failure' ? { deploymentId: 'deployment-failed', controlledFault: { kind: 'readiness-path', originalReadinessPath: '/health', failingPath: '/_evidence/failure', deploymentReadinessPath: '/_evidence/failure', probeStatusCode: 404, snapshotVersion: 1, failedStatus: 'FAILED', errorCode: 'ROLLOUT_FAILED', rolloutEventId: revision.observationId, restoredReadinessPath: '/health' } } : {}),
    ...(revision.purpose === 'preview' ? { webhookEventId: 'c111111111111111111111111', deploymentId: 'deployment-preview', lineageId: 'lineage-preview', event: { deliveryId: 'c60b7c80-1cd0-4d7c-a65a-aa642dc1992b', installationId: '900', repositoryId: '101', repository: revision.repository, pullRequestNumber: 14, action: 'opened', headSha: revision.tenantCommitSha, headRef: revision.branch, baseRef: 'main', beforeSha: null, updatedAt: '2026-09-03T01:02:03Z' } } : {}),
  }));
}

export function bindingJournalVerification(manifest, digest) {
  const observations = releaseObservations(manifest, digest);
  return { schema: 'raibitserver.verified-binding-journal/v1', journal: manifest.bindingJournal,
    identityDigest: digest(manifest.identity), bindingsDigest: manifest.bindingsDigest, entries: structuredClone(releaseBindings), observations };
}

export function synchronizeJournal(manifest, journal, digest) {
  const bindingsDigest = digest(journal.entries);
  manifest.bindingsDigest = bindingsDigest;
  for (const fragment of manifest.fragments) fragment.bindingsDigest = bindingsDigest;
  journal.bindingsDigest = bindingsDigest;
  manifest.bindingJournal.entryCount = journal.entries.length; journal.journal.entryCount = journal.entries.length;
}
