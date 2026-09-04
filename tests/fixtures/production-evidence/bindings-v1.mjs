const managedEngines = Object.freeze(['postgresql', 'mysql', 'mariadb', 'mongodb', 'redis', 'valkey']);
export const releaseBindings = Object.freeze([
  { kind: 'organization-membership', organizationId: 'org-1', membershipId: 'member-1', userId: 'user-1', role: 'OWNER' },
  { kind: 'github-repository', installationId: 'installation-1', repositoryId: 'repo-1', repository: 'fixture/repository', branch: 'main' },
  { kind: 'tenant-revision', tenantRevisionId: 'revision-candidate', purpose: 'candidate', repositoryId: 'repo-1', repository: 'fixture/repository', branch: 'main', tenantCommitSha: '1'.repeat(40), controlled: true },
  { kind: 'tenant-revision', tenantRevisionId: 'revision-failure', purpose: 'failure', repositoryId: 'repo-1', repository: 'fixture/repository', branch: 'failure-test', tenantCommitSha: '2'.repeat(40), controlled: true },
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
