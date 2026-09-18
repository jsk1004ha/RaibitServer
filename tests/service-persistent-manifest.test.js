import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject } from '../packages/core/src/manifest-compiler.ts';

function compilePersistent(service = {}) {
  return compileProject({
    organization: { id: 'organization-id', slug: 'acme' },
    project: { id: 'project-id', slug: 'trainer' },
    services: [{
      id: 'service-id',
      name: 'trainer',
      type: 'worker',
      sourceType: 'image',
      image: 'registry.example/trainer:1',
      persistence: { sizeGi: 20, mountPath: '/data/flyfight' },
      scaling: { minReplicas: 1, maxReplicas: 1 },
      replicas: 1,
      ...service,
    }],
    resources: [],
  });
}

function manifest(plan, kind) {
  return plan.manifests.find((item) => item.kind === kind);
}

test('persistent service emits a stable isolated PVC and mounts it into a singleton Recreate deployment', () => {
  const first = compilePersistent();
  const second = compilePersistent();
  const pvc = manifest(first, 'PersistentVolumeClaim');
  const repeatedPvc = manifest(second, 'PersistentVolumeClaim');
  const deployment = manifest(first, 'Deployment');
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];

  assert.equal(pvc.metadata.name, 'trainer-data');
  assert.equal(pvc.metadata.namespace, first.metadata.namespace);
  assert.equal(repeatedPvc.metadata.name, pvc.metadata.name);
  assert.equal(repeatedPvc.metadata.namespace, pvc.metadata.namespace);
  assert.equal(pvc.metadata.ownerReferences, undefined);
  assert.equal(pvc.spec.storageClassName, undefined);
  assert.deepEqual(pvc.spec.accessModes, ['ReadWriteOnce']);
  assert.equal(pvc.spec.resources.requests.storage, '20Gi');
  assert.equal(JSON.stringify(pvc).includes('hostPath'), false);

  assert.equal(deployment.spec.replicas, 1);
  assert.deepEqual(deployment.spec.strategy, { type: 'Recreate' });
  assert.equal(manifest(first, 'HorizontalPodAutoscaler'), undefined);
  assert.equal(pod.terminationGracePeriodSeconds, 300);
  assert.equal(pod.securityContext.fsGroup, 10001);
  assert.deepEqual(container.volumeMounts, [
    { name: 'tmp', mountPath: '/tmp' },
    { name: 'data', mountPath: '/data/flyfight' },
  ]);
  assert.deepEqual(pod.volumes, [
    { name: 'tmp', emptyDir: { sizeLimit: '128Mi' } },
    { name: 'data', persistentVolumeClaim: { claimName: 'trainer-data' } },
  ]);
});

test('services without persistence preserve rolling updates, scaling, and temporary storage', () => {
  const plan = compilePersistent({ persistence: undefined, scaling: { minReplicas: 2, maxReplicas: 5 }, replicas: 3 });
  const deployment = manifest(plan, 'Deployment');
  const pod = deployment.spec.template.spec;

  assert.equal(manifest(plan, 'PersistentVolumeClaim'), undefined);
  assert.deepEqual(deployment.spec.strategy, { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } });
  assert.equal(deployment.spec.replicas, 2);
  assert.ok(manifest(plan, 'HorizontalPodAutoscaler'));
  assert.equal(pod.terminationGracePeriodSeconds, undefined);
  assert.deepEqual(pod.containers[0].volumeMounts, [{ name: 'tmp', mountPath: '/tmp' }]);
  assert.deepEqual(pod.volumes, [{ name: 'tmp', emptyDir: { sizeLimit: '128Mi' } }]);
});

test('runtime validation rejects persistence on unsupported and invalid service configurations', () => {
  assert.throws(() => compilePersistent({ type: 'cron' }), /persistence/i);
  assert.throws(() => compilePersistent({ persistence: { sizeGi: 0, mountPath: '/data' } }), /persistence/i);
  assert.throws(() => compilePersistent({ persistence: { sizeGi: 1, mountPath: 'relative' } }), /persistence/i);
  assert.throws(() => compilePersistent({ scaling: { minReplicas: 1, maxReplicas: 2 } }), /exactly one replica/i);
});
