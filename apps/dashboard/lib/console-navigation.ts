type OrganizationSubject = {
  organizationId?: unknown;
  organizationIds?: unknown;
};

type OrganizationMembership = {
  organizationId?: unknown;
  organizationSlug?: unknown;
};

export const WORKSPACE_PREFERENCE_COOKIE = 'raibit-workspace';

export function roleLabel(role: string): string {
  const labels: Readonly<Record<string, string>> = {
    USER: '사용자', ADMIN: '관리자', OWNER: '소유자', MEMBER: '팀원', DEVELOPER: '개발자', VIEWER: '조회 전용',
  };
  return labels[role.toUpperCase()] || '사용자';
}

export function resolveOrganizationRouteValue({
  requested,
  preferred,
  subject,
  memberships,
}: {
  requested?: unknown;
  preferred?: unknown;
  subject?: OrganizationSubject | null;
  memberships?: OrganizationMembership[] | null;
} = {}) {
  const candidates = [
    requested,
    preferred,
    subject?.organizationId,
    ...(Array.isArray(subject?.organizationIds) ? subject.organizationIds : []),
    ...(Array.isArray(memberships) ? memberships.map((membership) => membership?.organizationId) : []),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' && typeof candidate !== 'number') continue;
    const value = String(candidate).trim();
    if (!value || value.length > 200) continue;
    const membership = memberships?.find((item) => item.organizationId === value || item.organizationSlug === value);
    if (membership && typeof membership.organizationId === 'string') return membership.organizationId;
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
