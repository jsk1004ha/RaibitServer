const API_NAME = 'raibitserver-api';
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DIGEST_IMAGE = /@sha256:[a-f0-9]{64}$/;
const field = '{{"\\t"}}', row = '{{"\\n"}}';

export const KUBE_PROJECTIONS = Object.freeze({
  deployments: `go-template={{range .items}}{{.metadata.namespace}}${field}{{.metadata.name}}${field}{{.metadata.uid}}${field}{{index .metadata.labels "app.kubernetes.io/name"}}${field}{{index .metadata.labels "app.kubernetes.io/instance"}}${field}{{index .metadata.labels "app.kubernetes.io/component"}}${field}{{.spec.replicas}}${field}{{.status.readyReplicas}}${field}{{index .spec.selector.matchLabels "app.kubernetes.io/name"}}${field}{{index .spec.selector.matchLabels "app.kubernetes.io/instance"}}${field}{{range .spec.template.spec.containers}}{{if eq .name "api"}}{{.image}}{{end}}{{end}}${row}{{end}}`,
  services: `go-template={{range .items}}{{.metadata.namespace}}${field}{{.metadata.name}}${field}{{.metadata.uid}}${field}{{index .metadata.labels "app.kubernetes.io/name"}}${field}{{index .metadata.labels "app.kubernetes.io/instance"}}${field}{{.spec.type}}${field}{{.spec.clusterIP}}${field}{{index .spec.selector "app.kubernetes.io/name"}}${field}{{index .spec.selector "app.kubernetes.io/instance"}}${field}{{len .spec.selector}}${field}{{len .spec.ports}}${field}{{range .spec.ports}}{{.name}}|{{.port}}|{{.targetPort}}|{{.protocol}};{{end}}${row}{{end}}`,
  service: `go-template={{.metadata.namespace}}${field}{{.metadata.name}}${field}{{.metadata.uid}}${field}{{index .metadata.labels "app.kubernetes.io/name"}}${field}{{index .metadata.labels "app.kubernetes.io/instance"}}${field}{{.spec.type}}${field}{{.spec.clusterIP}}${field}{{index .spec.selector "app.kubernetes.io/name"}}${field}{{index .spec.selector "app.kubernetes.io/instance"}}${field}{{len .spec.selector}}${field}{{len .spec.ports}}${field}{{range .spec.ports}}{{.name}}|{{.port}}|{{.targetPort}}|{{.protocol}};{{end}}${row}`,
  endpoints: `go-template={{range .items}}{{.metadata.namespace}}${field}{{.metadata.name}}${field}{{.metadata.uid}}${field}{{index .metadata.labels "app.kubernetes.io/name"}}${field}{{index .metadata.labels "app.kubernetes.io/instance"}}${field}{{range .subsets}}{{range .addresses}}{{.targetRef.kind}}|{{.targetRef.namespace}}|{{.targetRef.name}}|{{.targetRef.uid}};{{end}}{{end}}${field}{{range .subsets}}{{range .ports}}{{.name}}|{{.port}};{{end}}{{end}}${row}{{end}}`,
  pod: `go-template={{.metadata.namespace}}${field}{{.metadata.name}}${field}{{.metadata.uid}}${field}{{index .metadata.labels "raibitserver.io/run-id"}}${field}{{range .status.conditions}}{{if eq .type "Ready"}}{{.status}}{{end}}{{end}}${row}`,
  policy: `go-template={{.metadata.namespace}}${field}{{.metadata.name}}${field}{{.metadata.uid}}${field}{{index .metadata.labels "raibitserver.io/run-id"}}${row}`,
  metadata: `go-template={{.metadata.namespace}}${field}{{.metadata.name}}${field}{{index .metadata.labels "raibitserver.io/run-id"}}${row}`,
});

export class EvidenceClientError extends Error {
  constructor(reason) { super(reason); this.name = 'EvidenceClientError'; this.reason = reason; }
}
function fail(reason) { throw new EvidenceClientError(reason); }
async function query(executeFile, args, reason, timeoutMs = 30_000) {
  const result = await executeFile('kubectl', args, { timeoutMs });
  if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') fail(reason);
  return result.stdout;
}
function rows(text, width, reason, optional = false) {
  if (typeof text !== 'string' || /[\r\0]/.test(text)) fail(reason);
  if (!text.trim()) return optional ? [] : fail(reason);
  const parsed = text.trimEnd().split('\n').map(line => line.split('\t'));
  if (parsed.some(parts => parts.length !== width || parts.some(part => part.includes('\n')))) fail(reason);
  return parsed;
}
function exact(text, width, reason) {
  const parsed = rows(text, width, reason);
  if (parsed.length !== 1) fail('ambiguous_api_target');
  return parsed[0];
}
function selector(releaseName) { return `app.kubernetes.io/name=${API_NAME},app.kubernetes.io/instance=${releaseName}`; }

