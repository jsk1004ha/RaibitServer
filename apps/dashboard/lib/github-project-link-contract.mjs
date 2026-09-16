/**
 * @param {{ readonly memberships: unknown, readonly projects: readonly unknown[], readonly subject: unknown }} input
 * @returns {Readonly<Record<string, string>>}
 */
export function scopedProjectHrefs({ memberships, projects, subject }) {
  const hrefs = {};
  const memberOrganizations = new Set(Array.isArray(memberships)
    ? memberships.flatMap((membership) => isRecord(membership) && typeof membership.organizationId === 'string' ? [membership.organizationId] : [])
    : []);
  const subjectOrganizationId = isRecord(subject) && typeof subject.organizationId === 'string' ? subject.organizationId : '';
  const subjectOrganizationSlug = isRecord(subject) && typeof subject.organizationSlug === 'string' ? subject.organizationSlug : '';
  for (const project of projects) {
    if (!isRecord(project) || typeof project.id !== 'string' || typeof project.organizationId !== 'string') continue;
    if (!memberOrganizations.has(project.organizationId) && subjectOrganizationId !== project.organizationId) continue;
    const projectOrganization = isRecord(project.organization) ? project.organization : null;
    const routeSlug = routeSlugFor(project.organizationSlug)
      || routeSlugFor(projectOrganization?.slug)
      || (subjectOrganizationId === project.organizationId ? routeSlugFor(subjectOrganizationSlug) : '');
    if (!routeSlug) continue;
    hrefs[project.id] = `/org/${encodeURIComponent(routeSlug)}/projects/${encodeURIComponent(project.id)}`;
  }
  return hrefs;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function routeSlugFor(value) {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(value) ? value : '';
}
