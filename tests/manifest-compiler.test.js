import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compileProject } from '../packages/core/src/manifest-compiler.ts';

const example = JSON.parse(fs.readFileSync(new URL('../examples/project.json', import.meta.url), 'utf8'));
const plan = compileProject(example, example.filesByService);

function kinds() {
  return plan.manifests.map((manifest) => manifest.kind);
}

function find(kind, name) {
  return plan.manifests.find((manifest) => manifest.kind === kind && (!name || manifest.metadata.name === name));
}

test('compiler emits namespace, workloads, routes, autoscaling, and isolation', () => {
  assert.equal(plan.metadata.namespace, 'gdg-hongik--festival-2026');
  for (const kind of ['Namespace', 'Deployment', 'CronJob', 'Job', 'Service', 'Ingress', 'HorizontalPodAutoscaler', 'NetworkPolicy', 'PodDisruptionBudget']) {
    assert.equal(kinds().includes(kind), true, kind);
  }
});

test('web service uses secret refs and safe container defaults', () => {
  const deployment = find('Deployment', 'web');
  const secret = find('Secret', 'web-env');
  const container = deployment.spec.template.spec.containers[0];
  assert.equal(container.securityContext.runAsNonRoot, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities, { drop: ['ALL'] });
  assert.deepEqual(container.securityContext.seccompProfile, { type: 'RuntimeDefault' });
  assert.deepEqual(container.volumeMounts, [{ name: 'tmp', mountPath: '/tmp' }]);
  assert.deepEqual(deployment.spec.template.spec.volumes, [{ name: 'tmp', emptyDir: {} }]);
  assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(container.env.some((env) => env.name === 'DATABASE_URL' && env.valueFrom.secretKeyRef.name === 'web-env'), true);
  assert.equal(secret.metadata.annotations['raibitserver.io/provider-contract'], 'not-live-secret');
  assert.match(secret.stringData.DATABASE_URL, /provider-managed-/);
  assert.equal(deployment.spec.strategy.rollingUpdate.maxUnavailable, 0);
});

test('provider-owned storage and vector placeholders are marked as not-live secrets', () => {
  const storagePlan = compileProject({
    organization: { slug: 'gdg' },
    project: { name: 'assets' },
    services: [{ name: 'web', type: 'web', sourceType: 'image', image: 'example/web:1', attachedResources: ['assets', 'vectors'] }],
    resources: [
      { name: 'assets', engine: 'object-storage', type: 'storage', bucket: 'assets' },
      { name: 'vectors', engine: 'vector-db', type: 'vector' },
    ],
  });
  const secret = storagePlan.manifests.find((manifest) => manifest.kind === 'Secret' && manifest.metadata.name === 'web-env');
  assert.equal(secret.metadata.annotations['raibitserver.io/provider-contract'], 'not-live-secret');
  assert.match(secret.stringData.S3_ACCESS_KEY, /provider-managed-/);
  assert.match(secret.stringData.S3_SECRET_KEY, /provider-managed-/);
  assert.match(secret.stringData.VECTOR_DB_API_KEY, /provider-managed-/);
});

test('tenant network policy allows DNS but blocks metadata and private control-plane ranges', () => {
  const policy = find('NetworkPolicy', 'tenant-isolation');
  const dnsRule = policy.spec.egress.find((rule) => rule.ports?.some((port) => port.port === 53));
  assert.ok(dnsRule, 'DNS egress rule exists');
  const externalRule = policy.spec.egress.find((rule) => rule.to?.[0]?.ipBlock?.cidr === '0.0.0.0/0');
  assert.equal(externalRule, undefined, 'public internet egress is opt-in');
  assert.equal(
    policy.spec.ingress.some((rule) => rule.from?.some((peer) => peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === plan.metadata.namespace)),
    false,
    'default ingress must not allow same-namespace lateral traffic',
  );
  assert.equal(
    policy.spec.ingress.some((rule) => rule.from?.some((peer) => peer.namespaceSelector?.matchLabels?.['raibitserver.io/ingress-gateway'] === 'true')),
    true,
    'default ingress allows only the shared ingress gateway namespace',
  );
  assert.equal(policy.raibitserver.blocksMetadataEndpoint, true);
  assert.equal(policy.raibitserver.blocksControlPlane, true);
  assert.equal(policy.raibitserver.ingressFromGatewayOnly, true);
  assert.equal(policy.raibitserver.blocksSameNamespaceIngressByDefault, true);
});

