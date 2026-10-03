import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseAllDocuments } from 'yaml';

// Reuse the pinned CEL evaluator without depending on provider manifest generation.
const [render, evaluator] = process.argv.slice(2);
assert.ok(render && evaluator, 'render and CEL evaluator are required');
const fullname = 'raibitserver';
const identity = `system:serviceaccount:raibitserver-system:${fullname}-provisioner`;
const documents = parseAllDocuments(readFileSync(render, 'utf8')).map(doc => doc.toJS()).filter(Boolean);
const namespaceObject = { metadata: { name: 'tenant-a', labels: {
  'kubernetes.io/metadata.name': 'tenant-a', 'app.kubernetes.io/managed-by': 'raibitserver',
  'raibitserver.io/managed': 'true', 'raibitserver.io/namespace-kind': 'application',
  'raibitserver.io/project': 'demo', 'raibitserver.io/project-id': 'project-1',
  'pod-security.kubernetes.io/enforce': 'restricted', 'pod-security.kubernetes.io/audit': 'restricted',
  'pod-security.kubernetes.io/warn': 'restricted',
} } };
const cases = [];
function scenario(name, resource, object, operation, allowed) {
  cases.push({ name, allowed, activation: {
    request: { namespace: 'tenant-a', name: object.metadata.name, operation,
      resource: { group: resource === 'rolebindings' ? 'rbac.authorization.k8s.io' : '', version: 'v1', resource }, userInfo: { username: identity },
      dryRun: false, options: { preconditions: { uid: 'uid-1' } } },
    object: operation === 'DELETE' ? null : structuredClone(object),
    oldObject: operation === 'CREATE' ? null : structuredClone(object),
    namespaceObject: structuredClone(namespaceObject),
  } });
}
const connection = { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', immutable: true,
  metadata: { name: 'database-connection', namespace: 'tenant-a', uid: 'uid-1', labels: {
    'app.kubernetes.io/name': 'database', 'app.kubernetes.io/managed-by': 'raibitserver',
    'raibitserver.io/managed': 'true', 'raibitserver.io/project-id': 'project-1',
    'raibitserver.io/resource-id': 'resource-1', 'raibitserver.io/provider': 'postgresql',
  } }, data: { DATABASE_URL: 'ZmFrZQ==' } };
const orchestratorIdentity = `system:serviceaccount:raibitserver-system:${fullname}-orchestrator`;
const orchestratorRole = documents.find(doc => doc.kind === 'ClusterRole' && doc.metadata.name === `${fullname}-orchestrator`);
assert.ok(orchestratorRole.rules.every(rule => !rule.resources.includes('secrets') && !rule.resources.includes('*')),
  'cluster-bound orchestrator authority must not include Secret reads or mutations');
const secretRoleName = `${fullname}-template-secrets`;
const secretRole = documents.find(doc => doc.kind === 'ClusterRole' && doc.metadata.name === secretRoleName);
assert.deepEqual(secretRole.rules, [{ apiGroups: [''], resources: ['secrets'], verbs: ['get', 'list', 'create', 'delete'] }]);
assert.ok(documents.every(doc => doc.kind !== 'ClusterRoleBinding' || doc.roleRef.name !== secretRoleName),
  'Secret access must be bound per tenant namespace');
assert.deepEqual(orchestratorRole.rules.filter(rule => rule.verbs.includes('bind')), [{ apiGroups: ['rbac.authorization.k8s.io'],
  resources: ['clusterroles'], resourceNames: [secretRoleName], verbs: ['bind'] }]);
assert.deepEqual(orchestratorRole.rules.filter(rule => rule.resources.includes('rolebindings')), [{ apiGroups: ['rbac.authorization.k8s.io'],
  resources: ['rolebindings'], verbs: ['get', 'create'] }]);
for (const resource of ['pods', 'replicasets', 'statefulsets', 'daemonsets']) {
  const rules = orchestratorRole.rules.filter(rule => rule.resources.includes(resource));
  assert.equal(rules.length, 1);
  assert.deepEqual([...rules[0].verbs].sort(), ['get', 'list']);
}
const secretBinding = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
  metadata: { name: 'raibitserver-template-secrets', namespace: 'tenant-a', labels: {
    'app.kubernetes.io/managed-by': 'raibitserver', 'raibitserver.io/managed': 'true', 'raibitserver.io/project-id': 'project-1',
  } }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: secretRoleName },
  subjects: [{ kind: 'ServiceAccount', name: `${fullname}-orchestrator`, namespace: 'raibitserver-system' }] };