export async function discoverApiTarget(runtimeRef, executeFile) {
  const common = ['-n', runtimeRef.namespace, '-l', selector(runtimeRef.releaseName), '-o'];
  const [deploymentText, serviceText, endpointText] = await Promise.all([
    query(executeFile, ['get', 'deployments', ...common, KUBE_PROJECTIONS.deployments], 'api_discovery_failed'),
    query(executeFile, ['get', 'services', ...common, KUBE_PROJECTIONS.services], 'api_discovery_failed'),
    query(executeFile, ['get', 'endpoints', ...common, KUBE_PROJECTIONS.endpoints], 'api_discovery_failed'),
  ]);
  const deployment = exact(deploymentText, 11, 'api_discovery_failed');
  const service = exact(serviceText, 12, 'api_discovery_failed');
  const endpoint = exact(endpointText, 7, 'api_discovery_failed');
  if (deployment[0] !== runtimeRef.namespace || deployment[3] !== API_NAME || deployment[4] !== runtimeRef.releaseName || deployment[5] !== 'api'
    || deployment[6] !== deployment[7] || !/^[1-9][0-9]*$/.test(deployment[7]) || deployment[8] !== API_NAME || deployment[9] !== runtimeRef.releaseName) fail('api_not_ready');
  if (!DIGEST_IMAGE.test(deployment[10])) fail('api_image_not_digest_pinned');
  const ports = service[11].split(';').filter(Boolean).map(value => value.split('|'));
  if (service[0] !== runtimeRef.namespace || service[3] !== API_NAME || service[4] !== runtimeRef.releaseName || service[5] !== 'ClusterIP'
    || !service[6] || service[7] !== API_NAME || service[8] !== runtimeRef.releaseName || service[9] !== '2' || service[10] !== '1'
    || ports.length !== 1 || ports[0].length !== 4 || ports[0][0] !== 'http' || ports[0][1] !== '3000' || ports[0][2] !== 'http' || ports[0][3] !== 'TCP') fail('invalid_api_service');
  const addresses = endpoint[5].split(';').filter(Boolean).map(value => value.split('|'));
  const endpointPorts = endpoint[6].split(';').filter(Boolean).map(value => value.split('|'));
  if (endpoint[0] !== runtimeRef.namespace || endpoint[1] !== service[1] || endpoint[3] !== API_NAME || endpoint[4] !== runtimeRef.releaseName
    || !addresses.length || addresses.some(value => value.length !== 4 || value[0] !== 'Pod' || value[1] !== runtimeRef.namespace || !DNS_LABEL.test(value[2]) || !value[3])
    || endpointPorts.length !== 1 || endpointPorts[0][0] !== 'http' || endpointPorts[0][1] !== '3000') fail('api_not_ready');
  return Object.freeze({ image: deployment[10], serviceName: service[1], serviceUid: service[2], serviceProjection: service.join('\t') });
}

export async function readPod(executeFile, namespace, name, reason) {
  const value = exact(await query(executeFile, ['get', 'pod', name, '-n', namespace, '-o', KUBE_PROJECTIONS.pod], reason), 5, reason);
  return Object.freeze({ namespace: value[0], name: value[1], uid: value[2], runId: value[3], ready: value[4] === 'True' });
}
export async function readPolicy(executeFile, namespace, name, reason) {
  const value = exact(await query(executeFile, ['get', 'networkpolicy', name, '-n', namespace, '-o', KUBE_PROJECTIONS.policy], reason), 4, reason);
  return Object.freeze({ namespace: value[0], name: value[1], uid: value[2], runId: value[3] });
}
export async function readService(executeFile, namespace, name, reason) {
  const text = await query(executeFile, ['get', 'service', name, '-n', namespace, '-o', KUBE_PROJECTIONS.service], reason);
  const value = exact(text, 12, reason);
  return Object.freeze({ namespace: value[0], name: value[1], uid: value[2], releaseName: value[4], projection: value.join('\t') });
}
export async function inspectMetadata(executeFile, kind, namespace, name) {
  const text = await query(executeFile, ['get', kind, name, '-n', namespace, '--ignore-not-found=true', '-o', KUBE_PROJECTIONS.metadata], 'authenticated_client_partial_cleanup_failed', 10_000);
  const parsed = rows(text, 3, 'authenticated_client_partial_cleanup_failed', true);
  if (parsed.length > 1) fail('authenticated_client_partial_cleanup_failed');
  return parsed[0] ? Object.freeze({ namespace: parsed[0][0], name: parsed[0][1], runId: parsed[0][2] }) : null;
}
