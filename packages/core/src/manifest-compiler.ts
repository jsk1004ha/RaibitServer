import { DEFAULT_CONTAINER_SECURITY_CONTEXT, DEFAULT_POD_SECURITY_CONTEXT, secureContainerDefaults, splitEnvForSecret, validateServiceSecurity } from './security.ts';
import { serviceHealthProbes } from './deployment-health.ts';
import { connectionEnvForResource, injectResourceEnv } from './env-injection.ts';
import { resolveBuildStrategy } from './build-strategy.ts';
import { DEFAULT_DOMAIN, DEFAULT_PORT, SERVICE_TYPES, trustedIngressGatewayNamespace } from './constants.ts';
import { getCatalogEntry, normalizeResourceEngine } from './catalog.ts';
import { requireResourceCapability } from './resource-capabilities.ts';
import { slugify } from './ids.ts';
import { boundedDnsLabel, domainPlanForProject, serviceHostname, tenantProjectLabel } from './domain-router.ts';

type AnyRecord = Record<string, any>;

const DEFAULT_INGRESS_CUSTOM_HTTP_ERRORS = '500,502,503,504';
const TRAEFIK_MIDDLEWARE_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?@kubernetescrd$/;

export function compileProject(spec: AnyRecord = {}, filesByService: AnyRecord = {}, trustedOptions: AnyRecord = {}) {
  const organization = spec.organization || { slug: spec.organizationSlug || 'default' };
  const project = spec.project || { name: spec.name || 'project', slug: spec.slug || spec.name || 'project' };
  const projectRouteSlug = project.slug || project.name || 'project';
  const organizationRouteSlug = organization.slug || organization.name || 'org';
  const organizationNamespaceIdentity = organization.id || spec.organizationId || organizationRouteSlug;
  const projectNamespaceIdentity = project.id || spec.projectId || null;
  const projectSlug = slugify(project.slug || project.name);
  const baseDomain = spec.baseDomain || DEFAULT_DOMAIN;
  const ingressGatewayNamespace = trustedIngressGatewayNamespace(trustedOptions.ingressGatewayNamespace);
  const ingressErrorOptions = trustedIngressErrorOptions(trustedOptions);
  const namespace = tenantProjectLabel(
    organizationNamespaceIdentity,
    projectRouteSlug,
    projectNamespaceIdentity ? `${organizationNamespaceIdentity}\0${projectNamespaceIdentity}` : undefined,
  );
  const services: AnyRecord[] = spec.services || [];
  const resources: AnyRecord[] = spec.resources || [];
  const manifests: AnyRecord[] = [namespaceManifest(namespace, projectSlug)];
  const buildPlans: AnyRecord[] = [];
  const resourcePlans = resources.map((resource) => resourcePlan(resource, namespace, projectSlug));
  const resourceEnvByName = Object.fromEntries(resources.map((resource) => [resource.name, connectionEnvForResource(resource, projectSlug)]));

  for (const service of services) {
    const serviceName = kubernetesServiceName(service);
    const serviceRouteName = service.slug || service.name || serviceName;
    const fullService = {
      projectSlug,
      registry: spec.registry,
      ...service,
      name: serviceName,
    };
    const buildPlan = resolveBuildStrategy(fullService, filesByService[service.name] || filesByService[serviceName] || {});
    buildPlans.push(buildPlan);
    const serviceManifests = compileService({ namespace, projectSlug, organizationRouteSlug, projectRouteSlug, serviceRouteName, baseDomain, service: fullService, resources, resourceEnvByName, image: buildPlan.image, ingressErrorOptions });
    manifests.push(...serviceManifests);
  }

  const ignoredPrePullImages = imagePrePullList(spec, buildPlans);
  manifests.push(...networkPolicyManifests(namespace, projectSlug, services, resources, ingressGatewayNamespace));
  return {
    apiVersion: 'raibitserver.io/v1alpha1',
    kind: 'ProjectDeploymentPlan',
    metadata: {
      organization: organization.slug || organization.name || 'default',
      project: projectSlug,
      namespace,
    },
    buildPlans,
    prePullPlan: {
      enabled: false,
      images: [],
      ignoredImages: ignoredPrePullImages,
      strategy: ignoredPrePullImages.length ? 'disabled-tenant-prepull-not-supported' : 'disabled',
    },
    resourcePlans,
    domainPlan: domainPlanForProject(spec),
    manifests,
    security: {
      tenantNamespace: namespace,
      defaults: {
        podSecurityContext: DEFAULT_POD_SECURITY_CONTEXT,
        containerSecurityContext: DEFAULT_CONTAINER_SECURITY_CONTEXT,
        networkPolicy: 'deny-cross-project-and-control-plane-by-default',
      },
      findings: services.flatMap((service) => validateServiceSecurity(service).findings.map((finding) => ({ service: service.name, ...finding }))),
    },
  };
}

