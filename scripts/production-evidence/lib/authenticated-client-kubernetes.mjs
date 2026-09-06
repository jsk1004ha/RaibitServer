const API_NAME = 'raibitserver-api';
const CLIENT_NAME = 'raibitserver-evidence-client';
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const KUBE_UID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const DIGEST_IMAGE = /@sha256:[a-f0-9]{64}$/;
const field = '{{"\\t"}}', row = '{{"\\n"}}';

export const KUBE_PROJECTIONS = Object.freeze({
  deployments: `go-template={{range .items}}{{.metadata.namespace}}${field}{{.metadata.name}}${field}{{.metadata.uid}}${field}{{index .metadata.labels "app.kubernetes.io/name"}}${field}{{index .metadata.labels "app.kubernetes.io/instance"}}${field}{{index .metadata.labels "app.kubernetes.io/component"}}${field}{{.spec.replicas}}${field}{{.status.readyReplicas}}${field}{{index .spec.selector.matchLabels "app.kubernetes.io/name"}}${field}{{index .spec.selector.matchLabels "app.kubernetes.io/instance"}}${field}{{range .spec.template.spec.containers}}{{if eq .name "api"}}{{.image}}{{end}}{{end}}${row}{{end}}`,
  services: `go-template={{range .items}}{{.metadata.namespace}}${field}{{.metadata.name}}${field}{{.metadata.uid}}${field}{{index .metadata.labels "app.kubernetes.io/name"}}${field}{{index .metadata.labels "app.kubernetes.io/instance"}}${field}{{.spec.type}}${field}{{.spec.clusterIP}}${field}{{index .spec.selector "app.kubernetes.io/name"}}${field}{{index .spec.selector "app.kubernetes.io/instance"}}${field}{{len .spec.selector}}${field}{{len .spec.ports}}${field}{{range .spec.ports}}{{.name}}|{{.port}}|{{.targetPort}}|{{.protocol}};{{end}}${row}{{end}}`,
  service: `go-template={{.metadata.namespace}}${field}{{.metadata.name}}${field}{{.metadata.uid}}${field}{{index .metadata.labels "app.kubernetes.io/name"}}${field}{{index .metadata.labels "app.kubernetes.io/instance"}}${field}{{.spec.type}}${field}{{.spec.clusterIP}}${field}{{index .spec.selector "app.kubernetes.io/name"}}${field}{{index .spec.selector "app.kubernetes.io/instance"}}${field}{{len .spec.selector}}${field}{{len .spec.ports}}${field}{{range .spec.ports}}{{.name}}|{{.port}}|{{.targetPort}}|{{.protocol}};{{end}}${row}`,
  endpoints: `go-template={{range .items}}{{.metadata.namespace}}${field}{{.metadata.name}}${field}{{.metadata.uid}}${field}{{index .metadata.labels "app.kubernetes.io/name"}}${field}{{index .metadata.labels "app.kubernetes.io/instance"}}${field}{{range .subsets}}{{range .addresses}}{{.targetRef.kind}}|{{.targetRef.namespace}}|{{.targetRef.name}}|{{.targetRef.uid}};{{end}}{{end}}${field}{{range .subsets}}{{range .ports}}{{.name}}|{{.port}};{{end}}{{end}}${row}{{end}}`,
  pod: `go-template={{.metadata.namespace}}${field}{{.metadata.name}}${field}{{.metadata.uid}}${field}{{.metadata.resourceVersion}}${field}{{index .metadata.labels "raibitserver.io/run-id"}}${field}{{range .status.conditions}}{{if eq .type "Ready"}}{{.status}}{{end}}{{end}}${row}`,
  policy: `go-template={{.metadata.namespace}}${field}{{.metadata.name}}${field}{{.metadata.uid}}${field}{{index .metadata.labels "raibitserver.io/run-id"}}${row}`,
  identity: `go-template={{.metadata.namespace}}${field}{{.metadata.name}}${field}{{.metadata.uid}}${field}{{.metadata.resourceVersion}}${field}{{index .metadata.labels "raibitserver.io/run-id"}}${field}{{index .metadata.labels "app.kubernetes.io/name"}}${field}{{len .metadata.labels}}${row}`,
  policySpec: 'json',
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
function parseJson(text, reason) {
  try { return JSON.parse(text); }
  catch (error) { if (error instanceof SyntaxError) fail(reason); throw error; }
}
function hasSensitiveKey(value) {
  if (Array.isArray(value)) return value.some(hasSensitiveKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => /^(?:env|data|stringData)$/i.test(key)
    || /token|secret|password|credential|authorization|cookie|api.?key|private.?key/i.test(key) || hasSensitiveKey(child));
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function stdinJson(value, reason, maxBytes) {
  const stdin = `${JSON.stringify(canonical(value))}\n`;
  if (Buffer.byteLength(stdin) > maxBytes) fail(reason);
  return stdin;
}
function selector(releaseName) { return `app.kubernetes.io/name=${API_NAME},app.kubernetes.io/instance=${releaseName}`; }

export function evidenceClientNetworkPolicy({ name, namespace, runId, releaseName }) {
  const labels = { 'app.kubernetes.io/name': CLIENT_NAME, 'raibitserver.io/run-id': runId };
  return { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: `${name}-egress`, namespace, labels }, spec: { podSelector: { matchLabels: labels }, policyTypes: ['Egress'], egress: [
    { to: [{ podSelector: { matchLabels: { 'app.kubernetes.io/name': API_NAME, 'app.kubernetes.io/instance': releaseName } } }], ports: [{ protocol: 'TCP', port: 3000 }] },
    { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
  ] } };
}

export function evidenceClientPod({ name, namespace, runId, image, host, bootstrap, credentials }) {
  const labels = { 'app.kubernetes.io/name': CLIENT_NAME, 'raibitserver.io/run-id': runId };
  const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace, labels }, spec: {
    automountServiceAccountToken: false, enableServiceLinks: false, hostNetwork: false, hostPID: false, hostIPC: false, restartPolicy: 'Never', terminationGracePeriodSeconds: 1,
    securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
    containers: [{ name: 'client', image, imagePullPolicy: 'IfNotPresent', command: ['node'], args: ['-e', bootstrap, host],
      env: [{ name: credentials.emailKey, valueFrom: { secretKeyRef: { name: credentials.secretName, key: credentials.emailKey, optional: false } } },
        { name: credentials.passwordKey, valueFrom: { secretKeyRef: { name: credentials.secretName, key: credentials.passwordKey, optional: false } } }],
      readinessProbe: { exec: { command: ['node', '-e', "require('node:fs').accessSync('/session/ready')"] }, periodSeconds: 1, timeoutSeconds: 1, failureThreshold: 60 },
      resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '100m', memory: '128Mi' } },
      securityContext: { runAsNonRoot: true, runAsUser: 10001, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
      volumeMounts: [{ name: 'session', mountPath: '/session' }, { name: 'tmp', mountPath: '/tmp' }],
    }], volumes: [{ name: 'session', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } }, { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } }],
  } };
  const container = pod.spec.containers[0];
  if (pod.spec.automountServiceAccountToken !== false || pod.spec.serviceAccountName !== undefined || pod.spec.containers.length !== 1
    || pod.spec.volumes.length !== 2 || pod.spec.volumes.some(volume => !volume.emptyDir)
    || container.volumeMounts.length !== 2 || container.volumeMounts.some(mount => !['/session', '/tmp'].includes(mount.mountPath))) fail('invalid_authenticated_client_input');
  return pod;
}

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
  const value = exact(await query(executeFile, ['get', 'pod', name, '-n', namespace, '-o', KUBE_PROJECTIONS.pod], reason), 6, reason);
  if (!KUBE_UID.test(value[3])) fail(reason);
  return Object.freeze({ namespace: value[0], name: value[1], uid: value[2], resourceVersion: value[3], runId: value[4], ready: value[5] === 'True' });
}
export async function readPolicy(executeFile, namespace, name, reason) {
  const value = exact(await query(executeFile, ['get', 'networkpolicy', name, '-n', namespace, '-o', KUBE_PROJECTIONS.policy], reason), 4, reason);
  return Object.freeze({ namespace: value[0], name: value[1], uid: value[2], runId: value[3] });
}
export async function createKubernetesObject(executeFile, manifest, reason) {
  const result = await executeFile('kubectl', ['create', '-f', '-', '-o', KUBE_PROJECTIONS.identity], { timeoutMs: 30_000, stdin: stdinJson(manifest, reason, 256 * 1024) });
  if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') fail(reason);
  const value = exact(result.stdout, 7, reason);
  if (!DNS_LABEL.test(value[0]) || !DNS_LABEL.test(value[1]) || !KUBE_UID.test(value[2]) || !KUBE_UID.test(value[3]) || !value[4] || value[5] !== CLIENT_NAME || value[6] !== '2') fail(reason);
  return Object.freeze({ namespace: value[0], name: value[1], uid: value[2], resourceVersion: value[3], runId: value[4] });
}
export async function verifyNetworkPolicy(executeFile, expected, identity, reason) {
  const text = await query(executeFile, ['get', 'networkpolicy', expected.metadata.name, '-n', expected.metadata.namespace, `-o=${KUBE_PROJECTIONS.policySpec}`], reason);
  if (Buffer.byteLength(text) > 256 * 1024) fail(reason);
  const resource = parseJson(text, reason);
  if (!resource || typeof resource !== 'object' || Array.isArray(resource) || hasSensitiveKey(resource)
    || resource.apiVersion !== 'networking.k8s.io/v1' || resource.kind !== 'NetworkPolicy'
    || !resource.metadata || typeof resource.metadata !== 'object' || Array.isArray(resource.metadata)
    || !resource.metadata.labels || typeof resource.metadata.labels !== 'object' || Array.isArray(resource.metadata.labels)
    || !resource.spec || typeof resource.spec !== 'object' || Array.isArray(resource.spec)) fail(reason);
  const value = { namespace: resource.metadata.namespace, name: resource.metadata.name, uid: resource.metadata.uid,
    resourceVersion: resource.metadata.resourceVersion, labels: resource.metadata.labels, spec: resource.spec };
  if (value.namespace !== expected.metadata.namespace || value.name !== expected.metadata.name || value.uid !== identity.uid || !KUBE_UID.test(value.resourceVersion ?? '')
    || (identity.resourceVersion && value.resourceVersion !== identity.resourceVersion)
    || JSON.stringify(canonical(value.labels)) !== JSON.stringify(canonical(expected.metadata.labels))
    || JSON.stringify(canonical(value.spec)) !== JSON.stringify(canonical(expected.spec))) fail(reason);
  return Object.freeze({ namespace: value.namespace, name: value.name, uid: value.uid, resourceVersion: value.resourceVersion,
    runId: value.labels['raibitserver.io/run-id'] });
}
export async function readService(executeFile, namespace, name, reason) {
  const text = await query(executeFile, ['get', 'service', name, '-n', namespace, '-o', KUBE_PROJECTIONS.service], reason);
  const value = exact(text, 12, reason);
  return Object.freeze({ namespace: value[0], name: value[1], uid: value[2], releaseName: value[4], projection: value.join('\t') });
}
export async function inspectIdentity(executeFile, kind, namespace, name, reason) {
  const text = await query(executeFile, ['get', kind, name, '-n', namespace, '--ignore-not-found=true', '-o', KUBE_PROJECTIONS.identity], reason, 10_000);
  const parsed = rows(text, 7, reason, true);
  if (parsed.length > 1) fail(reason);
  if (!parsed[0]) return null;
  if (!DNS_LABEL.test(parsed[0][0]) || !DNS_LABEL.test(parsed[0][1]) || !KUBE_UID.test(parsed[0][2]) || !KUBE_UID.test(parsed[0][3]) || !parsed[0][4] || parsed[0][5] !== CLIENT_NAME || parsed[0][6] !== '2') fail(reason);
  return Object.freeze({ namespace: parsed[0][0], name: parsed[0][1], uid: parsed[0][2], resourceVersion: parsed[0][3], runId: parsed[0][4] });
}

