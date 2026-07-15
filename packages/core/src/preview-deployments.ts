import { DEFAULT_DOMAIN } from './constants.ts';
import { boundedDnsLabel, identityDnsLabel, serviceHostname, tenantProjectLabel } from './domain-router.ts';

type AnyRecord = Record<string, any>;

export function previewKey(pullRequestNumber: any) {
  const number = Number(pullRequestNumber || 0);
  return `pr-${Number.isFinite(number) && number > 0 ? number : 0}`;
}

export function previewWorkloadName(service: AnyRecord = {}, pullRequestNumber: any) {
  const identity = previewIdentity({ service, pullRequestNumber });
  return identity.workloadName;
}

export function previewRuntimePlan(input: AnyRecord = {}) {
  const {
    service,
    project,
    pullRequestNumber,
    preview,
    serviceName,
    projectSlug,
    namespace,
    workloadName,
    organizationRouteSlug,
    projectRouteSlug,
    serviceRouteName,
  } = previewIdentity(input);
  const baseDomain = input.baseDomain || service.baseDomain || project.baseDomain || DEFAULT_DOMAIN;
  const host = serviceHostname({ organizationSlug: organizationRouteSlug, projectSlug: projectRouteSlug, serviceName: serviceRouteName, baseDomain, preview });
  const deploymentId = input.deploymentId || input.deployment?.id || null;
  const labels = {
    'app.kubernetes.io/name': workloadName,
    'app.kubernetes.io/managed-by': 'raibitserver',
    'raibitserver.io/project': projectSlug,
    'raibitserver.io/service': serviceName,
    'raibitserver.io/preview': 'true',
    'raibitserver.io/pull-request': String(Number.isFinite(pullRequestNumber) ? pullRequestNumber : 0),
    ...(deploymentId ? { 'raibitserver.io/deployment': String(deploymentId) } : {}),
  };
  return {
    kind: 'PreviewDeploymentPlan',
    action: input.action || 'apply',
    safe: true,
    pullRequestNumber: Number.isFinite(pullRequestNumber) ? pullRequestNumber : 0,
    deploymentId,
    url: `https://${host}`,
    host,
    kubernetes: {
      namespace,
      workloadName,
      deploymentName: workloadName,
      serviceName: workloadName,
      ingressName: workloadName,
      labels,
      cleanupSelector: Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(','),
    },
  };
}

function previewIdentity(input: AnyRecord = {}) {
  const service = input.service || {};
  const project = input.project || {};
  const organization = input.organization || {};
  const pullRequestNumber = Number(input.pullRequestNumber || input.prNumber || 0);
  const preview = previewKey(pullRequestNumber);
  const serviceRouteName = service.slug || service.name || service.id || 'service';
  const projectRouteSlug = project.slug || project.name || project.id || 'project';
  const organizationRouteSlug = organization.slug || organization.name || project.organizationSlug || project.organizationId || 'org';
  const organizationNamespaceIdentity = organization.id || project.organizationId || organizationRouteSlug;
  const projectNamespaceIdentity = project.id || null;
  const serviceName = boundedDnsLabel(serviceRouteName, 63, service.id || serviceRouteName);
  const projectSlug = boundedDnsLabel(projectRouteSlug, 63, project.id || projectRouteSlug);
  const namespace = tenantProjectLabel(
    organizationNamespaceIdentity,
    projectRouteSlug,
    projectNamespaceIdentity ? `${organizationNamespaceIdentity}\0${projectNamespaceIdentity}` : undefined,
  );
  const deploymentIdentity = input.deploymentId || input.deployment?.id || null;
  const workloadName = deploymentIdentity
    ? identityDnsLabel(`${preview}-${serviceName}`, deploymentIdentity)
    : boundedDnsLabel(`${preview}-${serviceName}`);
  return {
    service,
    project,
    pullRequestNumber,
    preview,
    serviceName,
    projectSlug,
    namespace,
    workloadName,
    organizationRouteSlug,
    projectRouteSlug,
    serviceRouteName,
  };
}
