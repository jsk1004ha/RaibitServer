const HIDDEN_PROJECT_STATUSES = new Set(['ARCHIVED', 'DELETED', 'FAILED']);

export function normalizePublicSiteLimit(value: unknown) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return 5;
  return Math.max(0, Math.min(Math.floor(requested), 5));
}

export function publicSitesFromSnapshot(snapshot: Record<string, any>, requestedLimit: unknown = 5) {
  const projects = new Map((snapshot.projects || []).map((project: any) => [String(project.id), project]));
  const organizations = new Map((snapshot.organizations || []).map((organization: any) => [String(organization.id), organization]));
  const domains = snapshot.domains || [];
  const deploymentsByService = new Map<string, any[]>();
  for (const deployment of snapshot.deployments || []) {
    const serviceId = String(deployment?.serviceId || '');
    if (!serviceId) continue;
    const deployments = deploymentsByService.get(serviceId) || [];
    deployments.push(deployment);
    deploymentsByService.set(serviceId, deployments);
  }
  const rows = (snapshot.services || []).map((service: any) => {
    const project: any = projects.get(String(service.projectId));
    return {
      ...service,
      project: project ? { ...project, organization: organizations.get(String(project.organizationId)) } : null,
      domains: domains.filter((domain: any) => String(domain.serviceId) === String(service.id)),
      deployments: deploymentsByService.get(String(service.id)) || [],
    };
  });
  return publicSitesFromServices(rows, requestedLimit);
}

export function publicSitesFromServices(rows: any[], requestedLimit: unknown = 5) {
  const limit = normalizePublicSiteLimit(requestedLimit);
  const seenProjects = new Set<string>();
  const sites: Array<Record<string, any>> = [];
  const sorted = [...(rows || [])].sort((left, right) => rowTime(right) - rowTime(left));

  for (const service of sorted) {
    if (sites.length >= limit) break;
    const project = service?.project;
    const projectId = String(project?.id || service?.projectId || '');
    if (!projectId || seenProjects.has(projectId)) continue;
    if (String(service?.type || '').toLowerCase() !== 'web') continue;
    if (service?.deletionRequestedAt || project?.deletionRequestedAt) continue;
    if (HIDDEN_PROJECT_STATUSES.has(String(project?.status || '').toUpperCase())) continue;
    if (!(service?.deployments || []).some(isReadyProductionDeployment)) continue;
    const domain = (service?.domains || []).find((candidate: any) => candidate?.verified === true && publicHostname(candidate?.domain));
    const hostname = publicHostname(domain?.domain);
    if (!hostname) continue;
    seenProjects.add(projectId);
    sites.push({
      id: projectId,
      name: project?.name || project?.slug || service?.name || '이름 없는 사이트',
      owner: project?.organization?.name || project?.organization?.slug || 'RAIBIT',
      status: 'LIVE',
      url: `https://${hostname}`,
    });
  }
  return { sites };
}

function isReadyProductionDeployment(deployment: any) {
  return String(deployment?.deploymentType || 'production').toUpperCase() === 'PRODUCTION'
    && String(deployment?.status || '').toUpperCase() === 'READY';
}

function publicHostname(value: unknown) {
  const hostname = String(value || '').trim().toLowerCase();
  if (!hostname || hostname.length > 253 || hostname.includes('/') || hostname.includes('@') || hostname.includes(':')) return '';
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) return '';
  return hostname;
}

function rowTime(row: any) {
  const value = Date.parse(String(row?.updatedAt || row?.createdAt || ''));
  return Number.isFinite(value) ? value : 0;
}
