import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const security = readFileSync('infra/helm/raibitserver/templates/worker-security.yaml', 'utf8');
const authorityKey = 'raibitserver.io/recovery-authority';
const providerKey = 'raibitserver.io/provider';
const providerPorts = { postgresql: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379, valkey: 6379 };
const namespaceLabels = {
  'kubernetes.io/metadata.name': 'tenant-a',
  'app.kubernetes.io/managed-by': 'raibitserver',
  'raibitserver.io/managed': 'true',
  'raibitserver.io/namespace-kind': 'application',
  'raibitserver.io/project': 'demo',
  'raibitserver.io/project-id': 'project-1',
  'pod-security.kubernetes.io/enforce': 'restricted',
  'pod-security.kubernetes.io/audit': 'restricted',
  'pod-security.kubernetes.io/warn': 'restricted',
};

function documentNamed(name, kind) {
  return security.split(/^---$/m).find(document => document.includes(`kind: ${kind}`) && document.includes(`name: {{ include "raibitserver.fullname" . }}-${name}`)) ?? '';
}

function compact(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function exactManagedApplication(labels) {
  return Object.keys(labels).length === Object.keys(namespaceLabels).length &&
    Object.keys(namespaceLabels).every(key => key in labels) &&
    labels['app.kubernetes.io/managed-by'] === 'raibitserver' &&
    labels['raibitserver.io/managed'] === 'true' &&
    labels['raibitserver.io/namespace-kind'] === 'application' &&
    labels['raibitserver.io/project-id'] !== '' &&
    ['enforce', 'audit', 'warn'].every(level => labels[`pod-security.kubernetes.io/${level}`] === 'restricted');
}

function providerPod(authority) {
  const labels = {
    'app.kubernetes.io/name': 'database',
    'app.kubernetes.io/managed-by': 'raibitserver',
    'raibitserver.io/managed': 'true',
    'raibitserver.io/project-id': 'project-1',
    'raibitserver.io/resource-id': 'resource-1',
    [providerKey]: 'postgresql',
  };
  if (authority !== undefined) labels[authorityKey] = authority;
  return {
    metadata: {
      name: 'database-0', namespace: 'tenant-a', uid: 'pod-uid', labels,
      annotations: { stable: 'yes' }, finalizers: ['stable'],
      ownerReferences: [{ apiVersion: 'apps/v1', kind: 'StatefulSet', name: 'database', controller: true }],
    },
    spec: { containers: [{ image: 'provider@sha256:fixed' }] },
  };
}

function allowsAuthorityPatch(namespace, before, after) {
  const exactAuthority = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
  const oldLabels = before.metadata.labels;
  const newLabels = after.metadata.labels;
  const transition = (!(authorityKey in oldLabels) && exactAuthority(newLabels[authorityKey])) ||
    (exactAuthority(oldLabels[authorityKey]) && !(authorityKey in newLabels));
  const stableLabels = Object.keys(oldLabels).every(key => key === authorityKey || newLabels[key] === oldLabels[key]) &&
    Object.keys(newLabels).every(key => key === authorityKey || oldLabels[key] === newLabels[key]);
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  return exactManagedApplication(namespace) && transition && stableLabels &&
    ['name', 'namespace', 'uid', 'annotations', 'ownerReferences', 'finalizers'].every(key => equal(before.metadata[key], after.metadata[key])) &&
    equal(before.spec, after.spec);
}

function generatedRecoveryPolicy() {
  const go = process.env.RAIBIT_GO || 'go';
  const result = spawnSync(go, ['test', './internal/backup', '-run', '^Test_RecoveryNetworkPolicyManifest_emits_admission_fixture$', '-count=1', '-v'], {
    cwd: 'services/provisioner', encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const payload = result.stdout.match(/ADMISSION_FIXTURE=(\{.*\})/)?.[1];
  assert.ok(payload, result.stdout);
  return JSON.parse(payload);
}

function allowsRecoveryPolicy(policy) {
  const metadata = policy.metadata;
  const spec = policy.spec;
  const providerRule = spec.egress?.[0];
  const dnsRule = spec.egress?.[1];
  const selector = providerRule?.to?.[0]?.podSelector?.matchLabels;
  const engine = metadata.labels?.[providerKey];
  const exactAuthority = typeof selector?.[authorityKey] === 'string' && /^[a-f0-9]{32}$/.test(selector[authorityKey]);
  const exactProvider = selector && Object.keys(selector).length === 2 && selector[providerKey] === engine;
  const exactPort = providerRule?.ports?.length === 1 && providerRule.ports[0].protocol === 'TCP' &&
    Number.isInteger(providerRule.ports[0].port) && providerRule.ports[0].port === providerPorts[engine];
  const jobSelector = spec.podSelector?.matchLabels ?? {};
  const exactJobSelector = Object.keys(jobSelector).length === Object.keys(metadata.labels).length - 1 &&
    Object.entries(metadata.labels).every(([key, value]) => key === providerKey || jobSelector[key] === value);
  const dnsPeer = dnsRule?.to?.[0];
  const dnsPorts = dnsRule?.ports ?? [];
  const exactDNS = dnsRule?.to?.length === 1 && Object.keys(dnsPeer).length === 2 &&
    JSON.stringify(dnsPeer.namespaceSelector) === JSON.stringify({ matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }) &&
    JSON.stringify(dnsPeer.podSelector) === JSON.stringify({ matchLabels: { 'k8s-app': 'kube-dns' } }) &&
    dnsPorts.length === 2 && dnsPorts.every(port => port.port === 53 && ['UDP', 'TCP'].includes(port.protocol)) &&
    dnsPorts.some(port => port.protocol === 'UDP') && dnsPorts.some(port => port.protocol === 'TCP');
  return Object.hasOwn(providerPorts, engine) && exactAuthority && exactProvider && exactPort && exactDNS &&
    metadata.labels['raibitserver.io/owned-by'] === 'recovery' &&
    spec.policyTypes?.join(',') === 'Ingress,Egress' && spec.ingress?.length === 0 && spec.egress?.length === 2 &&
    exactJobSelector;
}

function allowsRecoveryPolicyOperation(operation, policy, preconditionUID) {
  if (operation === 'CREATE') return allowsRecoveryPolicy(policy);
  if (operation === 'UPDATE') return false;
  return operation === 'DELETE' && preconditionUID === policy.metadata.uid;
}

test('globally bound recovery authority fails closed outside an exact application namespace', () => {
  const bootstrapRole = documentNamed('provisioner', 'ClusterRole');
  const tenantRole = documentNamed('provisioner-tenant', 'ClusterRole');
  const roleBindingPolicy = compact(documentNamed('provisioner-rolebinding-boundary', 'ValidatingAdmissionPolicy'));
  const roleBindingBinding = compact(documentNamed('provisioner-rolebinding-boundary', 'ValidatingAdmissionPolicyBinding'));
  const podPolicy = compact(documentNamed('provisioner-recovery-provider-pods', 'ValidatingAdmissionPolicy'));
  const podBinding = compact(documentNamed('provisioner-recovery-provider-pods', 'ValidatingAdmissionPolicyBinding'));
  const podRule = tenantRole.match(/resources: \["pods"\]\s*\n\s*verbs: \[([^\]]+)\]/)?.[1] ?? '';

  assert.equal(podRule, '"get", "list", "patch"');
  assert.doesNotMatch(bootstrapRole, /resources: \["pods(?:\/[^"\]]*)?"\]/);
  assert.match(roleBindingPolicy, /namespaceObject\.metadata\.labels\.size\(\) == 9/);
  assert.doesNotMatch(roleBindingBinding, /namespaceSelector:/);
  assert.match(podPolicy, /namespaceObject\.metadata\.labels\.size\(\) == 9/);
  assert.doesNotMatch(podBinding, /namespaceSelector:/);
  assert.equal(exactManagedApplication(namespaceLabels), true);
  for (const key of Object.keys(namespaceLabels)) {
    const partial = { ...namespaceLabels };
    delete partial[key];
    assert.equal(exactManagedApplication(partial), false, `missing ${key}`);
  }
  assert.equal(exactManagedApplication({ ...namespaceLabels, 'raibitserver.io/managed': 'false' }), false);
  assert.equal(exactManagedApplication({ ...namespaceLabels, 'raibitserver.io/namespace-kind': 'other' }), false);
});

test('recovery authority update changes only an absent or exact-shaped authority label', () => {
  const policy = compact(documentNamed('provisioner-recovery-provider-pods', 'ValidatingAdmissionPolicy'));
  const before = providerPod();
  const after = providerPod('a'.repeat(32));

  assert.match(policy, /metadata\.finalizers/);
  assert.equal(allowsAuthorityPatch(namespaceLabels, before, after), true);
  assert.equal(allowsAuthorityPatch(namespaceLabels, after, before), true);
  assert.equal(allowsAuthorityPatch(namespaceLabels, providerPod(''), after), false);
  for (const mutate of [
    pod => pod.metadata.finalizers.push('hostage'),
    pod => { pod.metadata.annotations.stable = 'changed'; },
    pod => { pod.metadata.name = 'other-0'; },
    pod => { pod.metadata.namespace = 'other'; },
    pod => { pod.metadata.uid = 'other-uid'; },
    pod => { pod.metadata.ownerReferences[0].name = 'other'; },
    pod => { pod.metadata.labels.extra = 'attacker'; },
    pod => { pod.spec.containers[0].image = 'attacker'; },
  ]) {
    const changed = structuredClone(after);
    mutate(changed);
    assert.equal(allowsAuthorityPatch(namespaceLabels, before, changed), false);
  }
});

test('real generated recovery NetworkPolicy satisfies the engine-bound admission model', () => {
  const policyText = compact(documentNamed('provisioner-recovery-networkpolicies', 'ValidatingAdmissionPolicy'));
  const manifest = generatedRecoveryPolicy();

  assert.match(policyText, /type\(variables\.providerRule\.ports\[0\]\.port\) == int/);
  assert.match(policyText, /variables\.providerPeer\.podSelector\.matchLabels\['raibitserver\.io\/provider'\] == variables\.provider/);
  assert.match(policyText, /object\.spec\.podSelector\.matchLabels\.size\(\) == 5/);
  assert.match(policyText, /object\.metadata\.labels\.size\(\) == 6/);
  assert.match(policyText, /request\.operation != 'UPDATE'/);
  assert.match(policyText, /request\.options\.preconditions\.uid == oldObject\.metadata\.uid/);
  assert.equal(allowsRecoveryPolicyOperation('CREATE', manifest), true);
  const persisted = structuredClone(manifest);
  persisted.metadata.uid = 'policy-uid';
  assert.equal(allowsRecoveryPolicyOperation('UPDATE', persisted), false);
  assert.equal(allowsRecoveryPolicyOperation('DELETE', persisted, 'wrong-uid'), false);
  assert.equal(allowsRecoveryPolicyOperation('DELETE', persisted, 'policy-uid'), true);

  const mutations = [
    policy => { policy.spec.egress[0].ports[0].port = 3306; },
    policy => { policy.spec.egress[0].to[0].podSelector.matchLabels[providerKey] = 'mysql'; },
    policy => { delete policy.metadata.labels[providerKey]; },
    policy => { delete policy.spec.egress[0].to[0].podSelector.matchLabels[authorityKey]; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(manifest);
    mutate(changed);
    assert.equal(allowsRecoveryPolicy(changed), false);
  }
});
