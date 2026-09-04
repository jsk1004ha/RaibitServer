const managedEngines = Object.freeze(['postgresql', 'mysql', 'mariadb', 'mongodb', 'redis', 'valkey']);
export const releaseBindings = Object.freeze([
  { kind: 'organization-membership', organizationId: 'org-1', membershipId: 'member-1', userId: 'user-1', role: 'OWNER' },
  { kind: 'github-repository', installationId: 'installation-1', repositoryId: 'repo-1', repository: 'fixture/repository', branch: 'main' },
  { kind: 'tenant-revision', tenantRevisionId: 'revision-candidate', purpose: 'candidate', observationId: 'observation-candidate', repositoryId: 'repo-1', repository: 'fixture/repository', branch: 'main', tenantCommitSha: '1'.repeat(40) },
  { kind: 'tenant-revision', tenantRevisionId: 'revision-failure', purpose: 'failure', observationId: 'observation-failure', repositoryId: 'repo-1', repository: 'fixture/repository', branch: 'failure-test', tenantCommitSha: '2'.repeat(40) },
  { kind: 'project', projectId: 'project-1', organizationId: 'org-1' },
  { kind: 'service', serviceId: 'service-1', projectId: 'project-1' },
  ...['candidate', 'preview', 'rollback'].map((role, index) => ({ kind: 'deployment', role, deploymentId: `deployment-${index}`,
    serviceId: 'service-1', tenantRevisionId: 'revision-candidate', tenantCommitSha: '1'.repeat(40), repositoryId: 'repo-1', repository: 'fixture/repository', branch: 'main' })),
  { kind: 'deployment', role: 'failed', deploymentId: 'deployment-failed', serviceId: 'service-1', tenantRevisionId: 'revision-failure',
    tenantCommitSha: '2'.repeat(40), repositoryId: 'repo-1', repository: 'fixture/repository', branch: 'failure-test' },
  ...managedEngines.flatMap((engine) => [
    { kind: 'resource', role: 'source', engine, resourceId: `${engine}-source`, projectId: 'project-1' },
    { kind: 'resource', role: 'restore-target', engine, resourceId: `${engine}-target`, projectId: 'project-1' },
    { kind: 'backup', engine, backupId: `${engine}-backup`, sourceResourceId: `${engine}-source` },
    { kind: 'restore', engine, restoreId: `${engine}-restore`, backupId: `${engine}-backup`, targetResourceId: `${engine}-target` },
  ]),
]);

export function bindingJournalVerification(manifest, digest) {
  const observations = releaseBindings.filter(({ kind }) => kind === 'tenant-revision').map((revision) => ({
    observationId: revision.observationId, kind: revision.purpose === 'candidate' ? 'builder-deployment-observation' : 'github-webhook-observation',
    receiptPath: `artifacts/lifecycle/${revision.purpose}.json`, receiptSha256: revision.purpose[0].repeat(64),
    artifactPath: `artifacts/lifecycle/${revision.purpose}-observation.json`, artifactSha256: revision.purpose[1].repeat(64),
    identityDigest: digest(manifest.identity), repositoryId: revision.repositoryId, repository: revision.repository,
    branch: revision.branch, tenantCommitSha: revision.tenantCommitSha,
  }));
  return { schema: 'raibitserver.verified-binding-journal/v1', journal: manifest.bindingJournal,
    identityDigest: digest(manifest.identity), bindingsDigest: manifest.bindingsDigest, entries: structuredClone(releaseBindings), observations };
}

export function synchronizeJournal(manifest, journal, digest) {
  const bindingsDigest = digest(journal.entries);
  manifest.bindingsDigest = bindingsDigest; manifest.bindingJournal.entriesDigest = bindingsDigest;
  for (const fragment of manifest.fragments) fragment.bindingsDigest = bindingsDigest;
  journal.bindingsDigest = bindingsDigest; journal.journal.entriesDigest = bindingsDigest;
  manifest.bindingJournal.entryCount = journal.entries.length; journal.journal.entryCount = journal.entries.length;
}