function bindingScenario(name, object, operation, allowed) {
  scenario(name, 'rolebindings', object, operation, allowed);
  cases.at(-1).activation.request.userInfo.username = orchestratorIdentity;
  return cases.at(-1).activation;
}
bindingScenario('bootstrap template Secret access inside owned namespace', secretBinding, 'CREATE', true);
for (const [name, mutate] of [
  ['name', object => { object.metadata.name = 'other'; }],
  ['namespace', object => { object.metadata.namespace = 'other'; }],
  ['project', object => { object.metadata.labels['raibitserver.io/project-id'] = 'other'; }],
  ['owner', object => { object.metadata.labels['app.kubernetes.io/managed-by'] = 'other'; }],
  ['extra label', object => { object.metadata.labels.extra = 'value'; }],
  ['own broad role', object => { object.roleRef.name = `${fullname}-orchestrator`; }],
  ['cluster admin', object => { object.roleRef.name = 'cluster-admin'; }],
  ['role kind', object => { object.roleRef.kind = 'Role'; }],
  ['other account', object => { object.subjects[0].name = 'other'; }],
  ['other account namespace', object => { object.subjects[0].namespace = 'other'; }],
  ['extra subject', object => { object.subjects.push({ kind: 'Group', name: 'system:authenticated' }); }],
  ['finalizer', object => { object.metadata.finalizers = ['example.com/hold']; }],
]) {
  const changed = structuredClone(secretBinding);
  mutate(changed);
  bindingScenario(`bootstrap denies ${name}`, changed, 'CREATE', false);
}
for (const operation of ['UPDATE', 'DELETE']) bindingScenario(`bootstrap denies ${operation}`, secretBinding, operation, false);
for (const [key, value] of [['raibitserver.io/namespace-kind', 'build'], ['raibitserver.io/project-id', 'other'],
  ['app.kubernetes.io/managed-by', 'other'], ['raibitserver.io/managed', 'false'], ['pod-security.kubernetes.io/enforce', 'baseline']]) {
  bindingScenario(`bootstrap denies namespace ${key}=${value}`, secretBinding, 'CREATE', false).namespaceObject.metadata.labels[key] = value;
}
const templateSecretID = 'a'.repeat(40);
const templateSecret = { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', immutable: true,
  metadata: { name: `rb-template-${templateSecretID}`, namespace: 'tenant-a', uid: 'uid-1', resourceVersion: '17', labels: {
    'app.kubernetes.io/managed-by': 'raibitserver-template-runtime', 'raibitserver.io/project-id': 'project-1',
    'raibitserver.io/environment-id': 'environment-1', 'raibitserver.io/service-id': 'service-1',
    'raibitserver.io/deployment-id': 'deployment-1', 'raibitserver.io/template-secret-id': templateSecretID,
  } }, data: { PASSWORD: 'ZmFrZQ==' } };
