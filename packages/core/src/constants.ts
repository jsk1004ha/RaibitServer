export const SERVICE_TYPES = Object.freeze({
  WEB: 'web',
  PRIVATE: 'private',
  WORKER: 'worker',
  CRON: 'cron',
  JOB: 'job',
});

export const SOURCE_TYPES = Object.freeze({
  GITHUB: 'github',
  ZIP: 'zip',
  IMAGE: 'image',
  LOCAL: 'local',
});

export const BUILD_MODES = Object.freeze({
  AUTO: 'auto',
  DOCKERFILE: 'dockerfile',
  BUILDPACK: 'buildpack',
  CUSTOM: 'custom',
  PREBUILT_IMAGE: 'prebuilt-image',
});

export const DEFAULT_PORT = 8080;
export const DEFAULT_REGISTRY = 'registry.raibitserver.local';
export const DEFAULT_DOMAIN = 'raibitserver.app';
export const DEFAULT_INGRESS_GATEWAY_NAMESPACE = 'ingress-nginx';

export function trustedIngressGatewayNamespace(value: unknown = DEFAULT_INGRESS_GATEWAY_NAMESPACE) {
  const namespace = String(value || DEFAULT_INGRESS_GATEWAY_NAMESPACE).trim();
  if (namespace.length > 63 || !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace)) {
    throw new Error('invalid ingress gateway namespace: expected a Kubernetes DNS label');
  }
  return namespace;
}

export const WORKLOAD_PIPELINE = Object.freeze([
  'source',
  'build',
  'image',
  'registry',
  'kubernetes-workload',
  'network-route',
  'domain-and-tls',
]);
