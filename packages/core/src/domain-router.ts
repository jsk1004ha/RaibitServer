import crypto from 'node:crypto';
import { DEFAULT_DOMAIN } from './constants.ts';
import { slugify } from './ids.ts';

type AnyRecord = Record<string, any>;

// PostgreSQL stores pull-request numbers as a signed 32-bit integer. Reserving
// ten digits keeps the same bounded route identity valid for every PR number,
// so replacing {number} in preview patterns produces the runtime hostname.
const MAX_PREVIEW_ROUTE_IDENTITY_LENGTH = 49;

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

export function tenantProjectLabel(organizationSlug: any, projectSlug: any, stableIdentity?: any) {
  return boundedDnsLabel(tenantRouteIdentity(organizationSlug, projectSlug), 63, stableIdentity);
}

export function serviceHostname({ organizationSlug = 'org', projectSlug = 'project', serviceName = 'web', baseDomain = DEFAULT_DOMAIN, customDomain = null, preview = null }: AnyRecord = {}) {
  if (customDomain) return customDomain;
  const routeIdentity = serviceRouteIdentity(organizationSlug, projectSlug, serviceName);
  const label = preview
    ? previewRouteLabel(normalizeRoutePart(preview), routeIdentity)
    : boundedDnsLabel(routeIdentity);
  const zone = preview ? SUBDOMAIN_ZONES.PREVIEW : SUBDOMAIN_ZONES.APPS;
  return `${label}.${zone}.${baseDomain}`;
}

export function serviceConsoleHostname({ organizationSlug = 'org', projectSlug = 'project', serviceName = 'service', baseDomain = DEFAULT_DOMAIN }: AnyRecord = {}) {
  const label = boundedDnsLabel(`${tenantRouteIdentity(organizationSlug, projectSlug)}-${normalizeRoutePart(serviceName)}`);
  return `${label}.${SUBDOMAIN_ZONES.CONSOLE}.${baseDomain}`;
}

export function resourceConsoleHostname({ organizationSlug = 'org', projectSlug = 'project', resourceName = 'resource', baseDomain = DEFAULT_DOMAIN }: AnyRecord = {}) {
  const label = boundedDnsLabel(`${tenantRouteIdentity(organizationSlug, projectSlug)}-${normalizeRoutePart(resourceName)}`);
  return `${label}.${SUBDOMAIN_ZONES.RESOURCES}.${baseDomain}`;
}

export function projectConsoleHostname({ organizationSlug = 'org', projectSlug = 'project', baseDomain = DEFAULT_DOMAIN }: AnyRecord = {}) {
  return `${boundedDnsLabel(tenantRouteIdentity(organizationSlug, projectSlug))}.${SUBDOMAIN_ZONES.CONSOLE}.${baseDomain}`;
}

export function workspaceConsoleHostname({ organizationSlug = 'org', baseDomain = DEFAULT_DOMAIN }: AnyRecord = {}) {
  return `${boundedDnsLabel(normalizeRoutePart(organizationSlug))}.${SUBDOMAIN_ZONES.CONSOLE}.${baseDomain}`;
}

export function internalServiceHostname({ projectSlug = 'project', serviceName = 'service' }: AnyRecord = {}) {
  return `${slugify(serviceName)}.${slugify(projectSlug)}.svc.cluster.local`;
}

