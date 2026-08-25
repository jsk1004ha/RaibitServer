type OrganizationSubject = {
  organizationId?: unknown;
  organizationIds?: unknown;
};

type OrganizationMembership = {
  organizationId?: unknown;
};

export function resolveOrganizationRouteValue({
  requested,
  subject,
  memberships,
}: {
  requested?: unknown;
  subject?: OrganizationSubject | null;
  memberships?: OrganizationMembership[] | null;
} = {}) {
  const candidates = [
    requested,
    subject?.organizationId,
    ...(Array.isArray(subject?.organizationIds) ? subject.organizationIds : []),
    ...(Array.isArray(memberships) ? memberships.map((membership) => membership?.organizationId) : []),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' && typeof candidate !== 'number') continue;
    const value = String(candidate).trim();
    if (value && value.length <= 200) return value;
  }
  return '';
}

export function consoleOrganizationLinks(organizationRouteValue: string) {
  if (!organizationRouteValue) return { projects: '/console', createProject: '/console' };
  const encoded = encodeURIComponent(organizationRouteValue);
  return {
    projects: `/org/${encoded}/projects`,
    createProject: `/org/${encoded}/projects/new`,
  };
}
