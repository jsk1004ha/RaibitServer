import { serviceHostname } from '../../../packages/core/src/domain-router.ts';

type ProjectRecord = {
  id?: string;
  name?: string;
  slug?: string;
};

type ServiceRecord = {
  name?: string;
  slug?: string;
  type?: string;
  status?: string;
  deletionRequestedAt?: string | null;
};

const DEFAULT_BASE_DOMAIN = 'raibitserver.app';

export function projectMainLink({
  organizationSlug,
  project,
  services,
  baseDomain,
}: {
  organizationSlug: string;
  project: ProjectRecord;
  services: ServiceRecord[];
  baseDomain?: string;
}) {
  const mainService = [...services]
    .filter(isAvailableWebService)
    .sort((left, right) => servicePriority(left) - servicePriority(right)
      || serviceName(left).localeCompare(serviceName(right)))[0];
  if (!mainService) return null;

  const hostname = serviceHostname({
    organizationSlug,
    projectSlug: project.slug || project.name || project.id || 'project',
    serviceName: serviceName(mainService),
    baseDomain: normalizedBaseDomain(baseDomain),
  });
  return { href: `https://${hostname}`, label: hostname };
}

function isAvailableWebService(service: ServiceRecord) {
  const status = String(service.status || '').toUpperCase();
  return String(service.type || 'web').toLowerCase() === 'web'
    && !service.deletionRequestedAt
    && !['DELETE_REQUESTED', 'DELETING', 'DELETED'].includes(status);
}

function servicePriority(service: ServiceRecord) {
  return serviceName(service).toLowerCase() === 'web' ? 0 : 1;
}

function serviceName(service: ServiceRecord) {
  return String(service.slug || service.name || 'web');
}

function normalizedBaseDomain(value?: string) {
  const candidate = String(value || DEFAULT_BASE_DOMAIN).trim().toLowerCase().replace(/\.$/, '');
  return /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(candidate)
    ? candidate
    : DEFAULT_BASE_DOMAIN;
}