export function domainPlanForProject(spec: AnyRecord = {}) {
  const organization = spec.organization || { slug: spec.organizationSlug || 'default' };
  const project = spec.project || { name: spec.name || 'project', slug: spec.slug || spec.name || 'project' };
  const organizationRouteSlug = organization.slug || organization.name || 'org';
  const projectRouteSlug = project.slug || project.name || 'project';
  const organizationSlug = slugify(organizationRouteSlug);
  const projectSlug = slugify(projectRouteSlug);
  const baseDomain = spec.baseDomain || DEFAULT_DOMAIN;
  const services = spec.services || [];
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
    workspace: workspaceConsoleHostname({ organizationSlug: organizationRouteSlug, baseDomain }),
    project: projectConsoleHostname({ organizationSlug: organizationRouteSlug, projectSlug: projectRouteSlug, baseDomain }),
    services: services.map((service) => ({
      name: slugify(service.name),
      type: service.type || 'web',
      publicHostname: service.type === 'web' || !service.type
        ? serviceHostname({ organizationSlug: organizationRouteSlug, projectSlug: projectRouteSlug, serviceName: service.name, baseDomain, customDomain: service.domain || null })
        : null,
      previewPattern: previewHostnamePattern({ organizationSlug: organizationRouteSlug, projectSlug: projectRouteSlug, serviceName: service.name, publicService: isPublicWebService(service), baseDomain }),
      consoleHostname: serviceConsoleHostname({ organizationSlug: organizationRouteSlug, projectSlug: projectRouteSlug, serviceName: service.name, baseDomain }),
      internalHostname: internalServiceHostname({ projectSlug, serviceName: service.name }),
    })),
    resources: (spec.resources || []).map((resource) => ({
      name: slugify(resource.name),
      engine: resource.engine,
      consoleHostname: resourceConsoleHostname({ organizationSlug: organizationRouteSlug, projectSlug: projectRouteSlug, resourceName: resource.name, baseDomain }),
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

function isPublicWebService(service: AnyRecord) {
  return !service.type || String(service.type).toLowerCase() === 'web';
}

function previewHostnamePattern({ organizationSlug, projectSlug, serviceName, publicService, baseDomain }: AnyRecord) {
  const prefix = 'pr-{number}-';
  const identity = publicService
    ? serviceRouteIdentity(organizationSlug, projectSlug, serviceName)
    : tenantRouteIdentity(organizationSlug, projectSlug);
  const routeLabel = boundedDnsLabel(identity, MAX_PREVIEW_ROUTE_IDENTITY_LENGTH);
  return `${prefix}${routeLabel}.${SUBDOMAIN_ZONES.PREVIEW}.${baseDomain}`;
}

function previewRouteLabel(preview: string, routeIdentity: string) {
  const identityLimit = Math.min(MAX_PREVIEW_ROUTE_IDENTITY_LENGTH, 63 - preview.length - 1);
  if (identityLimit <= 0) return boundedDnsLabel(`${preview}-${routeIdentity}`);
  return `${preview}-${boundedDnsLabel(routeIdentity, identityLimit)}`;
}

function tenantRouteIdentity(organizationSlug: any, projectSlug: any) {
  return `${normalizeRoutePart(organizationSlug)}--${normalizeRoutePart(projectSlug)}`;
}

function serviceRouteIdentity(organizationSlug: any, projectSlug: any, serviceName: any) {
  const tenant = tenantRouteIdentity(organizationSlug, projectSlug);
  const service = normalizeRoutePart(serviceName);
  return service === 'web' ? tenant : `${tenant}--${service}`;
}

function normalizeRoutePart(value: any) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

export function boundedDnsLabel(value: any, limit = 63, stableIdentity?: any) {
  const normalized = normalizeRoutePart(value);
  if (normalized.length <= limit) return normalized;
  const identity = String(stableIdentity ?? '').trim() || normalized;
  const suffix = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12);
  const base = normalized.slice(0, Math.max(0, limit - suffix.length - 1)).replace(/-+$/g, '');
  return base ? `${base}-${suffix}` : suffix.slice(0, limit);
}

export function identityDnsLabel(value: any, stableIdentity: any, limit = 63) {
  if (limit <= 0) return 'item';
  let normalized = normalizeRoutePart(value);
  const identity = String(stableIdentity ?? '').trim() || normalized;
  const suffix = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12);
  if (limit <= suffix.length) return suffix.slice(0, limit);
  normalized = normalized.slice(0, limit - suffix.length - 1).replace(/-+$/g, '');
  return normalized ? `${normalized}-${suffix}` : suffix.slice(0, limit);
}