function compileService({ namespace, projectSlug, organizationRouteSlug, projectRouteSlug, serviceRouteName, baseDomain, service, resources, resourceEnvByName, image, ingressErrorOptions }: AnyRecord) {
  const serviceName = kubernetesServiceName(service);
  const type = service.type || SERVICE_TYPES.WEB;
  const port = Number(service.port || DEFAULT_PORT);
  const env = injectResourceEnv(service, resources, projectSlug, { resourceEnvByName });
  const { plain, secret } = splitEnvForSecret(env);
  const labels = labelsFor(projectSlug, serviceName, type);
  const out: AnyRecord[] = [];

  if (Object.keys(secret).length) out.push(secretManifest(namespace, derivedServiceObjectName(service, 'env'), labels, secret));
  if (Object.keys(plain).length) out.push(configMapManifest(namespace, derivedServiceObjectName(service, 'config'), labels, plain));

  if (type === SERVICE_TYPES.CRON) {
    out.push(cronJobManifest(namespace, service, labels, image, port, plain, secret));
    return out;
  }
  if (type === SERVICE_TYPES.JOB) {
    out.push(jobManifest(namespace, service, labels, image, port, plain, secret));
    return out;
  }

  out.push(deploymentManifest(namespace, service, labels, image, port, plain, secret));
  if ([SERVICE_TYPES.WEB, SERVICE_TYPES.PRIVATE].includes(type) && port) {
    out.push(serviceManifest(namespace, serviceName, labels, port));
  }
  if (type === SERVICE_TYPES.WEB) {
    out.push(ingressManifest(namespace, service, serviceRouteName, organizationRouteSlug, projectRouteSlug, baseDomain, labels, port, ingressErrorOptions));
  }
  if (service.scaling?.maxReplicas && Number(service.scaling.maxReplicas) > Number(service.scaling.minReplicas || 1)) {
    out.push(hpaManifest(namespace, service, service.scaling));
  }
  out.push(pdbManifest(namespace, service, labels, service.availability));
  return out;
}

function namespaceManifest(namespace: string, projectSlug: string): AnyRecord {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: namespace,
      labels: {
        'raibitserver.io/project': projectSlug,
        'pod-security.kubernetes.io/enforce': 'restricted',
      },
    },
  };
}

function labelsFor(projectSlug: string, serviceName: string, type: string): AnyRecord {
  return {
    'app.kubernetes.io/name': serviceName,
    'app.kubernetes.io/managed-by': 'raibitserver',
    'raibitserver.io/project': projectSlug,
    'raibitserver.io/service': serviceName,
    'raibitserver.io/service-type': type,
  };
}

function envRefs(plain: AnyRecord, secret: AnyRecord, secretName: string, configMapName: string): AnyRecord[] {
  const values = Object.keys(plain).map((key) => ({ name: key, valueFrom: { configMapKeyRef: { name: configMapName, key } } }));
  const secrets = Object.keys(secret).map((key) => ({ name: key, valueFrom: { secretKeyRef: { name: secretName, key } } }));
  return [...values, ...secrets];
}

function containerFor(service: AnyRecord, image: string, port: number, plain: AnyRecord, secret: AnyRecord): AnyRecord {
  const serviceName = kubernetesServiceName(service);
  const configuredRequests = service.resources?.requests || {};
  const configuredLimits = service.resources?.limits || {};
  return {
    name: serviceName,
    image,
    imagePullPolicy: 'IfNotPresent',
    ports: port ? [{ name: 'http', containerPort: port }] : [],
    env: envRefs(plain, secret, derivedServiceObjectName(service, 'env'), derivedServiceObjectName(service, 'config')),
    command: service.command || undefined,
    args: service.args || undefined,
    resources: {
      requests: {
        cpu: configuredRequests.cpu || '100m',
        memory: configuredRequests.memory || '128Mi',
        'ephemeral-storage': '64Mi',
      },
      limits: {
        cpu: configuredLimits.cpu || '500m',
        memory: configuredLimits.memory || '512Mi',
        'ephemeral-storage': '256Mi',
      },
    },
    volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
    securityContext: secureContainerDefaults(service),
    ...serviceHealthProbes(service, port),
  };
}

