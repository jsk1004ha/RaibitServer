import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertRedacted, canonical } from '../scripts/production-evidence/lib/operator-inputs.mjs';
import { evidenceClientNetworkPolicy, KUBE_PROJECTIONS } from '../scripts/production-evidence/lib/authenticated-client-kubernetes.mjs';
import { orderCleanupInventory } from '../scripts/production-evidence/lib/orchestrator.mjs';
import { createRunnerContext } from '../scripts/production-evidence/lib/runner-context.mjs';
import {
  EvidenceClientError,
  cleanupAuthenticatedEvidenceClient,
  createAuthenticatedEvidenceClient,
  executeAuthenticatedEvidenceRequest,
  validateEvidenceOperatorCredentials,
} from '../scripts/production-evidence/lib/authenticated-client.mjs';

const NOW = '2026-09-04T00:00:00.000Z';
const RUN_ID = 'run-27-safe';
const REQUEST_DIRECTORY = path.join(tmpdir(), 'raibit-auth-request-unused');
const RUN_LABEL = 'raibitserver.io/run-id';
const EMAIL_KEY = 'RAIBITSERVER_EVIDENCE_OPERATOR_EMAIL';
const PASSWORD_KEY = 'RAIBITSERVER_EVIDENCE_OPERATOR_PASSWORD';
const runtimeRef = Object.freeze({ namespace: 'raibit-system', releaseName: 'raibit-prod' });
const secretRefs = Object.freeze([{ kind: 'helm-existingSecret', role: 'runtime', binding: 'runtimeSecrets', namespace: 'raibit-system', existingSecret: 'raibit-runtime', keys: [EMAIL_KEY, PASSWORD_KEY] }]);
const clientDescriptor = (overrides = {}) => ({ schema: 'raibitserver.production-evidence-client/v1', namespace: 'raibit-system', podName: 'evidence-client-run-27-safe', podUid: 'pod-uid', podResourceVersion: 'pod-rv-1', networkPolicyUid: 'policy-uid', networkPolicyResourceVersion: 'policy-rv-1', apiServiceName: 'raibit-prod-api', apiServiceUid: 'service-uid', port: 3000, expiresAt: '2026-09-04T00:10:00.000Z', ...overrides });

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
  const stdinInputs = [];
  const deleted = new Set();
  const currentUid = kind => options[`${kind}ReplacementUid`] ?? options[`${kind}Uid`] ?? `${kind}-uid`;
  const currentVersion = kind => options[`${kind}ReplacementVersion`] ?? options[`${kind}ObservedVersion`] ?? options[`${kind}ResourceVersion`] ?? `${kind}-rv-1`;
  const executeFile = async (file, args, commandOptions = {}) => {
    calls.push({ file, args: [...args] });
    if (commandOptions.stdin !== undefined) stdinInputs.push({ args: [...args], stdin: commandOptions.stdin });
    assert.equal(file, 'kubectl');
    const joined = args.join(' ');
    if (joined.includes('get deployments')) return { exitCode: 0, stdout: deploymentOutput(fixtures.deployments.items), stderr: '' };
    if (joined.includes('get service ')) { const original = fixtures.services.items[0], service = { ...original, ...options.serviceOverride, metadata: { ...original.metadata, uid: options.serviceUid ?? original.metadata.uid } }; return { exitCode: 0, stdout: serviceOutput([service]), stderr: '' }; }
    if (joined.includes('get services')) return { exitCode: 0, stdout: serviceOutput(fixtures.services.items), stderr: '' };
    if (joined.includes('get endpoints')) return { exitCode: 0, stdout: endpointOutput(fixtures.endpoints.items), stderr: '' };
    if (joined.includes('get networkpolicy') && joined.includes('--ignore-not-found')) return { exitCode: 0, stdout: deleted.has('policy') ? '' : `raibit-system\tevidence-client-run-27-safe-egress\t${currentUid('policy')}\t${currentVersion('policy')}\t${RUN_ID}\traibitserver-evidence-client\t2\n`, stderr: '' };
    if (joined.includes('get pod') && joined.includes('--ignore-not-found')) return { exitCode: 0, stdout: deleted.has('pod') ? '' : `raibit-system\tevidence-client-run-27-safe\t${currentUid('pod')}\t${currentVersion('pod')}\t${RUN_ID}\traibitserver-evidence-client\t2\n`, stderr: '' };
    if (joined.includes('get networkpolicy') && args.includes(`-o=${KUBE_PROJECTIONS.policySpec}`)) {
      options.policySpecReads = (options.policySpecReads ?? 0) + 1;
      const policy = structuredClone(options.manifest?.items.find(item => item.kind === 'NetworkPolicy') ?? evidenceClientNetworkPolicy({ name: 'evidence-client-run-27-safe', namespace: 'raibit-system', runId: RUN_ID, releaseName: 'raibit-prod' }));
      const mutate = options.broadenPolicy || options.mutatePolicyAtRead === options.policySpecReads || (options.didExec && options.mutateDuringExec);
      if (mutate) policy.spec.egress.push({ to: [{}] });
      if (options.policySensitiveKey) policy.sessionToken = 'must-never-project';
      const resourceVersion = options.broadenRestoreBeforeExec ? 'policy-rv-3'
        : options.changeVersionBeforeExec || mutate || (options.didExec && options.changeVersionDuringExec) ? 'policy-rv-2' : 'policy-rv-1';
      options.policyObservedVersion = resourceVersion;
      return { exitCode: 0, stdout: `${JSON.stringify({ ...policy, metadata: { ...policy.metadata, uid: currentUid('policy'), resourceVersion } })}\n`, stderr: '' };
    }
    if (joined.includes('get networkpolicy')) return { exitCode: 0, stdout: `raibit-system\t${options.policyName ?? 'evidence-client-run-27-safe-egress'}\t${options.policyUid ?? 'policy-uid'}\t${options.policyRunId ?? RUN_ID}\n`, stderr: '' };
    if (joined.includes('create -f')) {
      assert.equal(args[args.indexOf('-f') + 1], '-');
      assert.equal(typeof commandOptions.stdin, 'string');
      const manifest = JSON.parse(commandOptions.stdin);
      assert.equal(commandOptions.stdin, `${JSON.stringify(canonical(manifest))}\n`);
      assert.ok(Buffer.byteLength(commandOptions.stdin) <= 256 * 1024);
      options.manifest ??= { items: [] };
      options.manifest.items.push(manifest);
      if ((manifest.kind === 'NetworkPolicy' && options.preexistingPolicy) || (manifest.kind === 'Pod' && (options.preexistingPod || options.failPodCreate))) return { exitCode: 1, stdout: '', stderr: 'AlreadyExists' };
      const uid = manifest.kind === 'Pod' ? 'pod-uid' : 'policy-uid';
      return { exitCode: 0, stdout: `raibit-system\t${manifest.metadata.name}\t${uid}\t${manifest.kind === 'Pod' ? 'pod-rv-1' : 'policy-rv-1'}\t${RUN_ID}\traibitserver-evidence-client\t2\n`, stderr: '' };
    }
    if (joined.includes('wait --for=condition=Ready')) return { exitCode: options.failWait ? 1 : 0, stdout: options.failWait ? '' : 'ready', stderr: options.failWait ? 'not ready' : '' };
    if (joined.includes('delete --raw')) {
      const kind = joined.includes('/pods/') ? 'pod' : 'policy';
      assert.equal(args[args.indexOf('-f') + 1], '-');
      const body = JSON.parse(commandOptions.stdin);
      assert.equal(commandOptions.stdin, `${JSON.stringify(canonical(body))}\n`);
      assert.ok(Buffer.byteLength(commandOptions.stdin) <= 4 * 1024);
      options.deleteOptions ??= [];
      options.deleteOptions.push({ kind, path: args[args.indexOf('--raw') + 1], body });
      if (options[`${kind}ReplaceOnDelete`]) {
        options[`${kind}ReplacementUid`] = `foreign-${kind}-uid`;
        options[`${kind}ReplacementVersion`] = `foreign-${kind}-rv`;
      }
      if (!options.cleanupSurvives && body.preconditions.uid === currentUid(kind) && body.preconditions.resourceVersion === currentVersion(kind)) deleted.add(kind);
      return { exitCode: options.cleanupDeleteFails || !deleted.has(kind) ? 1 : 0, stdout: '', stderr: deleted.has(kind) ? '' : 'Conflict' };
    }
    if (joined.includes('wait --for=delete')) return { exitCode: 0, stdout: '', stderr: '' };
    if (joined.includes('get pod')) return { exitCode: 0, stdout: `raibit-system\t${options.podName ?? 'evidence-client-run-27-safe'}\t${options.podUid ?? 'pod-uid'}\t${currentVersion('pod')}\t${RUN_ID}\tTrue\n`, stderr: '' };
    if (joined.includes('logs')) return { exitCode: 0, stdout: `${JSON.stringify(options.me ?? { schema: 'raibitserver.production-evidence-auth/v1', user: { id: 'user-1' }, membership: { organizationId: 'org-1', userId: 'user-1', role: 'owner' } })}\n`, stderr: '' };
    if (joined.includes('exec')) { options.didExec = true; return { exitCode: options.execExitCode ?? 0, stdout: `${JSON.stringify(options.response ?? { statusCode: 200, body: { resources: [{ id: 'resource-1' }], token: 'must-strip' } })}\n`, stderr: options.stderr ?? '' }; }
    throw new Error(`unexpected kubectl call: ${joined}`);
  };
  return { calls, stdinInputs, executeFile, get deleteOptions() { return options.deleteOptions ?? []; }, get deleted() { return new Set(deleted); } };
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
  assert.deepEqual(Object.keys(result.descriptor), ['schema', 'namespace', 'podName', 'podUid', 'podResourceVersion', 'networkPolicyUid', 'networkPolicyResourceVersion', 'apiServiceName', 'apiServiceUid', 'port', 'expiresAt']);
  assert.equal(Date.parse(result.descriptor.expiresAt) - Date.parse(NOW), 4 * 60 * 60_000 + 30_000);
  assert.equal(result.descriptor.podResourceVersion, 'pod-rv-1');
  assert.equal(result.descriptor.networkPolicyUid, result.cleanupInventory[1].uid);
  assert.equal(result.descriptor.networkPolicyResourceVersion, 'policy-rv-1');
  assert.deepEqual(result.auth, { userId: 'user-1', organizationId: 'org-1', role: 'owner' });
  assert.deepEqual(result.cleanupInventory, [
    { type: 'kubernetes', apiVersion: 'v1', kind: 'Pod', namespace: 'raibit-system', name: 'evidence-client-run-27-safe', uid: 'pod-uid', resourceVersion: 'pod-rv-1', labels: { [RUN_LABEL]: RUN_ID } },
    { type: 'kubernetes', apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', namespace: 'raibit-system', name: 'evidence-client-run-27-safe-egress', uid: 'policy-uid', resourceVersion: 'policy-rv-1', labels: { [RUN_LABEL]: RUN_ID } },
  ]);
  const pod = observed.manifest.items.find(item => item.kind === 'Pod');
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.serviceAccountName, undefined);
  assert.ok(pod.spec.volumes.every(volume => Object.keys(volume).every(key => key === 'name' || key === 'emptyDir')));
  assert.deepEqual(pod.spec.containers[0].volumeMounts.map(mount => mount.mountPath), ['/session', '/tmp']);
  assert.equal(JSON.stringify(pod).includes('serviceAccountToken'), false);
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
  const creates = fake.calls.filter(call => call.args[0] === 'create');
  const createInputs = fake.stdinInputs.filter(call => call.args[0] === 'create');
  assert.equal(creates.length, 2);
  assert.equal(creates[0].args[creates[0].args.indexOf('-f') + 1], '-');
  assert.equal(creates[1].args[creates[1].args.indexOf('-f') + 1], '-');
  assert.deepEqual(createInputs.map(call => JSON.parse(call.stdin).kind), ['NetworkPolicy', 'Pod']);
  assert.ok(createInputs.every(call => call.stdin === `${JSON.stringify(canonical(JSON.parse(call.stdin)))}\n`));
  assert.equal(JSON.stringify(fake.calls).includes(EMAIL_KEY), false);
  assert.equal(JSON.stringify(fake.calls).includes(PASSWORD_KEY), false);
  assert.deepEqual(await readdir(runDirectory), []);
  assert.equal(fake.calls.some(call => call.args[0] === 'apply'), false);
  const reads = fake.calls.filter(call => call.args[0] === 'get');
  const policyReads = reads.filter(call => call.args.includes('-o=json'));
  assert.equal(policyReads.length, 2);
  policyReads.forEach(call => assert.deepEqual(call.args, ['get', 'networkpolicy', 'evidence-client-run-27-safe-egress', '-n', 'raibit-system', '-o=json']));
  assert.ok(reads.filter(call => !call.args.includes('-o=json')).every(call => call.args[call.args.indexOf('-o') + 1]?.startsWith('go-template=')));
  assert.equal(reads.some(call => call.args.some(arg => arg.includes('{{json'))), false);
  assert.doesNotThrow(() => reads.forEach(call => assertRedacted(call.args)));
  const ordered = orderCleanupInventory([{ type: 'control-plane', resourceType: 'project', id: 'project-1', organizationId: 'org-1', projectId: 'project-1' }, ...result.cleanupInventory], result.descriptor);
  assert.equal(ordered[0].type, 'control-plane');
  assert.deepEqual(new Set(ordered.slice(-2).map(item => item.name)), new Set(['evidence-client-run-27-safe', 'evidence-client-run-27-safe-egress']));
  assert.deepEqual(result.cleanupInventory.map(item => item.name), ['evidence-client-run-27-safe', 'evidence-client-run-27-safe-egress']);
});