function templateScenario(name, object, operation, allowed) {
  scenario(name, 'secrets', object, operation, allowed);
  cases.at(-1).activation.request.userInfo.username = orchestratorIdentity;
  cases.at(-1).activation.request.options.preconditions.resourceVersion = '17';
  return cases.at(-1).activation;
}
for (const operation of ['CREATE', 'DELETE']) {
  templateScenario(`${operation} template runtime Secret`, templateSecret, operation, true);
  templateScenario(`${operation} orchestrator cannot mutate provider Secret`, connection, operation, false);
  for (const [name, mutate] of [
    ['foreign project', object => { object.metadata.labels['raibitserver.io/project-id'] = 'other'; }],
    ['missing environment', object => { delete object.metadata.labels['raibitserver.io/environment-id']; }],
    ['empty service', object => { object.metadata.labels['raibitserver.io/service-id'] = ''; }],
    ['empty deployment', object => { object.metadata.labels['raibitserver.io/deployment-id'] = ''; }],
    ['foreign owner', object => { object.metadata.labels['app.kubernetes.io/managed-by'] = 'raibitserver'; }],
    ['unowned collision', object => { delete object.metadata.labels; }],
    ['additional label', object => { object.metadata.labels.unexpected = 'value'; }],
    ['mismatched name', object => { object.metadata.name = `rb-template-${'b'.repeat(40)}`; }],
    ['invalid secret ID', object => { object.metadata.labels['raibitserver.io/template-secret-id'] = 'A'.repeat(40); }],
    ['foreign namespace', object => { object.metadata.namespace = 'tenant-b'; }],
    ['mutable data', object => { object.immutable = false; }],
    ['wrong type', object => { object.type = 'kubernetes.io/service-account-token'; }],
    ['empty data', object => { object.data = {}; }],
    ['owner reference', object => { object.metadata.ownerReferences = [{ uid: 'owner' }]; }],
    ['finalizer', object => { object.metadata.finalizers = ['example.com/hold']; }],
  ]) {
    const changed = structuredClone(templateSecret);
    mutate(changed);
    templateScenario(`${operation} template rejects ${name}`, changed, operation, false);
  }
  for (const [key, value] of [['raibitserver.io/namespace-kind', 'build'], ['raibitserver.io/project-id', 'other'],
    ['app.kubernetes.io/managed-by', 'other'], ['raibitserver.io/managed', 'false'], ['pod-security.kubernetes.io/enforce', 'baseline']]) {
    const activation = templateScenario(`${operation} template rejects namespace ${key}=${value}`, templateSecret, operation, false);
    activation.namespaceObject.metadata.labels[key] = value;
  }
  scenario(`${operation} provisioner cannot mutate template Secret`, 'secrets', templateSecret, operation, false);
}
templateScenario('template Secrets cannot be updated', templateSecret, 'UPDATE', false);
templateScenario('orchestrator cannot adopt an unowned Secret on UPDATE', templateSecret, 'UPDATE', false).oldObject = {
  ...templateSecret, metadata: { ...templateSecret.metadata, labels: {} },
};
for (const options of [{}, { preconditions: { uid: 'replacement-uid', resourceVersion: '17' } },
  { preconditions: { uid: 'uid-1' } }, { preconditions: { uid: 'uid-1', resourceVersion: '18' } },
  { preconditions: { uid: 'uid-1', resourceVersion: '17' }, ignoreStoreReadErrorWithClusterBreakingPotential: true }]) {
  templateScenario('template deletion requires a safe exact UID precondition', templateSecret, 'DELETE', false).request.options = options;
}
for (const username of ['tenant-writer', 'system:kube-controller-manager',
  'system:serviceaccount:kube-system:namespace-controller', 'system:serviceaccount:kube-system:generic-garbage-collector']) {
  for (const operation of ['CREATE', 'UPDATE', 'DELETE']) {
    templateScenario(`${username} cannot mutate reserved template Secrets`, templateSecret, operation, false).request.userInfo.username = username;
  }
  const cleanup = templateScenario(`${username} namespace cleanup`, templateSecret, 'DELETE', username !== 'tenant-writer');
  cleanup.request.userInfo.username = username;
  cleanup.request.options = {};
  cleanup.namespaceObject.metadata.deletionTimestamp = '2026-09-30T00:00:00Z';
}
const adoption = templateScenario('tenant writer cannot add template ownership to an existing Secret', {
  ...templateSecret, metadata: { ...templateSecret.metadata, name: 'unreserved' },
}, 'UPDATE', false);
adoption.request.userInfo.username = 'tenant-writer';
adoption.oldObject.metadata.labels = {};
const input = { policies: documents.filter(doc => doc.kind === 'ValidatingAdmissionPolicy'),
  bindings: documents.filter(doc => doc.kind === 'ValidatingAdmissionPolicyBinding'), cases };
const result = spawnSync(evaluator, [], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
const observations = JSON.parse(result.stdout);
assert.equal(observations.length, cases.length);
const failures = observations.flatMap((observation, index) => observation.allowed === cases[index].allowed ? [] : [`${cases[index].name}: ${JSON.stringify(observation)}`]);
assert.deepEqual(failures, []);
console.log(`cel-go evaluated ${cases.length} template Secret admission cases against all rendered policies and bindings`);