function podSpec(service: AnyRecord, image: string, port: number, plain: AnyRecord, secret: AnyRecord, restartPolicy = 'Always'): AnyRecord {
  return {
    securityContext: DEFAULT_POD_SECURITY_CONTEXT,
    restartPolicy,
    containers: [containerFor(service, image, port, plain, secret)],
    volumes: [{ name: 'tmp', emptyDir: { sizeLimit: '128Mi' } }],
    automountServiceAccountToken: false,
  };
}

function deploymentManifest(namespace: string, service: AnyRecord, labels: AnyRecord, image: string, port: number, plain: AnyRecord, secret: AnyRecord): AnyRecord {
  const serviceName = kubernetesServiceName(service);
  const replicas = service.sleepPolicy === 'scale-to-zero' ? 0 : Number(service.scaling?.minReplicas ?? service.replicas ?? 1);
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: serviceName, namespace, labels },
    spec: {
      replicas,
      selector: { matchLabels: { 'app.kubernetes.io/name': serviceName } },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      template: {
        metadata: { labels, annotations: { 'raibitserver.io/sleep-policy': service.sleepPolicy || 'always-on' } },
        spec: podSpec(service, image, port, plain, secret),
      },
    },
  };
}

function cronJobManifest(namespace: string, service: AnyRecord, labels: AnyRecord, image: string, port: number, plain: AnyRecord, secret: AnyRecord): AnyRecord {
  const serviceName = kubernetesServiceName(service);
  return {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: { name: serviceName, namespace, labels },
    spec: {
      schedule: service.schedule || '0 * * * *',
      concurrencyPolicy: service.concurrencyPolicy || 'Forbid',
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 3,
      jobTemplate: {
        spec: {
          backoffLimit: service.backoffLimit ?? 2,
          template: { metadata: { labels }, spec: podSpec(service, image, port, plain, secret, 'OnFailure') },
        },
      },
    },
  };
}

function jobManifest(namespace: string, service: AnyRecord, labels: AnyRecord, image: string, port: number, plain: AnyRecord, secret: AnyRecord): AnyRecord {
  const serviceName = kubernetesServiceName(service);
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: serviceName, namespace, labels },
    spec: {
      backoffLimit: service.backoffLimit ?? 1,
      template: { metadata: { labels }, spec: podSpec(service, image, port, plain, secret, 'Never') },
    },
  };
}

function serviceManifest(namespace: string, serviceName: string, labels: AnyRecord, port: number): AnyRecord {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: serviceName, namespace, labels },
    spec: {
      type: 'ClusterIP',
      selector: { 'app.kubernetes.io/name': serviceName },
      ports: [{ name: 'http', port, targetPort: 'http' }],
    },
  };
}

function ingressManifest(namespace: string, service: AnyRecord, serviceRouteName: string, organizationSlug: string, projectSlug: string, baseDomain: string, labels: AnyRecord, port: number, ingressErrorOptions: AnyRecord): AnyRecord {
  const serviceName = kubernetesServiceName(service);
  const host = serviceHostname({
    organizationSlug,
    projectSlug,
    serviceName: serviceRouteName,
    baseDomain: service.baseDomain || baseDomain || DEFAULT_DOMAIN,
    customDomain: service.domain || null,
  });
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: serviceName,
      namespace,
      labels,
      annotations: {
        'cert-manager.io/cluster-issuer': service.tlsIssuer || 'letsencrypt',
        ...(ingressErrorOptions.disabled ? {} : { 'nginx.ingress.kubernetes.io/custom-http-errors': ingressErrorOptions.customHttpErrors }),
        'traefik.ingress.kubernetes.io/router.entrypoints': 'websecure',
        ...(!ingressErrorOptions.disabled && ingressErrorOptions.middleware ? { 'traefik.ingress.kubernetes.io/router.middlewares': ingressErrorOptions.middleware } : {}),
        'raibitserver.io/hostname': host,
      },
    },
    spec: {
      tls: [{ hosts: [host], secretName: derivedServiceObjectName(service, 'tls') }],
      rules: [{ host, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: serviceName, port: { number: port } } } }] } }],
    },
  };
}

