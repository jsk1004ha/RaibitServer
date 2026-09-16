import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseAllDocuments } from 'yaml';

// Explicit probe, not an optional node:test. verify-helm.sh supplies real Helm
// output, the pinned cel-go executable, and actual Go-generated manifests.
const [render, evaluator, fixture] = process.argv.slice(2);
assert.ok(render && evaluator && fixture, 'render, CEL evaluator and generated recovery fixture are required');
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
  function scenario(name, resource, object, operation, allowed, overrides = {}) {
    const apiGroup = { jobs: 'batch', statefulsets: 'apps', networkpolicies: 'networking.k8s.io', rolebindings: 'rbac.authorization.k8s.io' }[resource] ?? '';
    cases.push({ name, allowed, activation: {
      request: { namespace: 'tenant-a', name: object.metadata.name, operation, resource: { group: apiGroup, version: 'v1', resource },
        userInfo: { username: identity }, dryRun: false, options: { preconditions: { uid: 'uid-1' } } },
      object: operation === 'DELETE' ? null : object,
      oldObject: operation === 'CREATE' ? null : structuredClone(object), namespaceObject: structuredClone(namespaceObject), ...overrides,
    } });
  }
  for (const [resource, kind] of [['networkpolicies', 'NetworkPolicy'], ['secrets', 'Secret'], ['jobs', 'Job'],
    ['services', 'Service'], ['persistentvolumeclaims', 'PersistentVolumeClaim'], ['statefulsets', 'StatefulSet']]) {
    for (const operation of ['CREATE', 'UPDATE', 'DELETE']) {
      scenario(`${operation} arbitrary ${resource}`, resource, { apiVersion: 'v1', kind,
        metadata: { name: 'unrelated', namespace: 'tenant-a', uid: 'uid-1' }, spec: {} }, operation, false);
    }
  }
  const labels = { 'app.kubernetes.io/name': 'database', 'app.kubernetes.io/managed-by': 'raibitserver',
    'raibitserver.io/managed': 'true', 'raibitserver.io/project-id': 'project-1',
    'raibitserver.io/resource-id': 'resource-1', 'raibitserver.io/provider': 'postgresql' };
  const connection = { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', immutable: true,
    metadata: { name: 'database-connection', namespace: 'tenant-a', uid: 'uid-1', labels, annotations: {
      'raibitserver.io/credential-owner': 'raibitserver-provisioner', 'raibitserver.io/credential-generation': 'g'.repeat(43),
      'raibitserver.io/project-id': 'project-1', 'raibitserver.io/resource-id': 'resource-1',
    } }, data: Object.fromEntries(['DATABASE_URL', 'PGDATABASE', 'PGHOST', 'PGPASSWORD', 'PGPORT', 'PGUSER',
      'POSTGRES_DB', 'POSTGRES_PASSWORD', 'POSTGRES_URL', 'POSTGRES_USER'].map(key => [key, 'ZmFrZQ=='])) };
  for (const operation of ['CREATE', 'UPDATE', 'DELETE']) {
    scenario(`${operation} provider connection Secret`, 'secrets', connection, operation, true);
    if (operation === 'UPDATE') cases.at(-1).activation.request.dryRun = true;
  }
  for (const [name, mutate] of [
    ['data', object => { object.data.DATABASE_URL = 'Y2hhbmdlZA=='; }],
    ['type', object => { object.type = 'kubernetes.io/basic-auth'; }],
    ['immutable', object => { object.immutable = false; }],
    ['metadata', object => { object.metadata.annotations.extra = 'changed'; }],
  ]) {
    const changed = structuredClone(connection);
    mutate(changed);
    scenario(`connection inspection cannot change ${name}`, 'secrets', changed, 'UPDATE', false, { oldObject: connection });
    cases.at(-1).activation.request.dryRun = true;
  }
  const foreignConnection = structuredClone(connection);
  delete foreignConnection.metadata.labels;
  scenario('connection inspection cannot adopt unowned Secret', 'secrets', connection, 'UPDATE', false, { oldObject: foreignConnection });
  cases.at(-1).activation.request.dryRun = true;
  scenario('connection inspection is dry-run only', 'secrets', connection, 'UPDATE', false);
  const tenantBinding = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
    metadata: { name: 'raibitserver-provisioner-tenant-access', namespace: 'tenant-a', labels: {
      'app.kubernetes.io/managed-by': 'raibitserver', 'raibitserver.io/managed': 'true', 'raibitserver.io/project-id': 'project-1',
    } }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'raibitserver-provisioner-tenant' },
    subjects: [{ kind: 'ServiceAccount', name: 'raibitserver-provisioner', namespace: 'raibitserver-system' }] };
  for (const operation of ['CREATE', 'UPDATE']) {
    scenario(`${operation} tenant bootstrap binding`, 'rolebindings', tenantBinding, operation, true);
    scenario(`${operation} arbitrary binding name`, 'rolebindings', { ...tenantBinding, metadata: { ...tenantBinding.metadata, name: 'unrelated' } }, operation, false);
  }
  scenario('cannot adopt an unowned tenant binding', 'rolebindings', tenantBinding, 'UPDATE', false, {
    oldObject: { ...tenantBinding, metadata: { ...tenantBinding.metadata, labels: {} } },
  });
  scenario('cannot bind a reader Role to itself', 'rolebindings', { ...tenantBinding,
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'raibitserver-provisioner-secret-reader' },
  }, 'CREATE', false);
  const provider = { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: { name: 'database-provider', namespace: 'tenant-a', uid: 'uid-1', labels }, spec: {
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'database' } }, policyTypes: ['Ingress', 'Egress'], egress: [],
      ingress: [{ from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'tenant-a' } } }],
        ports: [{ protocol: 'TCP', port: 5432 }] }],
    } };
  for (const operation of ['CREATE', 'UPDATE', 'DELETE']) {
    scenario(`${operation} provider policy`, 'networkpolicies', provider, operation, true);
    const foreign = structuredClone(provider);
    delete foreign.metadata.labels;
    scenario(`${operation} unowned reserved provider name`, 'networkpolicies', foreign, operation, false);
    scenario(`${operation} provider in other project`, 'networkpolicies', provider, operation, false, {
      namespaceObject: { metadata: { ...namespaceObject.metadata, labels: { ...namespaceObject.metadata.labels, 'raibitserver.io/project-id': 'other' } } },
    });
  }
  scenario('cannot adopt an unowned policy on UPDATE', 'networkpolicies', provider, 'UPDATE', false, {
    oldObject: { ...provider, metadata: { ...provider.metadata, labels: {} } },
  });
  const suffix = 'a'.repeat(24);
  const recoveryLabels = { 'raibitserver.io/owned-by': 'recovery', 'raibitserver.io/operation': 'operation-1',
    'raibitserver.io/resource': 'resource-1', 'raibitserver.io/attempt': '1', 'raibitserver.io/spec-identity': `rj1-${'a'.repeat(52)}` };
  const recovery = { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: { name: `recovery-egress-${suffix}`, namespace: 'tenant-a', uid: 'uid-1',
      labels: { ...recoveryLabels, 'raibitserver.io/provider': 'postgresql' } }, spec: {
      podSelector: { matchLabels: recoveryLabels }, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [
        { to: [{ podSelector: { matchLabels: { 'raibitserver.io/recovery-authority': 'c'.repeat(32), 'raibitserver.io/provider': 'postgresql' } } }], ports: [{ protocol: 'TCP', port: 5432 }] },
        { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
      ],
    } };
  const recoveryWithoutIngress = structuredClone(recovery);
  delete recoveryWithoutIngress.spec.ingress;
  scenario('CREATE API-normalized recovery NetworkPolicy without ingress field', 'networkpolicies', recoveryWithoutIngress, 'CREATE', true);
  const recoveryWithIngressRule = structuredClone(recovery);
  recoveryWithIngressRule.spec.ingress = [{}];
  scenario('CREATE recovery NetworkPolicy rejects a nonempty ingress rule', 'networkpolicies', recoveryWithIngressRule, 'CREATE', false);
  const snapshot = { apiVersion: 'v1', kind: 'Secret', metadata: { name: `recovery-credential-${suffix}`, namespace: 'tenant-a', uid: 'uid-1', labels: recoveryLabels,
    annotations: { 'raibitserver.io/source-secret-uid': 'source-uid', 'raibitserver.io/source-secret-resource-version': '19', 'raibitserver.io/source-secret-key': 'DATABASE_URL' } },
    type: 'Opaque', immutable: true, data: { DATABASE_URL: 'ZmFrZQ==' } };
  for (const [resource, object] of [['networkpolicies', provider], ['networkpolicies', recovery], ['secrets', connection], ['secrets', snapshot]]) {
    for (const options of [{}, { preconditions: { uid: 'replacement-uid' } }]) {
      scenario(`DELETE ${object.metadata.name} requires the old UID`, resource, object, 'DELETE', false);
      cases.at(-1).activation.request.options = options;
    }
  }
  scenario('snapshot collision verification uses no-op dry-run PATCH', 'secrets', snapshot, 'UPDATE', true);
  cases.at(-1).activation.request.dryRun = true;
  const changedSnapshot = structuredClone(snapshot);
  changedSnapshot.data.DATABASE_URL = 'Y2hhbmdlZA==';
  scenario('snapshot collision verification cannot change data', 'secrets', changedSnapshot, 'UPDATE', false, { oldObject: snapshot });
  cases.at(-1).activation.request.dryRun = true;
  const jobLabels = { ...recoveryLabels, 'raibitserver.io/credential-snapshot': snapshot.metadata.name };
  const job = { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: `recovery-job-${suffix}`, namespace: 'tenant-a', uid: 'uid-1', labels: jobLabels,
    annotations: { 'raibitserver.io/spec-identity': `recovery-job/v1:sha256:${'0'.repeat(64)}` } }, spec: {
    backoffLimit: 0, activeDeadlineSeconds: 600, template: { metadata: { labels: { ...jobLabels } }, spec: { automountServiceAccountToken: false, restartPolicy: 'Never', containers: [{ image: `tool@sha256:${'d'.repeat(64)}`,
      securityContext: { runAsNonRoot: true, readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } } }] } },
  } };
  const normalizedJob = structuredClone(job);
  Object.assign(normalizedJob.spec.template.metadata.labels, {
    'job-name': job.metadata.name, 'batch.kubernetes.io/job-name': job.metadata.name,
    'controller-uid': job.metadata.uid, 'batch.kubernetes.io/controller-uid': job.metadata.uid,
  });
  scenario('API-normalized recovery Job', 'jobs', normalizedJob, 'CREATE', true);
  const terminalTTLJob = structuredClone(job);
  terminalTTLJob.spec.ttlSecondsAfterFinished = 600;
  terminalTTLJob.status = { startTime: '2026-09-12T14:48:00Z', completionTime: '2026-09-12T14:49:00Z', succeeded: 1, conditions: [
    { type: 'SuccessCriteriaMet', status: 'True', lastTransitionTime: '2026-09-12T14:49:00Z' },
    { type: 'Complete', status: 'True', lastTransitionTime: '2026-09-12T14:49:00Z' },
  ] };
  for (const username of ['system:kube-controller-manager', 'system:serviceaccount:kube-system:ttl-after-finished-controller']) {
    scenario(`native TTL DELETE by ${username}`, 'jobs', terminalTTLJob, 'DELETE', true);
    cases.at(-1).activation.request.userInfo.username = username;
  }
  const activeTTLJob = structuredClone(terminalTTLJob);
  activeTTLJob.status.conditions = [];
  scenario('native TTL controller cannot delete an active recovery Job', 'jobs', activeTTLJob, 'DELETE', false);
  cases.at(-1).activation.request.userInfo.username = 'system:kube-controller-manager';
  const wrongTTLJob = structuredClone(terminalTTLJob);
  wrongTTLJob.spec.ttlSecondsAfterFinished = 599;
  scenario('native TTL controller cannot delete a recovery Job with a different TTL', 'jobs', wrongTTLJob, 'DELETE', false);
  cases.at(-1).activation.request.userInfo.username = 'system:kube-controller-manager';
  scenario('native TTL controller requires the exact recovery Job UID', 'jobs', terminalTTLJob, 'DELETE', false);
  cases.at(-1).activation.request.userInfo.username = 'system:kube-controller-manager';
  cases.at(-1).activation.request.options.preconditions.uid = 'stale-uid';
  scenario('native TTL controller cannot create a recovery Job', 'jobs', terminalTTLJob, 'CREATE', false);
  cases.at(-1).activation.request.userInfo.username = 'system:kube-controller-manager';
  const deletingTTLJob = structuredClone(terminalTTLJob);
  Object.assign(deletingTTLJob.metadata, {
    resourceVersion: '7', generation: 1, creationTimestamp: '2026-09-12T14:47:00Z', deletionTimestamp: '2026-09-12T15:00:00Z',
  });
  deletingTTLJob.metadata.finalizers = ['foregroundDeletion'];
  const finalizedTTLJob = structuredClone(deletingTTLJob);
  delete finalizedTTLJob.metadata.finalizers;
  for (const username of ['system:kube-controller-manager', 'system:serviceaccount:kube-system:generic-garbage-collector']) {
    scenario(`generic GC foreground finalizer removal by ${username}`, 'jobs', finalizedTTLJob, 'UPDATE', true, { oldObject: deletingTTLJob });
    cases.at(-1).activation.request.userInfo.username = username;
  }
  const gcSpecMutation = structuredClone(finalizedTTLJob);
  gcSpecMutation.spec.ttlSecondsAfterFinished = 599;
  scenario('generic GC cannot mutate recovery Job spec', 'jobs', gcSpecMutation, 'UPDATE', false, { oldObject: deletingTTLJob });
  cases.at(-1).activation.request.userInfo.username = 'system:kube-controller-manager';
  const deletingJobWithOtherFinalizer = structuredClone(deletingTTLJob);
  deletingJobWithOtherFinalizer.metadata.finalizers.push('example.test/stable');
  scenario('generic GC cannot remove another recovery Job finalizer', 'jobs', finalizedTTLJob, 'UPDATE', false, { oldObject: deletingJobWithOtherFinalizer });
  cases.at(-1).activation.request.userInfo.username = 'system:kube-controller-manager';
  const gcLabelMutation = structuredClone(finalizedTTLJob);
  gcLabelMutation.metadata.labels['raibitserver.io/operation'] = 'changed';
  scenario('generic GC cannot mutate recovery Job labels', 'jobs', gcLabelMutation, 'UPDATE', false, { oldObject: deletingTTLJob });
  cases.at(-1).activation.request.userInfo.username = 'system:kube-controller-manager';
  const activeDeletingJob = structuredClone(deletingTTLJob);
  activeDeletingJob.status.conditions = [];
  const finalizedActiveJob = structuredClone(activeDeletingJob);
  delete finalizedActiveJob.metadata.finalizers;
  scenario('generic GC cannot finalize an active recovery Job', 'jobs', finalizedActiveJob, 'UPDATE', false, { oldObject: activeDeletingJob });
  cases.at(-1).activation.request.userInfo.username = 'system:kube-controller-manager';
  for (const [name, annotation] of [['missing', undefined], ['truncated', 'recovery-job/v1:sha256:abcd'],
    ['version', `recovery-job/v2:sha256:${'0'.repeat(64)}`]]) {
    const changed = structuredClone(job);
    changed.metadata.annotations = annotation === undefined ? {} : { 'raibitserver.io/spec-identity': annotation };
    scenario(`recovery Job rejects ${name} canonical annotation`, 'jobs', changed, 'CREATE', false);
  }
  for (const [resource, object] of [['secrets', snapshot], ['jobs', job], ['networkpolicies', recovery]]) {
    for (const label of [`recovery-job/v1:sha256:${'0'.repeat(64)}`, `rj1-${'a'.repeat(51)}`, `rj1-${'a'.repeat(51)}b`]) {
      const changed = structuredClone(object);
      changed.metadata.labels['raibitserver.io/spec-identity'] = label;
      scenario(`recovery ${resource} rejects noncanonical digest label ${label}`, resource, changed, 'CREATE', false);
    }
  }
  const jobWithForeignSecret = structuredClone(job);
  jobWithForeignSecret.spec.template.spec.volumes = [{ name: 'stolen', secret: { secretName: 'application-token' } }];
  scenario('recovery Job cannot bypass Secret GET RBAC via volume', 'jobs', jobWithForeignSecret, 'CREATE', false);
  const jobWithEmptyPullSecrets = structuredClone(job);
  jobWithEmptyPullSecrets.spec.template.spec.imagePullSecrets = [];
  scenario('recovery Job permits empty imagePullSecrets', 'jobs', jobWithEmptyPullSecrets, 'CREATE', true);
  for (const [name, mutate] of [
    ['imagePullSecrets', pod => { pod.imagePullSecrets = [{ name: 'tenant-registry' }]; }],
    ['env', pod => { pod.containers[0].env = [{ name: 'STOLEN', valueFrom: { secretKeyRef: { name: 'application-token', key: 'token' } } }]; }],
    ['envFrom', pod => { pod.containers[0].envFrom = [{ secretRef: { name: 'application-token' } }]; }],
    ['init envFrom', pod => { pod.initContainers = [{ ...structuredClone(pod.containers[0]), envFrom: [{ secretRef: { name: 'application-token' } }] }]; }],
    ['projected volume', pod => { pod.volumes = [{ name: 'stolen', projected: { sources: [{ secret: { name: 'application-token' } }] } }]; }],
  ]) {
    const changed = structuredClone(job);
    mutate(changed.spec.template.spec);
    scenario(`recovery Job cannot bypass Secret GET RBAC via ${name}`, 'jobs', changed, 'CREATE', false);
  }
  {
    const fixtures = JSON.parse(readFileSync(fixture, 'utf8'));
    for (const [direction, generated] of [['backup', fixtures], ['restore', fixtures.restore]]) {
      assert.ok(generated, `generated ${direction} manifests are required`);
      for (const [resource, key] of [['networkpolicies', 'policy'], ['secrets', 'snapshot'], ['jobs', 'job']]) {
        const manifest = generated[key];
        const ns = structuredClone(namespaceObject);
        ns.metadata.name = manifest.metadata.namespace;
        ns.metadata.labels['kubernetes.io/metadata.name'] = manifest.metadata.namespace;
        for (const operation of ['CREATE', 'DELETE']) {
          manifest.metadata.uid = 'uid-1';
          scenario(`${operation} real generated ${direction} ${resource}`, resource, manifest, operation, true, { namespaceObject: ns });
          cases.at(-1).activation.request.namespace = manifest.metadata.namespace;
        }
      }
    }
  }
  for (const [resource, object] of [['networkpolicies', recovery], ['secrets', snapshot], ['jobs', job]]) {
    for (const operation of ['CREATE', 'UPDATE', 'DELETE']) {
      scenario(`${operation} recovery ${resource}`, resource, object, operation, operation !== 'UPDATE');
      const foreign = structuredClone(object);
      delete foreign.metadata.labels;
      scenario(`${operation} unowned reserved recovery ${resource}`, resource, foreign, operation, false);
      const wrongNamespace = structuredClone(namespaceObject);
      wrongNamespace.metadata.labels['raibitserver.io/namespace-kind'] = 'build';
      scenario(`${operation} recovery outside application namespace ${resource}`, resource, object, operation, false, { namespaceObject: wrongNamespace });
    }
  }
  const input = { policies: documents.filter(doc => doc.kind === 'ValidatingAdmissionPolicy'),
    bindings: documents.filter(doc => doc.kind === 'ValidatingAdmissionPolicyBinding'), cases };
  const result = spawnSync(evaluator, [], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const observations = JSON.parse(result.stdout);
  assert.equal(observations.length, cases.length);
  const failures = observations.flatMap((observation, index) => observation.allowed === cases[index].allowed ? [] : [`${cases[index].name}: ${JSON.stringify(observation)}`]);
  assert.deepEqual(failures, []);
  console.log(`cel-go evaluated ${cases.length} admission cases against all rendered policies and bindings`);