test('Given pre-existing same-name client objects, When exclusive creation runs, Then collisions fail without adopting or deleting them', async t => {
  for (const collision of [{ preexistingPolicy: true }, { preexistingPod: true }]) {
    const runDirectory = await sandbox(t);
    const fake = fakeKubectl(kubeFixtures(), collision);
    await assert.rejects(createAuthenticatedEvidenceClient({ runtimeRef, secretRefs, runId: RUN_ID, runDirectory, executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_create_failed');
    assert.equal(fake.calls.some(call => call.args[0] === 'apply'), false);
    assert.equal(fake.calls.some(call => call.args[0] === 'delete' && call.args.some(arg => arg.includes('/pods/'))), false);
    if (collision.preexistingPolicy) assert.equal(fake.calls.some(call => call.args[0] === 'delete'), false);
    else assert.deepEqual(fake.deleteOptions.map(item => [item.kind, item.body.preconditions]), [['policy', { uid: 'policy-uid', resourceVersion: 'policy-rv-1' }]]);
  }
});

test('Given Pod creation failure after policy creation, When rollback runs, Then only the exact created policy UID is deleted', async t => {
  const runDirectory = await sandbox(t);
  const fake = fakeKubectl(kubeFixtures(), { failPodCreate: true });
  await assert.rejects(createAuthenticatedEvidenceClient({ runtimeRef, secretRefs, runId: RUN_ID, runDirectory, executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_create_failed');
  assert.deepEqual(fake.deleteOptions.map(item => [item.kind, item.body]), [['policy', { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'policy-uid', resourceVersion: 'policy-rv-1' } }]]);
  assert.match(fake.deleteOptions[0].path, /\/apis\/networking\.k8s\.io\/v1\/namespaces\/raibit-system\/networkpolicies\/evidence-client-run-27-safe-egress$/);
});

test('Given a same-UID broadened NetworkPolicy, When it is verified before Pod creation, Then stale cleanup is rejected without a delete', async t => {
  const runDirectory = await sandbox(t);
  const fake = fakeKubectl(kubeFixtures(), { broadenPolicy: true });
  await assert.rejects(createAuthenticatedEvidenceClient({ runtimeRef, secretRefs, runId: RUN_ID, runDirectory, executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_partial_cleanup_failed');
  assert.equal(fake.calls.filter(call => call.args[0] === 'create').length, 1);
  assert.deepEqual(fake.deleteOptions, []);
});

test('Given policy widening after Pod readiness, When cleanup sees a stale resourceVersion, Then neither object is deleted', async t => {
  const runDirectory = await sandbox(t);
  const fake = fakeKubectl(kubeFixtures(), { mutatePolicyAtRead: 2 });
  await assert.rejects(createAuthenticatedEvidenceClient({ runtimeRef, secretRefs, runId: RUN_ID, runDirectory, executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_partial_cleanup_failed');
  assert.equal(fake.calls.filter(call => call.args[0] === 'create').length, 2);
  assert.deepEqual(fake.deleteOptions, []);
});

test('Given representative Kubernetes projections, When the real RunnerContext boundary captures them, Then arguments and stdout pass unchanged redaction', async t => {
  const runDirectory = await sandbox(t);
  const fixtures = kubeFixtures();
  const projected = [deploymentOutput(fixtures.deployments.items), serviceOutput(fixtures.services.items), endpointOutput(fixtures.endpoints.items), `raibit-system\tevidence-client-run-27-safe\tpod-uid\tpod-rv-1\t${RUN_ID}\tTrue\n`, `raibit-system\tevidence-client-run-27-safe-egress\tpolicy-uid\tpolicy-rv-1\t${RUN_ID}\traibitserver-evidence-client\t2\n`].join('');
  assert.doesNotThrow(() => assertRedacted(Object.values(KUBE_PROJECTIONS)));
  const context = createRunnerContext(runDirectory, '2026-09-04T00:01:00.000Z', { now: () => new Date(NOW) });
  const result = await context.executeFile(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(projected)})`]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, projected);
});

test('Given an available stock kubectl client, When a NetworkPolicy fixture is rendered as JSON, Then the production output mode is supported', async t => {
  const version = spawnSync('kubectl', ['version', '--client=true', '--output=json'], { encoding: 'utf8' });
  if (version.error?.code === 'ENOENT') return t.skip('NOT_RUN: kubectl client unavailable');
  assert.equal(version.status, 0, version.stderr);
  const runDirectory = await sandbox(t);
  const fixturePath = path.join(runDirectory, 'networkpolicy.json');
  await writeFile(fixturePath, `${JSON.stringify(evidenceClientNetworkPolicy({ name: 'evidence-client-run-27-safe', namespace: 'raibit-system', runId: RUN_ID, releaseName: 'raibit-prod' }))}\n`, { flag: 'wx', mode: 0o600 });
  const rendered = spawnSync('kubectl', ['create', '--dry-run=client', '--validate=false', '-f', fixturePath, '-o=json'], { encoding: 'utf8' });
  assert.equal(rendered.status, 0, rendered.stderr);
  const parsed = JSON.parse(rendered.stdout);
  assert.equal(parsed.kind, 'NetworkPolicy');
  assert.deepEqual(parsed.spec.policyTypes, ['Egress']);
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
  const descriptor = clientDescriptor();
  const response = await executeAuthenticatedEvidenceRequest({ descriptor, runId: RUN_ID, runDirectory: REQUEST_DIRECTORY, method: 'GET', path: '/api/projects/project-1/resources', executeFile: fake.executeFile, clock: () => NOW });
  assert.deepEqual(response, { statusCode: 200, body: { resources: [{ id: 'resource-1' }] } });
  assert.equal(JSON.stringify(response).includes('must-strip'), false);
  const exec = fake.calls.find(call => call.args.includes('exec'));
  assert.ok(exec);
  assert.equal(exec.args.includes('/session/token'), false);
  assert.equal(exec.args.some(arg => arg.includes('must-strip')), false);
  assert.deepEqual(exec.args.slice(exec.args.indexOf('--') + 1, exec.args.indexOf('--') + 3), ['node', '/session/request.cjs']);
  assert.doesNotThrow(() => assertRedacted(exec.args));
});

test('Given service readiness routes, When authenticated requests run, Then exact GET and readiness-only PATCH preserve the real API contract', async () => {
  const base = { descriptor: clientDescriptor(), runId: RUN_ID, runDirectory: REQUEST_DIRECTORY, clock: () => NOW };
  for (const [method, readinessPath] of [['GET', undefined], ['PATCH', '/ready'], ['PATCH', null]]) {
    const service = { id: 'service-1', projectId: 'project-1', readinessPath: readinessPath ?? null, desiredSpec: { readinessPath: readinessPath ?? null } };
    const fake = fakeKubectl(kubeFixtures(), { response: { statusCode: 200, body: service } });
    const response = await executeAuthenticatedEvidenceRequest({ ...base, method, path: '/api/services/service-1',
      ...(method === 'PATCH' ? { body: { readinessPath } } : {}), executeFile: fake.executeFile });
    assert.deepEqual(response, { statusCode: 200, body: service });
    const exec = fake.calls.find(({ args }) => args.includes('exec'));
    assert.ok(exec);
    assert.equal(exec.args.includes('/api/services/service-1'), true);
    if (method === 'PATCH') assert.deepEqual(JSON.parse(Buffer.from(exec.args.at(-1), 'base64url')), { readinessPath });
  }
  const invalidBodies = [undefined, null, {}, [], { readinessPath: undefined }, { readinessPath: 1 }, { readinessPath: '/ready', name: 'other' },
    { healthCheckPath: '/ready' }, { readinessPath: 'https://example.test/ready' }, { readinessPath: '//elsewhere' }, { readinessPath: '/a/../b' },
    { readinessPath: '/a%2fb' }, { readinessPath: '/ready?query=yes' }, { readinessPath: '/ready#fragment' }, { readinessPath: '/' + '가'.repeat(342) }];
  const untouched = fakeKubectl();
  for (const body of invalidBodies) await assert.rejects(executeAuthenticatedEvidenceRequest({ ...base, method: 'PATCH', path: '/api/services/service-1', body, executeFile: untouched.executeFile }), { reason: 'invalid_authenticated_request' });
  for (const method of ['GET', 'PATCH']) await assert.rejects(executeAuthenticatedEvidenceRequest({ ...base, method, path: '/api/services/service-1?other=true',
    ...(method === 'PATCH' ? { body: { readinessPath: '/ready' } } : {}), executeFile: untouched.executeFile }), { reason: 'invalid_authenticated_request' });
  assert.equal(untouched.calls.length, 0);
});

test('Given a widened policy before protected exec, When request revalidation runs, Then exec and stale cleanup deletion are skipped', async t => {
  const runDirectory = await sandbox(t);
  const fake = fakeKubectl(kubeFixtures(), { mutatePolicyAtRead: 1 });
  await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor: clientDescriptor(), runId: RUN_ID, runDirectory, method: 'GET', path: '/api/projects', executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_partial_cleanup_failed');
  assert.equal(fake.calls.some(call => call.args[0] === 'exec'), false);
  assert.deepEqual(fake.deleteOptions, []);
});

test('Given an unexpected sensitive key in NetworkPolicy JSON, When strict projection runs, Then exec is skipped and exact cleanup runs', async t => {
  const runDirectory = await sandbox(t);
  const fake = fakeKubectl(kubeFixtures(), { policySensitiveKey: true });
  await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor: clientDescriptor(), runId: RUN_ID, runDirectory, method: 'GET', path: '/api/projects', executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_policy_changed');
  assert.equal(fake.calls.some(call => call.args[0] === 'exec'), false);
  assert.deepEqual(fake.deleteOptions.map(item => item.kind), ['pod', 'policy']);
});

test('Given a broadened then restored policy before protected exec, When immutable revision revalidation runs, Then no response or stale cleanup delete is accepted', async t => {
  const runDirectory = await sandbox(t);
  const fake = fakeKubectl(kubeFixtures(), { broadenRestoreBeforeExec: true, response: { statusCode: 200, body: { accepted: 'must-not-return' } } });
  await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor: clientDescriptor(), runId: RUN_ID, runDirectory, method: 'GET', path: '/api/projects', executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_partial_cleanup_failed');
  assert.equal(fake.calls.some(call => call.args[0] === 'exec'), false);
  assert.deepEqual(fake.deleteOptions, []);
});

test('Given only the policy resourceVersion changed before protected exec, When immutable revision revalidation runs, Then no response or stale cleanup delete is accepted', async t => {
  const runDirectory = await sandbox(t);
  const fake = fakeKubectl(kubeFixtures(), { changeVersionBeforeExec: true, response: { statusCode: 200, body: { accepted: 'must-not-return' } } });
  await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor: clientDescriptor(), runId: RUN_ID, runDirectory, method: 'GET', path: '/api/projects', executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_partial_cleanup_failed');
  assert.equal(fake.calls.some(call => call.args[0] === 'exec'), false);
  assert.deepEqual(fake.deleteOptions, []);
});

test('Given policy spec or resourceVersion drift during exec, When post-exec verification runs, Then the response is discarded and stale cleanup is rejected', async t => {
  for (const mutation of [{ mutateDuringExec: true }, { changeVersionDuringExec: true }]) {
    const runDirectory = await sandbox(t);
    const fake = fakeKubectl(kubeFixtures(), { ...mutation, response: { statusCode: 200, body: { accepted: 'must-not-return' } } });
    await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor: clientDescriptor(), runId: RUN_ID, runDirectory, method: 'GET', path: '/api/projects', executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_partial_cleanup_failed');
    assert.equal(fake.calls.some(call => call.args[0] === 'exec'), true);
    assert.deepEqual(fake.deleteOptions, []);
  }
});

test('Given a same-UID Service selector or ready Endpoint mutation, When a protected request starts, Then routing is rejected before exec', async () => {
  const descriptor = clientDescriptor();
  const cases = [
    fakeKubectl(kubeFixtures(), { serviceOverride: { spec: { ...kubeFixtures().services.items[0].spec, selector: { 'app.kubernetes.io/name': 'attacker' } } } }),
    fakeKubectl(kubeFixtures({ endpoints: { items: [{ ...kubeFixtures().endpoints.items[0], subsets: [{ addresses: [{ ip: '10.1.0.9' }], ports: [{ name: 'http', port: 3000 }] }] }] } })),
  ];
  for (const fake of cases) {
    await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor, runId: RUN_ID, runDirectory: REQUEST_DIRECTORY, method: 'GET', path: '/api/projects', executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_identity_mismatch');
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

test('Given final client cleanup, When deletion runs, Then Pod precedes policy and both preconditions are sent', async t => {
  const runDirectory = await sandbox(t);
  const fake = fakeKubectl(kubeFixtures());
  await cleanupAuthenticatedEvidenceClient({ descriptor: clientDescriptor(), runId: RUN_ID, runDirectory, executeFile: fake.executeFile });
  assert.deepEqual(fake.deleteOptions.map(item => [item.kind, item.body.preconditions]), [
    ['pod', { uid: 'pod-uid', resourceVersion: 'pod-rv-1' }],
    ['policy', { uid: 'policy-uid', resourceVersion: 'policy-rv-1' }],
  ]);
  assert.equal(fake.deleteOptions[0].path.endsWith('/pods/evidence-client-run-27-safe'), true);
  assert.equal(fake.deleteOptions[1].path.endsWith('/networkpolicies/evidence-client-run-27-safe-egress'), true);
  assert.deepEqual(fake.calls.filter(call => call.args[0] === 'delete').map(call => call.args), [
    ['delete', '--raw', fake.deleteOptions[0].path, '-f', '-'],
    ['delete', '--raw', fake.deleteOptions[1].path, '-f', '-'],
  ]);
  assert.equal(fake.calls.some(call => call.args[0] === 'delete' && !call.args.includes('--raw')), false);
  assert.deepEqual(fake.deleted, new Set(['pod', 'policy']));
  assert.deepEqual(await readdir(runDirectory), []);
  assert.doesNotThrow(() => fake.calls.forEach(call => assertRedacted(call.args)));
});

test('Given a Pod replacement during raw deletion, When the original disappears, Then its NetworkPolicy is preserved while a Pod still exists', async t => {
  const runDirectory = await sandbox(t);
  const fake = fakeKubectl(kubeFixtures(), { podReplaceOnDelete: true });
  await assert.rejects(cleanupAuthenticatedEvidenceClient({ descriptor: clientDescriptor(), runId: RUN_ID, runDirectory, executeFile: fake.executeFile }), { reason: 'authenticated_client_cleanup_failed' });
  assert.deepEqual(fake.deleteOptions.map(({ kind }) => kind), ['pod']);
  assert.deepEqual(fake.deleted, new Set());
});

test('Given a stale Pod or NetworkPolicy resourceVersion, When final cleanup preflights the pair, Then no delete request is sent', async t => {
  const cases = [
    { descriptor: clientDescriptor(), options: { podResourceVersion: 'pod-rv-2' } },
    { descriptor: clientDescriptor(), options: { policyResourceVersion: 'policy-rv-2' } },
    { descriptor: clientDescriptor({ podResourceVersion: 'foreign-pod-rv' }), options: {} },
    { descriptor: clientDescriptor({ networkPolicyResourceVersion: 'foreign-policy-rv' }), options: {} },
  ];
  for (const entry of cases) {
    const runDirectory = await sandbox(t);
    const fake = fakeKubectl(kubeFixtures(), entry.options);
    await assert.rejects(cleanupAuthenticatedEvidenceClient({ descriptor: entry.descriptor, runId: RUN_ID, runDirectory, executeFile: fake.executeFile }), error => error.reason === 'authenticated_client_cleanup_failed');
    assert.equal(fake.deleteOptions.length, 0, JSON.stringify(entry));
    assert.deepEqual(fake.deleted, new Set());
  }
});

test('Given a caller-injected valid foreign UID, When final cleanup begins, Then both live client objects are preserved', async t => {
  const runDirectory = await sandbox(t);
  for (const override of [{ podUid: 'foreign-pod-uid' }, { networkPolicyUid: 'foreign-policy-uid' }]) {
    const fake = fakeKubectl();
    await assert.rejects(cleanupAuthenticatedEvidenceClient({ descriptor: clientDescriptor(override), runId: RUN_ID, runDirectory, executeFile: fake.executeFile }), error => error.reason === 'authenticated_client_cleanup_failed');
    assert.deepEqual(fake.deleteOptions, []);
    assert.deepEqual(fake.deleted, new Set());
  }
});

test('Given a swapped Pod UID or resourceVersion, When a protected request starts, Then execution is rejected before kubectl exec', async () => {
  const descriptor = clientDescriptor();
  for (const options of [{ podUid: 'attacker-uid' }, { podResourceVersion: 'pod-rv-2' }]) {
    const fake = fakeKubectl(kubeFixtures(), options);
    await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor, runId: RUN_ID, runDirectory: REQUEST_DIRECTORY, method: 'GET', path: '/api/projects', executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_identity_mismatch');
    assert.equal(fake.calls.some(call => call.args.includes('exec')), false);
  }
});

test('Given a swapped or foreign NetworkPolicy UID, When a protected request starts, Then execution is rejected before kubectl exec', async () => {
  const cases = [
    { fake: fakeKubectl(kubeFixtures(), { policyUid: 'attacker-policy-uid' }), descriptor: clientDescriptor() },
    { fake: fakeKubectl(kubeFixtures()), descriptor: clientDescriptor({ networkPolicyUid: 'foreign-policy-uid' }) },
  ];
  for (const { fake, descriptor } of cases) {
    await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor, runId: RUN_ID, runDirectory: REQUEST_DIRECTORY, method: 'GET', path: '/api/projects', executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_identity_mismatch');
    assert.equal(fake.calls.some(call => call.args.includes('exec')), false);
  }
  for (const override of [{ podResourceVersion: 'secret/value' }, { networkPolicyUid: 'secret/value' }, { networkPolicyResourceVersion: 'secret/value' }]) {
    const untouched = fakeKubectl();
    await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor: clientDescriptor(override), runId: RUN_ID, runDirectory: REQUEST_DIRECTORY, method: 'GET', path: '/api/projects', executeFile: untouched.executeFile, clock: () => NOW }), error => error.reason === 'invalid_authenticated_client_descriptor');
    assert.equal(untouched.calls.length, 0);
  }
});

test('Given an unsafe projected NetworkPolicy UID, When a client is created, Then unprovable cleanup gets the distinct cleanup failure', async t => {
  const runDirectory = await sandbox(t);
  const fake = fakeKubectl(kubeFixtures(), { policyUid: 'secret/value' });
  await assert.rejects(createAuthenticatedEvidenceClient({ runtimeRef, secretRefs, runId: RUN_ID, runDirectory, executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_partial_cleanup_failed');
  assert.equal(fake.calls.some(call => call.args.includes('delete')), false);
});

test('Given a swapped Service UID or expired descriptor, When a protected request starts, Then execution fails closed', async () => {
  const descriptor = clientDescriptor();
  const swapped = fakeKubectl(kubeFixtures(), { serviceUid: 'attacker-service-uid' });
  await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor, runId: RUN_ID, runDirectory: REQUEST_DIRECTORY, method: 'GET', path: '/api/projects', executeFile: swapped.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_identity_mismatch');
  const untouched = fakeKubectl();
  await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor: { ...descriptor, expiresAt: NOW }, runId: RUN_ID, runDirectory: REQUEST_DIRECTORY, method: 'GET', path: '/api/projects', executeFile: untouched.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_expired');
  assert.equal(untouched.calls.length, 0);
});

test('Given an unapproved request shape, When protected execution is requested, Then absolute, traversal, headers, and unknown routes fail locally', async () => {
  const descriptor = clientDescriptor();
  const fake = fakeKubectl();
  for (const request of [
    { method: 'GET', path: 'https://evil.example/api/projects' },
    { method: 'GET', path: '/api/projects/../admin/users' },
    { method: 'GET', path: '/api/admin/users' },
    { method: 'GET', path: '/api/projects', headers: { Authorization: 'hidden' } },
  ]) await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor, runId: RUN_ID, runDirectory: REQUEST_DIRECTORY, executeFile: fake.executeFile, clock: () => NOW, ...request }), error => error.reason === 'invalid_authenticated_request');
  assert.equal(fake.calls.length, 0);
});

test('Given helper output containing bearer material, When a request completes, Then leakage is rejected', async () => {
  const fake = fakeKubectl(kubeFixtures(), { response: { statusCode: 200, body: { message: `Bearer ${'x'.repeat(30)}` } } });
  const descriptor = clientDescriptor();
  await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor, runId: RUN_ID, runDirectory: REQUEST_DIRECTORY, method: 'GET', path: '/api/usage/me', executeFile: fake.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_output_leak');
});

test('Given an opaque session-like value under a harmless key, When a response is projected, Then it is rejected while IDs and digests remain usable', async () => {
  const descriptor = clientDescriptor();
  const leaked = fakeKubectl(kubeFixtures(), { response: { statusCode: 200, body: { value: 'OpaqueSessionMaterialWithoutDigitsXYZ' } } });
  await assert.rejects(executeAuthenticatedEvidenceRequest({ descriptor, runId: RUN_ID, runDirectory: REQUEST_DIRECTORY, method: 'GET', path: '/api/usage/me', executeFile: leaked.executeFile, clock: () => NOW }), error => error.reason === 'authenticated_client_output_leak');
  const safe = fakeKubectl(kubeFixtures(), { response: { statusCode: 200, body: { deploymentId: 'deployment-0123456789-abcdef', imageDigest: `sha256:${'a'.repeat(64)}` } } });
  assert.deepEqual((await executeAuthenticatedEvidenceRequest({ descriptor, runId: RUN_ID, runDirectory: REQUEST_DIRECTORY, method: 'GET', path: '/api/usage/me', executeFile: safe.executeFile, clock: () => NOW })).body, { deploymentId: 'deployment-0123456789-abcdef', imageDigest: `sha256:${'a'.repeat(64)}` });
});