function trustedIngressErrorOptions(trustedOptions: AnyRecord): AnyRecord {
  const configuredStatuses = trustedOptions.ingressCustomHttpErrors;
  if (typeof configuredStatuses === 'string' && configuredStatuses.trim().toLowerCase() === 'disabled') {
    return { disabled: true, customHttpErrors: '', middleware: '' };
  }
  const rawStatuses = typeof configuredStatuses === 'string' && !configuredStatuses.trim()
    ? DEFAULT_INGRESS_CUSTOM_HTTP_ERRORS
    : configuredStatuses;
  const values = Array.isArray(rawStatuses)
    ? rawStatuses
    : String(rawStatuses ?? DEFAULT_INGRESS_CUSTOM_HTTP_ERRORS).split(',');
  const statuses = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))]
    .map((value) => {
      if (!/^\d{3}$/.test(value) || Number(value) < 400 || Number(value) > 599) {
        throw new Error('invalid ingress custom HTTP errors: expected comma-separated HTTP status codes from 400 through 599');
      }
      return Number(value);
    })
    .sort((left, right) => left - right);
  if (!statuses.length) {
    throw new Error('invalid ingress custom HTTP errors: at least one HTTP status code is required');
  }

  const middleware = String(trustedOptions.ingressErrorMiddleware ?? '').trim().toLowerCase();
  if (middleware && !TRAEFIK_MIDDLEWARE_PATTERN.test(middleware)) {
    throw new Error('invalid ingress error middleware: expected <namespace>-<name>@kubernetescrd');
  }
  return { disabled: false, customHttpErrors: statuses.join(','), middleware };
}

function hpaManifest(namespace: string, service: AnyRecord, scaling: AnyRecord): AnyRecord {
  const serviceName = kubernetesServiceName(service);
  return {
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: { name: derivedServiceObjectName(service, 'hpa'), namespace },
    spec: {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: serviceName },
      minReplicas: scaling.minReplicas ?? 1,
      maxReplicas: scaling.maxReplicas,
      metrics: scaling.metrics || [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }],
    },
  };
}

function pdbManifest(namespace: string, service: AnyRecord, labels: AnyRecord, availability: AnyRecord = {}): AnyRecord {
  const serviceName = kubernetesServiceName(service);
  return {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: { name: derivedServiceObjectName(service, 'pdb'), namespace, labels },
    spec: {
      minAvailable: availability.minAvailable ?? 0,
      selector: { matchLabels: { 'app.kubernetes.io/name': serviceName } },
    },
  };
}

function secretManifest(namespace: string, name: string, labels: AnyRecord, data: AnyRecord): AnyRecord {
  const providerContract = hasProviderManagedPlaceholder(data);
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace,
      labels,
      ...(providerContract ? { annotations: { 'raibitserver.io/provider-contract': 'not-live-secret' } } : {}),
    },
    type: 'Opaque',
    stringData: data,
  };
}

function hasProviderManagedPlaceholder(data: AnyRecord) {
  return Object.values(data || {}).some((value) => String(value).includes('provider-managed-'));
}

function configMapManifest(namespace: string, name: string, labels: AnyRecord, data: AnyRecord): AnyRecord {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name, namespace, labels },
    data,
  };
}

function networkPolicyManifests(namespace: string, projectSlug: string, services: AnyRecord[], resources: AnyRecord[], ingressGatewayNamespace: string): AnyRecord[] {
  const base = tenantIsolationNetworkPolicy(namespace, services, resources, ingressGatewayNamespace);
  const publicEgress = services
    .filter((service) => service.allowPublicEgress === true || service.publicEgress === true || service.egress?.publicInternet === true)
    .map((service) => servicePublicEgressPolicy(namespace, projectSlug, service));
  base.raibitserver.publicEgressServices = publicEgress.map((policy) => policy.raibitserver.service);
  return [base, ...publicEgress];
}

