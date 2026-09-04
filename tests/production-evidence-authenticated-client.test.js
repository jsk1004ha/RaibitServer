import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertRedacted } from '../scripts/production-evidence/lib/operator-inputs.mjs';
import { KUBE_PROJECTIONS } from '../scripts/production-evidence/lib/authenticated-client-kubernetes.mjs';
import { orderCleanupInventory } from '../scripts/production-evidence/lib/orchestrator.mjs';
import { createRunnerContext } from '../scripts/production-evidence/lib/runner-context.mjs';
import { parseStepResult } from '../scripts/production-evidence/lib/step-contract.mjs';
import {
  EvidenceClientError,
  createAuthenticatedEvidenceClient,
  executeAuthenticatedEvidenceRequest,
  validateEvidenceOperatorCredentials,
} from '../scripts/production-evidence/lib/authenticated-client.mjs';

const NOW = '2026-09-04T00:00:00.000Z';
const RUN_ID = 'run-27-safe';
const RUN_LABEL = 'raibitserver.io/run-id';
const EMAIL_KEY = 'RAIBITSERVER_EVIDENCE_OPERATOR_EMAIL';
const PASSWORD_KEY = 'RAIBITSERVER_EVIDENCE_OPERATOR_PASSWORD';
const runtimeRef = Object.freeze({ namespace: 'raibit-system', releaseName: 'raibit-prod' });
const secretRefs = Object.freeze([{ kind: 'helm-existingSecret', role: 'runtime', binding: 'runtimeSecrets', namespace: 'raibit-system', existingSecret: 'raibit-runtime', keys: [EMAIL_KEY, PASSWORD_KEY] }]);

function kubeFixtures(overrides = {}) {
  const labels = { 'app.kubernetes.io/name': 'raibitserver-api', 'app.kubernetes.io/instance': 'raibit-prod', 'app.kubernetes.io/component': 'api' };
  return {
    deployments: { items: [{ metadata: { name: 'raibit-prod-api', namespace: 'raibit-system', uid: 'deploy-uid', labels }, status: { readyReplicas: 1 }, spec: { replicas: 1, selector: { matchLabels: { 'app.kubernetes.io/name': 'raibitserver-api', 'app.kubernetes.io/instance': 'raibit-prod' } }, template: { spec: { containers: [{ name: 'api', image: `registry.example/api@sha256:${'a'.repeat(64)}` }] } } } }] },
    services: { items: [{ metadata: { name: 'raibit-prod-api', namespace: 'raibit-system', uid: 'service-uid', labels }, spec: { type: 'ClusterIP', clusterIP: '10.0.0.8', selector: { 'app.kubernetes.io/name': 'raibitserver-api', 'app.kubernetes.io/instance': 'raibit-prod' }, ports: [{ name: 'http', port: 3000, targetPort: 'http' }] } }] },
    endpoints: { items: [{ metadata: { name: 'raibit-prod-api', namespace: 'raibit-system', uid: 'endpoint-uid', labels }, subsets: [{ addresses: [{ ip: '10.1.0.4', targetRef: { kind: 'Pod', namespace: 'raibit-system', name: 'raibit-prod-api-abc', uid: 'api-pod-uid' } }], ports: [{ name: 'http', port: 3000 }] }] }] },
    ...overrides,
  };
}
function deploymentOutput(items) {
  return items.map(item => { const labels = item.metadata.labels, selector = item.spec.selector.matchLabels, image = item.spec.template.spec.containers.find(container => container.name === 'api')?.image ?? ''; return [item.metadata.namespace, item.metadata.name, item.metadata.uid, labels['app.kubernetes.io/name'], labels['app.kubernetes.io/instance'], labels['app.kubernetes.io/component'], item.spec.replicas, item.status.readyReplicas, selector['app.kubernetes.io/name'], selector['app.kubernetes.io/instance'], image].join('\t'); }).join('\n') + (items.length ? '\n' : '');
}
function serviceOutput(items) {
  return items.map(item => { const labels = item.metadata.labels, spec = item.spec, ports = spec.ports.map(port => `${port.name}|${port.port}|${port.targetPort}|${port.protocol ?? 'TCP'};`).join(''); return [item.metadata.namespace, item.metadata.name, item.metadata.uid, labels['app.kubernetes.io/name'], labels['app.kubernetes.io/instance'], spec.type, spec.clusterIP, spec.selector['app.kubernetes.io/name'] ?? '', spec.selector['app.kubernetes.io/instance'] ?? '', Object.keys(spec.selector).length, spec.ports.length, ports].join('\t'); }).join('\n') + (items.length ? '\n' : '');
}
function endpointOutput(items) {
  return items.map(item => { const labels = item.metadata.labels, addresses = item.subsets.flatMap(subset => subset.addresses ?? []).map(address => `${address.targetRef?.kind ?? ''}|${address.targetRef?.namespace ?? ''}|${address.targetRef?.name ?? ''}|${address.targetRef?.uid ?? ''};`).join(''), ports = item.subsets.flatMap(subset => subset.ports ?? []).map(port => `${port.name ?? ''}|${port.port};`).join(''); return [item.metadata.namespace, item.metadata.name, item.metadata.uid, labels['app.kubernetes.io/name'], labels['app.kubernetes.io/instance'], addresses, ports].join('\t'); }).join('\n') + (items.length ? '\n' : '');
}

