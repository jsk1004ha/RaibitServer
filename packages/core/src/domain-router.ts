import { DEFAULT_DOMAIN } from './constants.ts';
import { slugify } from './ids.ts';

type AnyRecord = Record<string, any>;

export const SUBDOMAIN_ZONES = Object.freeze({
  DASHBOARD: 'app',
  API: 'api',
  ADMIN: 'admin',
  APPS: 'apps',
  PREVIEW: 'preview',
  CONSOLE: 'console',
  RESOURCES: 'resources',
  LOGS: 'logs',
  METRICS: 'metrics',
});

function joinLabel(...parts: any[]) {
  return parts.filter(Boolean).map((part) => slugify(part)).join('-');
}

function tenantProjectLabel(organizationSlug: any, projectSlug: any) {
  return joinLabel(organizationSlug, projectSlug);
}

export function serviceHostname({ organizationSlug = 'org', projectSlug = 'project', serviceName = 'service', baseDomain = DEFAULT_DOMAIN, customDomain = null, preview = null }: AnyRecord = {}) {
  if (customDomain) return customDomain;
  const label = joinLabel(preview, organizationSlug, projectSlug);
  const zone = preview ? SUBDOMAIN_ZONES.PREVIEW : SUBDOMAIN_ZONES.APPS;
  return `${label}.${zone}.${baseDomain}`;
}

export function serviceConsoleHostname({ organizationSlug = 'org', projectSlug = 'project', serviceName = 'service', baseDomain = DEFAULT_DOMAIN }: AnyRecord = {}) {
  return `${joinLabel(organizationSlug, projectSlug, serviceName)}.${SUBDOMAIN_ZONES.CONSOLE}.${baseDomain}`;
}

export function resourceConsoleHostname({ organizationSlug = 'org', projectSlug = 'project', resourceName = 'resource', baseDomain = DEFAULT_DOMAIN }: AnyRecord = {}) {
  return `${joinLabel(organizationSlug, projectSlug, resourceName)}.${SUBDOMAIN_ZONES.RESOURCES}.${baseDomain}`;
}

export function projectConsoleHostname({ organizationSlug = 'org', projectSlug = 'project', baseDomain = DEFAULT_DOMAIN }: AnyRecord = {}) {
  return `${tenantProjectLabel(organizationSlug, projectSlug)}.${SUBDOMAIN_ZONES.CONSOLE}.${baseDomain}`;
}

export function workspaceConsoleHostname({ organizationSlug = 'org', baseDomain = DEFAULT_DOMAIN }: AnyRecord = {}) {
  return `${slugify(organizationSlug)}.${SUBDOMAIN_ZONES.CONSOLE}.${baseDomain}`;
}

export function internalServiceHostname({ projectSlug = 'project', serviceName = 'service' }: AnyRecord = {}) {
  return `${slugify(serviceName)}.${slugify(projectSlug)}.svc.cluster.local`;
}

export function domainPlanForProject(spec: AnyRecord = {}) {
  const organization = spec.organization || { slug: spec.organizationSlug || 'default' };
  const project = spec.project || { name: spec.name || 'project', slug: spec.slug || spec.name || 'project' };
  const organizationSlug = slugify(organization.slug || organization.name || 'org');
  const projectSlug = slugify(project.slug || project.name || 'project');
  const baseDomain = spec.baseDomain || DEFAULT_DOMAIN;
  return {
    baseDomain,
    zones: SUBDOMAIN_ZONES,
    platform: {
      dashboard: `${SUBDOMAIN_ZONES.DASHBOARD}.${baseDomain}`,
      api: `${SUBDOMAIN_ZONES.API}.${baseDomain}`,
      admin: `${SUBDOMAIN_ZONES.ADMIN}.${baseDomain}`,
      logs: `${SUBDOMAIN_ZONES.LOGS}.${baseDomain}`,
      metrics: `${SUBDOMAIN_ZONES.METRICS}.${baseDomain}`,
    },
    workspace: workspaceConsoleHostname({ organizationSlug, baseDomain }),
    project: projectConsoleHostname({ organizationSlug, projectSlug, baseDomain }),
    services: (spec.services || []).map((service) => ({
      name: slugify(service.name),
      type: service.type || 'web',
      publicHostname: service.type === 'web' || !service.type
        ? serviceHostname({ organizationSlug, projectSlug, serviceName: service.name, baseDomain, customDomain: service.domain || null })
        : null,
      previewPattern: `pr-{number}-${tenantProjectLabel(organizationSlug, projectSlug)}.${SUBDOMAIN_ZONES.PREVIEW}.${baseDomain}`,
      consoleHostname: serviceConsoleHostname({ organizationSlug, projectSlug, serviceName: service.name, baseDomain }),
      internalHostname: internalServiceHostname({ projectSlug, serviceName: service.name }),
    })),
    resources: (spec.resources || []).map((resource) => ({
      name: slugify(resource.name),
      engine: resource.engine,
      consoleHostname: resourceConsoleHostname({ organizationSlug, projectSlug, resourceName: resource.name, baseDomain }),
      internalHostname: `${slugify(resource.name)}.${projectSlug}.svc.cluster.local`,
    })),
    wildcardTls: [
      `*.${SUBDOMAIN_ZONES.APPS}.${baseDomain}`,
      `*.${SUBDOMAIN_ZONES.PREVIEW}.${baseDomain}`,
      `*.${SUBDOMAIN_ZONES.CONSOLE}.${baseDomain}`,
      `*.${SUBDOMAIN_ZONES.RESOURCES}.${baseDomain}`,
    ],
  };
}