function tenantIsolationNetworkPolicy(namespace: string, services: AnyRecord[], resources: AnyRecord[], ingressGatewayNamespace: string): AnyRecord {
  const serviceNames = services.map((service) => kubernetesServiceName(service));
  const resourceNames = resources.map((resource) => slugify(resource.name));
  const egress: AnyRecord[] = [
    {
      to: [
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
          podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
        },
      ],
      ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }],
    },
    { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } } }] },
  ];
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'tenant-isolation', namespace },
    spec: {
      podSelector: {},
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        { from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': ingressGatewayNamespace } } }] },
      ],
      egress,
    },
    raibitserver: {
      ingressFromGatewayOnly: true,
      ingressGatewayNamespace,
      blocksSameNamespaceIngressByDefault: true,
      allowsSameNamespaceEgressToServices: serviceNames,
      allowsSameNamespaceEgressToResources: resourceNames,
      allowsDnsEgress: true,
      blocksMetadataEndpoint: true,
      blocksControlPlane: true,
      blocksCrossProject: true,
      publicEgressServices: [],
    },
  };
}

function servicePublicEgressPolicy(namespace: string, projectSlug: string, service: AnyRecord): AnyRecord {
  const serviceName = kubernetesServiceName(service);
  const labels = labelsFor(projectSlug, serviceName, 'egress-policy');
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: derivedServiceObjectName(service, 'public-egress'), namespace, labels },
    spec: {
      podSelector: { matchLabels: { 'app.kubernetes.io/name': serviceName } },
      policyTypes: ['Egress'],
      egress: [
        { to: [{ ipBlock: { cidr: '0.0.0.0/0', except: PRIVATE_IPV4_EGRESS_EXCEPTIONS } }] },
        { to: [{ ipBlock: { cidr: '::/0', except: PRIVATE_IPV6_EGRESS_EXCEPTIONS } }] },
      ],
    },
    raibitserver: {
      service: serviceName,
      publicInternetEgress: true,
      scopedToServicePodSelector: true,
      ipv4Except: PRIVATE_IPV4_EGRESS_EXCEPTIONS,
      ipv6Except: PRIVATE_IPV6_EGRESS_EXCEPTIONS,
    },
  };
}

function kubernetesServiceName(service: AnyRecord) {
  return boundedDnsLabel(service?.name || service?.slug || service?.id || 'service', 63, service?.id || service?.name || service?.slug);
}

function derivedServiceObjectName(service: AnyRecord, suffix: string) {
  const serviceName = kubernetesServiceName(service);
  return boundedDnsLabel(`${serviceName}-${suffix}`, 63, `${service?.id || serviceName}\0${suffix}`);
}

const PRIVATE_IPV4_EGRESS_EXCEPTIONS = Object.freeze(['10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16']);
const PRIVATE_IPV6_EGRESS_EXCEPTIONS = Object.freeze(['::1/128', 'fc00::/7', 'fe80::/10', 'fd00:ec2::254/128']);

function imagePrePullList(spec: AnyRecord, buildPlans: AnyRecord[]) {
  const explicit = [
    ...arrayStrings(spec.prePullImages),
    ...arrayStrings(spec.performance?.prePullImages),
    ...arrayStrings(spec.runtime?.prePullImages),
  ];
  const includeBuildOutputs = spec.performance?.prePullBuildImages === true || spec.runtime?.prePullBuildImages === true;
  const images = [
    ...explicit,
    ...(includeBuildOutputs ? buildPlans.map((plan) => plan.image) : []),
  ];
  return [...new Set(images.filter(Boolean).map(String))].slice(0, 20);
}

function arrayStrings(value: any) {
  return (Array.isArray(value) ? value : [value]).filter((item) => item !== undefined && item !== null && String(item).trim()).map((item) => String(item).trim());
}

function resourcePlan(resource: AnyRecord, namespace: string, projectSlug: string): AnyRecord {
  const engine = normalizeResourceEngine(resource.engine || resource.type);
  const capabilities = requireResourceCapability(engine, 'provision');
  const entry = getCatalogEntry(engine);
  return {
    name: slugify(resource.name),
    namespace,
    project: projectSlug,
    catalogKey: entry.key,
    displayName: entry.displayName,
    type: entry.type,
    engine: entry.engine,
    version: resource.version || entry.defaultVersion,
    provider: resource.provider || 'hybrid-managed',
    operator: entry.operator,
    plan: resource.plan || 'shared-small',
    capabilities,
    lifecycle: Object.entries(capabilities.local).filter(([, enabled]) => enabled).map(([operation]) => operation),
    env: entry.env,
  };
}