async function sandbox(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'raibit-auth-client-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fakeKubectl(fixtures = kubeFixtures(), options = {}) {
  const calls = [];
  let partialObjectsDeleted = false;
  const executeFile = async (file, args) => {
    calls.push({ file, args: [...args] });
    assert.equal(file, 'kubectl');
    const joined = args.join(' ');
    if (joined.includes('get deployments')) return { exitCode: 0, stdout: deploymentOutput(fixtures.deployments.items), stderr: '' };
    if (joined.includes('get service ')) { const original = fixtures.services.items[0], service = { ...original, ...options.serviceOverride, metadata: { ...original.metadata, uid: options.serviceUid ?? original.metadata.uid } }; return { exitCode: 0, stdout: serviceOutput([service]), stderr: '' }; }
    if (joined.includes('get services')) return { exitCode: 0, stdout: serviceOutput(fixtures.services.items), stderr: '' };
    if (joined.includes('get endpoints')) return { exitCode: 0, stdout: endpointOutput(fixtures.endpoints.items), stderr: '' };
    if (joined.includes('get networkpolicy') && joined.includes('--ignore-not-found')) return { exitCode: 0, stdout: !partialObjectsDeleted || options.cleanupSurvives ? `raibit-system\tevidence-client-run-27-safe-egress\t${RUN_ID}\n` : '', stderr: '' };
    if (joined.includes('get pod') && joined.includes('--ignore-not-found')) return { exitCode: 0, stdout: !partialObjectsDeleted || options.cleanupSurvives ? `raibit-system\tevidence-client-run-27-safe\t${RUN_ID}\n` : '', stderr: '' };
    if (joined.includes('get networkpolicy')) return { exitCode: 0, stdout: `raibit-system\tevidence-client-run-27-safe-egress\tpolicy-uid\t${RUN_ID}\n`, stderr: '' };
    if (joined.includes('apply -f')) {
      const manifestPath = args.at(-1);
      options.manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      return { exitCode: 0, stdout: 'applied', stderr: '' };
    }
    if (joined.includes('wait --for=condition=Ready')) return { exitCode: options.failWait ? 1 : 0, stdout: options.failWait ? '' : 'ready', stderr: options.failWait ? 'not ready' : '' };
    if (joined.includes('delete pod/evidence-client-run-27-safe networkpolicy/evidence-client-run-27-safe-egress')) { partialObjectsDeleted = !options.cleanupDeleteFails; return { exitCode: options.cleanupDeleteFails ? 1 : 0, stdout: '', stderr: '' }; }
    if (joined.includes('get pod')) return { exitCode: 0, stdout: `raibit-system\t${options.podName ?? 'evidence-client-run-27-safe'}\t${options.podUid ?? 'pod-uid'}\t${RUN_ID}\tTrue\n`, stderr: '' };
    if (joined.includes('logs')) return { exitCode: 0, stdout: `${JSON.stringify(options.me ?? { schema: 'raibitserver.production-evidence-auth/v1', user: { id: 'user-1' }, membership: { organizationId: 'org-1', userId: 'user-1', role: 'owner' } })}\n`, stderr: '' };
    if (joined.includes('exec')) return { exitCode: options.execExitCode ?? 0, stdout: `${JSON.stringify(options.response ?? { statusCode: 200, body: { resources: [{ id: 'resource-1' }], token: 'must-strip' } })}\n`, stderr: options.stderr ?? '' };
    throw new Error(`unexpected kubectl call: ${joined}`);
  };
  return { calls, executeFile };
}

