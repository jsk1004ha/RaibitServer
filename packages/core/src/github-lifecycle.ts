const ACTIVE_SOURCE_ACCESS = Object.freeze(['github-app-private', 'github-app-public'] as const);

export const GITHUB_INTEGRATION_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  DISCONNECTED: 'DISCONNECTED',
  DELETED: 'DELETED',
} as const);

export type GitHubIntegrationStatus = typeof GITHUB_INTEGRATION_STATUS[keyof typeof GITHUB_INTEGRATION_STATUS];

export function githubIntegrationStatus(integration: Readonly<Record<string, unknown>>): GitHubIntegrationStatus {
  switch (integration.status) {
    case GITHUB_INTEGRATION_STATUS.ACTIVE:
    case GITHUB_INTEGRATION_STATUS.SUSPENDED:
    case GITHUB_INTEGRATION_STATUS.DISCONNECTED:
    case GITHUB_INTEGRATION_STATUS.DELETED:
      return integration.status;
    default:
      return integration.verifiedAt ? GITHUB_INTEGRATION_STATUS.ACTIVE : GITHUB_INTEGRATION_STATUS.DISCONNECTED;
  }
}

export function publicGitHubIntegration(integration: Readonly<Record<string, unknown>>) {
  const installationId = typeof integration.installationId === 'string' ? integration.installationId : null;
  const status = githubIntegrationStatus(integration);
  const verifiedAt = typeof integration.verifiedAt === 'string'
    ? integration.verifiedAt
    : integration.verifiedAt instanceof Date
      ? integration.verifiedAt.toISOString()
      : null;
  return {
    id: String(integration.id),
    organizationId: String(integration.organizationId),
    accountLogin: typeof integration.accountLogin === 'string' ? integration.accountLogin : null,
    installationId,
    status,
    version: Number(integration.version || 1),
    connected: status === GITHUB_INTEGRATION_STATUS.ACTIVE,
    credentialIssuance: status === GITHUB_INTEGRATION_STATUS.ACTIVE ? 'allowed' : 'denied',
    verifiedAt,
    externalGitHubSettingsUrl: installationId ? `https://github.com/settings/installations/${encodeURIComponent(installationId)}` : 'https://github.com/settings/installations',
    reattachUrl: `/github/install?organizationId=${encodeURIComponent(String(integration.organizationId))}`,
  };
}

export function githubSourceAccess(service: Readonly<Record<string, unknown>>) {
  const desired = recordValue(service.desiredState);
  const visibility = String(service.githubRepositoryVisibility || desired.githubRepositoryVisibility || recordValue(desired.github).visibility || 'private');
  return visibility === 'public' ? ACTIVE_SOURCE_ACCESS[1] : ACTIVE_SOURCE_ACCESS[0];
}

export function githubServiceSourceState(service: Readonly<Record<string, unknown>>, sourceAccess: string) {
  const desired = recordValue(service.desiredState);
  const github = recordValue(desired.github);
  return {
    ...service,
    sourceAccess,
    desiredState: {
      ...desired,
      sourceAccess,
      github: { ...github, sourceAccess },
    },
  };
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}
