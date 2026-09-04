export const capabilityEngines = Object.freeze([
  { engine: 'postgresql', enabled: true, required: true,
    release: { provision: true, authenticatedHealth: true, attach: true, query: true, schema: true, backup: true, restore: true },
    liveEvidenceRelease: 'verified' },
]);

export const releaseBindings = Object.freeze([
  { kind: 'organization-membership', organizationId: 'org-1', membershipId: 'member-1', userId: 'user-1', role: 'OWNER' },
  { kind: 'github-repository', installationId: 'installation-1', repositoryId: 'repo-1', repository: 'fixture/repository', branch: 'main' },
  { kind: 'tenant-revision', repositoryId: 'repo-1', branch: 'main', tenantCommitSha: '1'.repeat(40) },
  { kind: 'project', projectId: 'project-1', organizationId: 'org-1' },
  { kind: 'service', serviceId: 'service-1', projectId: 'project-1' },
  ...['candidate', 'preview', 'failed', 'rollback'].map((role, index) => (
    { kind: 'deployment', role, deploymentId: `deployment-${index}`, serviceId: 'service-1' }
  )),
  { kind: 'resource', role: 'source', engine: 'postgresql', resourceId: 'resource-source', projectId: 'project-1' },
  { kind: 'resource', role: 'restore-target', engine: 'postgresql', resourceId: 'resource-target', projectId: 'project-1' },
  { kind: 'backup', engine: 'postgresql', backupId: 'backup-1', sourceResourceId: 'resource-source' },
  { kind: 'restore', engine: 'postgresql', restoreId: 'restore-1', backupId: 'backup-1', targetResourceId: 'resource-target' },
]);