function assertReason(reason, action) {
  assert.throws(action, error => error instanceof EvidenceClientError && error.reason === reason);
}

test('Given runtime Secret metadata without both live keys, When credentials are validated, Then preflight gets the typed missing reason', () => {
  for (const keys of [[], [EMAIL_KEY], [PASSWORD_KEY]]) {
    assertReason('missing_evidence_operator_credentials', () => validateEvidenceOperatorCredentials([{ ...secretRefs[0], keys }], runtimeRef));
  }
});

test('Given duplicate API objects, When the authenticated client is created, Then discovery fails closed', async t => {
  const runDirectory = await sandbox(t);
  const fixtures = kubeFixtures();
  fixtures.services.items.push(structuredClone(fixtures.services.items[0]));
  const fake = fakeKubectl(fixtures);
  await assert.rejects(createAuthenticatedEvidenceClient({ runtimeRef, secretRefs, runId: RUN_ID, runDirectory, executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'ambiguous_api_target');
});

test('Given a tag-based API image, When discovery runs, Then it cannot seed the evidence client', async t => {
  const runDirectory = await sandbox(t);
  const fixtures = kubeFixtures();
  fixtures.deployments.items[0].spec.template.spec.containers[0].image = 'registry.example/api:latest';
  const fake = fakeKubectl(fixtures);
  await assert.rejects(createAuthenticatedEvidenceClient({ runtimeRef, secretRefs, runId: RUN_ID, runDirectory, executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'api_image_not_digest_pinned');
});

test('Given a ready digest-pinned API, When authentication succeeds, Then the descriptor, projection, manifest, and inventory are safe and exact', async t => {
  const runDirectory = await sandbox(t);
  const observed = {};
  const fake = fakeKubectl(kubeFixtures(), observed);
  const result = await createAuthenticatedEvidenceClient({ runtimeRef, secretRefs, runId: RUN_ID, runDirectory, executeFile: fake.executeFile, clock: () => NOW });
  assert.deepEqual(Object.keys(result.descriptor), ['schema', 'namespace', 'podName', 'podUid', 'apiServiceName', 'apiServiceUid', 'port', 'expiresAt']);
  assert.deepEqual(result.auth, { userId: 'user-1', organizationId: 'org-1', role: 'owner' });
  assert.deepEqual(result.cleanupInventory, [
    { type: 'kubernetes', apiVersion: 'v1', kind: 'Pod', namespace: 'raibit-system', name: 'evidence-client-run-27-safe', uid: 'pod-uid', labels: { [RUN_LABEL]: RUN_ID } },
    { type: 'kubernetes', apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', namespace: 'raibit-system', name: 'evidence-client-run-27-safe-egress', uid: 'policy-uid', labels: { [RUN_LABEL]: RUN_ID } },
  ]);
  const pod = observed.manifest.items.find(item => item.kind === 'Pod');
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.hostNetwork, false);
  assert.deepEqual(pod.spec.securityContext.seccompProfile, { type: 'RuntimeDefault' });
  assert.equal(pod.spec.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.equal(pod.spec.containers[0].securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(pod.spec.containers[0].securityContext.capabilities.drop, ['ALL']);
  assert.equal(pod.spec.containers[0].env.length, 2);
  assert.ok(pod.spec.containers[0].env.every(entry => entry.valueFrom?.secretKeyRef?.name === 'raibit-runtime'));
  assert.equal(pod.spec.volumes[0].emptyDir.medium, 'Memory');
  assert.equal(JSON.stringify(observed.manifest).includes('literal-password'), false);
  assert.equal(fake.calls.every(call => call.args.every(arg => !arg.includes('literal-password'))), true);
  const reads = fake.calls.filter(call => call.args[0] === 'get');
  assert.ok(reads.every(call => call.args[call.args.indexOf('-o') + 1]?.startsWith('go-template=')));
  assert.ok(reads.every(call => !call.args.includes('json')));
  assert.doesNotThrow(() => reads.forEach(call => assertRedacted(call.args)));
  const parsed = parseStepResult({ status: 'PASS', reason: null, assertions: [{ id: 'github_source', status: 'PASS', artifactPaths: ['artifacts/lifecycle/auth.json'] }], artifacts: [{ path: 'artifacts/lifecycle/auth.json', sha256: 'a'.repeat(64), redacted: true }], cleanupInventory: result.cleanupInventory }, 'auth-source', { runDirectory, identity: { runId: RUN_ID }, state: { cleanupNamespace: 'tenant-run', authenticatedClient: result.descriptor } });
  const ordered = orderCleanupInventory([{ type: 'control-plane', resourceType: 'project', id: 'project-1', organizationId: 'org-1', projectId: 'project-1' }, ...parsed.cleanupInventory], result.descriptor);
  assert.equal(ordered[0].type, 'control-plane');
  assert.deepEqual(new Set(ordered.slice(-2).map(item => item.name)), new Set(['evidence-client-run-27-safe', 'evidence-client-run-27-safe-egress']));
});

test('Given representative Kubernetes projections, When the real RunnerContext boundary captures them, Then arguments and stdout pass unchanged redaction', async t => {
  const runDirectory = await sandbox(t);
  const fixtures = kubeFixtures();
  const projected = [deploymentOutput(fixtures.deployments.items), serviceOutput(fixtures.services.items), endpointOutput(fixtures.endpoints.items), `raibit-system\tevidence-client-run-27-safe\tpod-uid\t${RUN_ID}\tTrue\n`, `raibit-system\tevidence-client-run-27-safe-egress\tpolicy-uid\t${RUN_ID}\n`].join('');
  assert.doesNotThrow(() => assertRedacted(Object.values(KUBE_PROJECTIONS)));
  const context = createRunnerContext(runDirectory, '2026-09-04T00:01:00.000Z', { now: () => new Date(NOW) });
  const result = await context.executeFile(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(projected)})`]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, projected);
});

test('Given malformed auth membership, When auth/me is projected, Then zero or multiple memberships are rejected', async t => {
  for (const me of [
    { schema: 'raibitserver.production-evidence-auth/v1', user: { id: 'user-1' }, memberships: [] },
    { schema: 'raibitserver.production-evidence-auth/v1', user: { id: 'user-1' }, memberships: [{ organizationId: 'org-1', userId: 'user-1', role: 'owner' }, { organizationId: 'org-2', userId: 'user-1', role: 'viewer' }] },
    { schema: 'raibitserver.production-evidence-auth/v1', user: { id: 'user-1' }, membership: { organizationId: 'org-1', userId: 'user-1', role: 'viewer' } },
    { schema: 'raibitserver.production-evidence-auth/v1', user: { id: 'user-1' }, membership: { organizationId: 'org-1', userId: 'user-1', role: 'owner' }, session: 'OpaqueSessionMaterialWithoutDigitsXYZ' },
  ]) {
    const runDirectory = await sandbox(t);
    const fake = fakeKubectl(kubeFixtures(), { me });
    await assert.rejects(createAuthenticatedEvidenceClient({ runtimeRef, secretRefs, runId: RUN_ID, runDirectory, executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'invalid_evidence_operator_membership');
  }
});

test('Given an authenticated descriptor, When a protected resource route is called, Then UID/labels are revalidated and token fields are stripped', async () => {
  const fake = fakeKubectl(kubeFixtures());
  const descriptor = { schema: 'raibitserver.production-evidence-client/v1', namespace: 'raibit-system', podName: 'evidence-client-run-27-safe', podUid: 'pod-uid', apiServiceName: 'raibit-prod-api', apiServiceUid: 'service-uid', port: 3000, expiresAt: '2026-09-04T00:10:00.000Z' };
  const response = await executeAuthenticatedEvidenceRequest({ descriptor, runId: RUN_ID, method: 'GET', path: '/api/projects/project-1/resources', executeFile: fake.executeFile, clock: () => NOW });
  assert.deepEqual(response, { statusCode: 200, body: { resources: [{ id: 'resource-1' }] } });
  assert.equal(JSON.stringify(response).includes('must-strip'), false);
  const exec = fake.calls.find(call => call.args.includes('exec'));
  assert.ok(exec);
  assert.equal(exec.args.includes('/session/token'), false);
  assert.equal(exec.args.some(arg => arg.includes('must-strip')), false);
  assert.deepEqual(exec.args.slice(exec.args.indexOf('--') + 1, exec.args.indexOf('--') + 3), ['node', '/session/request.cjs']);
  assert.doesNotThrow(() => assertRedacted(exec.args));
});

test('Given a same-UID Service selector or ready Endpoint mutation, When a protected request starts, Then routing is rejected before exec', async () => {
  const descriptor = { schema: 'raibitserver.production-evidence-client/v1', namespace: 'raibit-system', podName: 'evidence-client-run-27-safe', podUid: 'pod-uid', apiServiceName: 'raibit-prod-api', apiServiceUid: 'service-uid', port: 3000, expiresAt: '2026-09-04T00:10:00.000Z' };
  const cases = [
    fakeKubectl(kubeFixtures(), { serviceOverride: { spec: { ...kubeFixtures().services.items[0].spec, selector: { 'app.kubernetes.io/name': 'attacker' } } } }),
    fakeKubectl(kubeFixtures({ endpoints: { items: [{ ...kubeFixtures().endpoints.items[0], subsets: [{ addresses: [{ ip: '10.1.0.9' }], ports: [{ name: 'http', port: 3000 }] }] }] } })),
  ];
  for (const fake of cases) {
    await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor, runId: RUN_ID, method: 'GET', path: '/api/projects', executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_identity_mismatch');
    assert.equal(fake.calls.some(call => call.args.includes('exec')), false);
  }
});

test('Given partial creation failure, When cleanup runs, Then owned objects must be proven absent', async t => {
  const runDirectory = await sandbox(t);
  const cleaned = fakeKubectl(kubeFixtures(), { failWait: true });
  await assert.rejects(createAuthenticatedEvidenceClient({ runtimeRef, secretRefs, runId: RUN_ID, runDirectory, executeFile: cleaned.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_not_ready');
  assert.equal(cleaned.calls.some(call => call.args.includes('delete')), true);
  const leaked = fakeKubectl(kubeFixtures(), { failWait: true, cleanupSurvives: true });
  await assert.rejects(createAuthenticatedEvidenceClient({ runtimeRef, secretRefs, runId: RUN_ID, runDirectory, executeFile: leaked.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_partial_cleanup_failed');
});

test('Given a swapped Pod UID, When a protected request starts, Then execution is rejected before kubectl exec', async () => {
  const fake = fakeKubectl(kubeFixtures(), { podUid: 'attacker-uid' });
  const descriptor = { schema: 'raibitserver.production-evidence-client/v1', namespace: 'raibit-system', podName: 'evidence-client-run-27-safe', podUid: 'pod-uid', apiServiceName: 'raibit-prod-api', apiServiceUid: 'service-uid', port: 3000, expiresAt: '2026-09-04T00:10:00.000Z' };
  await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor, runId: RUN_ID, method: 'GET', path: '/api/projects', executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_identity_mismatch');
  assert.equal(fake.calls.some(call => call.args.includes('exec')), false);
});

test('Given a swapped Service UID or expired descriptor, When a protected request starts, Then execution fails closed', async () => {
  const descriptor = { schema: 'raibitserver.production-evidence-client/v1', namespace: 'raibit-system', podName: 'evidence-client-run-27-safe', podUid: 'pod-uid', apiServiceName: 'raibit-prod-api', apiServiceUid: 'service-uid', port: 3000, expiresAt: '2026-09-04T00:10:00.000Z' };
  const swapped = fakeKubectl(kubeFixtures(), { serviceUid: 'attacker-service-uid' });
  await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor, runId: RUN_ID, method: 'GET', path: '/api/projects', executeFile: swapped.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_identity_mismatch');
  const untouched = fakeKubectl();
  await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor: { ...descriptor, expiresAt: NOW }, runId: RUN_ID, method: 'GET', path: '/api/projects', executeFile: untouched.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_expired');
  assert.equal(untouched.calls.length, 0);
});

test('Given an unapproved request shape, When protected execution is requested, Then absolute, traversal, headers, and unknown routes fail locally', async () => {
  const descriptor = { schema: 'raibitserver.production-evidence-client/v1', namespace: 'raibit-system', podName: 'evidence-client-run-27-safe', podUid: 'pod-uid', apiServiceName: 'raibit-prod-api', apiServiceUid: 'service-uid', port: 3000, expiresAt: '2026-09-04T00:10:00.000Z' };
  const fake = fakeKubectl();
  for (const request of [
    { method: 'GET', path: 'https://evil.example/api/projects' },
    { method: 'GET', path: '/api/projects/../admin/users' },
    { method: 'GET', path: '/api/admin/users' },
    { method: 'GET', path: '/api/projects', headers: { Authorization: 'hidden' } },
  ]) await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor, runId: RUN_ID, executeFile: fake.executeFile, clock: () => NOW, ...request }), error => error.reason === 'invalid_authenticated_request');
  assert.equal(fake.calls.length, 0);
});

test('Given helper output containing bearer material, When a request completes, Then leakage is rejected', async () => {
  const fake = fakeKubectl(kubeFixtures(), { response: { statusCode: 200, body: { message: `Bearer ${'x'.repeat(30)}` } } });
  const descriptor = { schema: 'raibitserver.production-evidence-client/v1', namespace: 'raibit-system', podName: 'evidence-client-run-27-safe', podUid: 'pod-uid', apiServiceName: 'raibit-prod-api', apiServiceUid: 'service-uid', port: 3000, expiresAt: '2026-09-04T00:10:00.000Z' };
  await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor, runId: RUN_ID, method: 'GET', path: '/api/usage/me', executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_output_leak');
});

test('Given an opaque session-like value under a harmless key, When a response is projected, Then it is rejected while IDs and digests remain usable', async () => {
  const descriptor = { schema: 'raibitserver.production-evidence-client/v1', namespace: 'raibit-system', podName: 'evidence-client-run-27-safe', podUid: 'pod-uid', apiServiceName: 'raibit-prod-api', apiServiceUid: 'service-uid', port: 3000, expiresAt: '2026-09-04T00:10:00.000Z' };
  const leaked = fakeKubectl(kubeFixtures(), { response: { statusCode: 200, body: { value: 'OpaqueSessionMaterialWithoutDigitsXYZ' } } });
  await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor, runId: RUN_ID, method: 'GET', path: '/api/usage/me', executeFile: leaked.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_output_leak');
  const safe = fakeKubectl(kubeFixtures(), { response: { statusCode: 200, body: { deploymentId: 'deployment-0123456789-abcdef', imageDigest: `sha256:${'a'.repeat(64)}` } } });
  assert.deepEqual((await executeAuthenticatedEvidenceRequest({ descriptor, runId: RUN_ID, method: 'GET', path: '/api/usage/me', executeFile: safe.executeFile, clock: () => NOW })).body, { deploymentId: 'deployment-0123456789-abcdef', imageDigest: `sha256:${'a'.repeat(64)}` });
});