export async function deleteOwnedKubernetesObjects(executeFile, objects, reason) {
  objects = [...objects].sort((left, right) => Number(left.kind === 'NetworkPolicy') - Number(right.kind === 'NetworkPolicy'));
  const observed = await Promise.all(objects.map(object => inspectIdentity(executeFile, object.kind === 'Pod' ? 'pod' : 'networkpolicy', object.namespace, object.name, reason)));
  const mismatch = (object, current) => current && (current.namespace !== object.namespace || current.name !== object.name || current.uid !== object.uid
    || current.resourceVersion !== object.resourceVersion || current.runId !== object.runId);
  if (objects.some((object, index) => mismatch(object, observed[index]))) fail(reason);
  for (let index = 0; index < objects.length; index++) {
    const object = objects[index];
    if (!observed[index]) continue;
    const current = await inspectIdentity(executeFile, object.kind === 'Pod' ? 'pod' : 'networkpolicy', object.namespace, object.name, reason);
    if (!current || mismatch(object, current)) fail(reason);
    const resource = object.kind === 'Pod' ? 'pod' : object.kind === 'NetworkPolicy' ? 'networkpolicy' : fail(reason);
    if (!DNS_LABEL.test(object.namespace) || !DNS_LABEL.test(object.name) || !KUBE_UID.test(object.uid) || !KUBE_UID.test(object.resourceVersion)) fail(reason);
    const apiPath = object.kind === 'Pod' ? `/api/v1/namespaces/${object.namespace}/pods/${object.name}`
      : `/apis/networking.k8s.io/v1/namespaces/${object.namespace}/networkpolicies/${object.name}`;
    const deleteOptions = { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: object.uid, resourceVersion: object.resourceVersion } };
    const deleted = await executeFile('kubectl', ['delete', '--raw', apiPath, '-f', '-'], { timeoutMs: 30_000, stdin: stdinJson(deleteOptions, reason, 4 * 1024) });
    if (!deleted || typeof deleted.stdout !== 'string' || typeof deleted.stderr !== 'string' || !Number.isInteger(deleted.exitCode)) fail(reason);
    if (deleted.exitCode === 0) await executeFile('kubectl', ['wait', '--for=delete', `${resource}/${object.name}`, '-n', object.namespace, '--timeout=30s'], { timeoutMs: 35_000 });
    const remaining = await inspectIdentity(executeFile, resource, object.namespace, object.name, reason);
    if (remaining) fail(reason);
  }
}

export function deleteEvidenceClientPair(executeFile, descriptor, runId, reason) {
  return deleteOwnedKubernetesObjects(executeFile, [
    { kind: 'Pod', namespace: descriptor.namespace, name: descriptor.podName, uid: descriptor.podUid, resourceVersion: descriptor.podResourceVersion, runId },
    { kind: 'NetworkPolicy', namespace: descriptor.namespace, name: `${descriptor.podName}-egress`, uid: descriptor.networkPolicyUid, resourceVersion: descriptor.networkPolicyResourceVersion, runId },
  ], reason);
}