test('tenant network policy adds bounded public egress only when service opts in', () => {
  const optIn = compileProject({
    organization: { slug: 'gdg' },
    project: { name: 'egress' },
    services: [{ name: 'web', type: 'web', sourceType: 'image', image: 'example/web:1', allowPublicEgress: true }],
    resources: [],
  });
  const policy = optIn.manifests.find((manifest) => manifest.kind === 'NetworkPolicy' && manifest.metadata.name === 'tenant-isolation');
  assert.equal(policy.spec.egress.some((rule) => rule.to?.[0]?.ipBlock?.cidr === '0.0.0.0/0'), false, 'tenant-wide isolation policy must not get public egress');
  const publicPolicy = optIn.manifests.find((manifest) => manifest.kind === 'NetworkPolicy' && manifest.metadata.name === 'web-public-egress');
  assert.ok(publicPolicy, 'service-scoped public egress policy exists');
  assert.deepEqual(publicPolicy.spec.podSelector.matchLabels, { 'app.kubernetes.io/name': 'web' });
  assert.equal(publicPolicy.raibitserver.scopedToServicePodSelector, true);
  assert.deepEqual(publicPolicy.raibitserver.ipv6Except, ['::1/128', 'fc00::/7', 'fe80::/10', 'fd00:ec2::254/128']);
  assert.deepEqual(policy.raibitserver.publicEgressServices, ['web']);
  const externalRule = publicPolicy.spec.egress.find((rule) => rule.to?.[0]?.ipBlock?.cidr === '0.0.0.0/0');
  assert.ok(externalRule, 'external egress rule exists after explicit opt-in');
  assert.deepEqual(externalRule.to[0].ipBlock.except, ['10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16']);
});

test('private services do not receive public ingress', () => {
  const apiIngress = plan.manifests.find((manifest) => manifest.kind === 'Ingress' && manifest.metadata.name === 'api');
  const apiService = plan.manifests.find((manifest) => manifest.kind === 'Service' && manifest.metadata.name === 'api');
  assert.equal(apiIngress, undefined);
  assert.equal(apiService.kind, 'Service');
});

test('resource plans expose catalog lifecycle and env variable names', () => {
  const postgres = plan.resourcePlans.find((resource) => resource.name === 'festival-postgres');
  assert.equal(postgres.operator, 'CloudNativePG');
  assert.equal(postgres.lifecycle.includes('backup'), true);
  assert.equal(postgres.env.includes('DATABASE_URL'), true);
});

test('compiler can emit safe image pre-pull DaemonSet for rollout latency reduction', () => {
  const prePull = compileProject({
    organization: { slug: 'gdg' },
    project: { name: 'warm' },
    performance: { prePullImages: ['node:24-alpine', 'python:3.13-alpine'] },
    services: [{ name: 'web', sourceType: 'image', image: 'registry.local/web:1' }],
  });
  const daemonSet = prePull.manifests.find((manifest) => manifest.kind === 'DaemonSet' && manifest.metadata.name === 'image-prepull');
  assert.ok(daemonSet);
  assert.equal(prePull.prePullPlan.enabled, true);
  assert.deepEqual(daemonSet.spec.template.spec.initContainers.map((container) => container.image), ['node:24-alpine', 'python:3.13-alpine']);
  assert.equal(daemonSet.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(daemonSet.spec.template.spec.initContainers[0].securityContext.runAsNonRoot, true);
});
