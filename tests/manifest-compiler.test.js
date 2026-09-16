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
  assert.deepEqual(deployment.spec.template.spec.volumes, [{ name: 'tmp', emptyDir: { sizeLimit: '128Mi' } }]);
  assert.equal(container.resources.requests['ephemeral-storage'], '64Mi');
  assert.equal(container.resources.limits['ephemeral-storage'], '256Mi');
  assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(container.env.some((env) => env.name === 'DATABASE_URL' && env.valueFrom.secretKeyRef.name === 'web-env'), true);
  assert.equal(secret.metadata.annotations['raibitserver.io/provider-contract'], 'not-live-secret');
  assert.match(secret.stringData.DATABASE_URL, /provider-managed-/);
  assert.equal(deployment.spec.strategy.rollingUpdate.maxUnavailable, 0);
});

test('unsupported storage and vector resources reject before creating placeholder secrets', () => {
  for (const engine of ['object-storage', 'vector-db']) assert.throws(() => compileProject({
    organization: { slug: 'gdg' },
    project: { name: 'assets' },
    services: [{ name: 'web', type: 'web', sourceType: 'image', image: 'example/web:1', attachedResources: ['assets'] }],
    resources: [
      { name: 'assets', engine },
    ],
  }), { code: 'RESOURCE_CAPABILITY_UNAVAILABLE' });
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
    policy.spec.ingress.some((rule) => rule.from?.some((peer) => peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'ingress-nginx')),
    true,
    'default ingress allows only the standard ingress gateway namespace',
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

test('web ingress uses trusted hosted error annotations and ignores tenant overrides', () => {
  const custom = compileProject({
    organization: { slug: 'gdg' },
    project: { name: 'hosted-errors' },
    ingressCustomHttpErrors: '418',
    ingressErrorMiddleware: 'attacker@kubernetescrd',
    services: [
      { name: 'web', type: 'web', sourceType: 'image', image: 'example/web:1', ingressCustomHttpErrors: '404', ingressErrorMiddleware: 'also-attacker@kubernetescrd' },
      { name: 'api', type: 'private', sourceType: 'image', image: 'example/api:1' },
    ],
  }, {}, {
    ingressCustomHttpErrors: ['504', 500, '502', '500'],
    ingressErrorMiddleware: ' Platform-Errors@KubernetesCRD ',
  });
  const ingress = custom.manifests.find((manifest) => manifest.kind === 'Ingress');
  assert.equal(ingress.metadata.annotations['nginx.ingress.kubernetes.io/custom-http-errors'], '500,502,504');
  assert.equal(ingress.metadata.annotations['traefik.ingress.kubernetes.io/router.middlewares'], 'platform-errors@kubernetescrd');
  assert.equal(custom.manifests.filter((manifest) => manifest.kind === 'Ingress').length, 1);
  assert.doesNotMatch(JSON.stringify(ingress), /418|also-attacker/);
});

test('web ingress defaults hosted errors and rejects invalid trusted settings', () => {
  const ingress = find('Ingress', 'web');
  assert.equal(ingress.metadata.annotations['nginx.ingress.kubernetes.io/custom-http-errors'], '500,502,503,504');
  assert.equal(ingress.metadata.annotations['traefik.ingress.kubernetes.io/router.middlewares'], undefined);
  assert.throws(() => compileProject(example, example.filesByService, { ingressCustomHttpErrors: '404,700' }), /invalid ingress custom HTTP errors/);
  assert.throws(() => compileProject(example, example.filesByService, { ingressErrorMiddleware: 'unsafe/value' }), /invalid ingress error middleware/);
});

test('trusted hosted error disable sentinel omits controller error annotations', () => {
  const disabled = compileProject(example, example.filesByService, {
    ingressCustomHttpErrors: ' DISABLED ',
    ingressErrorMiddleware: 'platform-errors@kubernetescrd',
  });
  const ingress = disabled.manifests.find((manifest) => manifest.kind === 'Ingress');
  assert.equal(ingress.metadata.annotations['nginx.ingress.kubernetes.io/custom-http-errors'], undefined);
  assert.equal(ingress.metadata.annotations['traefik.ingress.kubernetes.io/router.middlewares'], undefined);
});

test('resource plans expose catalog lifecycle and env variable names', () => {
  const postgres = plan.resourcePlans.find((resource) => resource.name === 'festival-postgres');
  assert.equal(postgres.operator, 'dedicated-local');
  assert.equal(postgres.lifecycle.includes('backup'), false);
  assert.equal(postgres.capabilities.local.backup, false);
  assert.equal(postgres.env.includes('DATABASE_URL'), true);
});

test('tenant pre-pull image hints do not create DaemonSets', () => {
  const prePull = compileProject({
    organization: { slug: 'gdg' },
    project: { name: 'warm' },
    prePullImages: ['attacker.example/evil-shell:latest'],
    performance: { prePullImages: ['node:24-alpine', 'python:3.13-alpine'], prePullBuildImages: true },
    runtime: { prePullImages: ['busybox:1.36'] },
    services: [{ name: 'web', sourceType: 'image', image: 'registry.local/web:1' }],
  });
  const daemonSet = prePull.manifests.find((manifest) => manifest.kind === 'DaemonSet' && manifest.metadata.name === 'image-prepull');
  assert.equal(daemonSet, undefined);
  assert.equal(prePull.prePullPlan.enabled, false);
  assert.equal(prePull.prePullPlan.strategy, 'disabled-tenant-prepull-not-supported');
  assert.deepEqual(prePull.prePullPlan.ignoredImages.sort(), ['attacker.example/evil-shell:latest', 'busybox:1.36', 'node:24-alpine', 'python:3.13-alpine', 'registry.local/web:1'].sort());
});

test('tenant input cannot choose the trusted ingress gateway namespace', () => {
  const custom = compileProject({
    organization: { slug: 'gdg' },
    project: { name: 'gateway-contract' },
    ingressGatewayNamespace: 'attacker-controlled',
    runtime: { ingressGatewayNamespace: 'also-attacker-controlled' },
    services: [{ name: 'web', type: 'web', sourceType: 'image', image: 'example/web:1' }],
    resources: [],
  }, {}, { ingressGatewayNamespace: 'edge-gateway-system' });
  const policy = custom.manifests.find((manifest) => manifest.kind === 'NetworkPolicy' && manifest.metadata.name === 'tenant-isolation');
  const selector = policy.spec.ingress[0].from[0].namespaceSelector;
  assert.deepEqual(selector, { matchLabels: { 'kubernetes.io/metadata.name': 'edge-gateway-system' } });
  assert.doesNotMatch(JSON.stringify(selector), /attacker-controlled|raibitserver\.io\/ingress-gateway/);
});

test('invalid trusted ingress gateway namespace fails closed', () => {
  assert.throws(
    () => compileProject({ organization: { slug: 'gdg' }, project: { name: 'invalid-gateway' } }, {}, { ingressGatewayNamespace: 'INVALID/namespace' }),
    /invalid ingress gateway namespace/,
  );
});

test('tenant resource overrides cannot remove or inflate temporary storage bounds', () => {
  const custom = compileProject({
    organization: { slug: 'gdg' },
    project: { name: 'bounded-storage' },
    services: [{
      name: 'web',
      type: 'web',
      sourceType: 'image',
      image: 'example/web:1',
      resources: {
        requests: { cpu: '250m', memory: '256Mi' },
        limits: { cpu: '1', memory: '1Gi', 'ephemeral-storage': '100Ti' },
      },
    }],
    resources: [],
  });
  const deployment = custom.manifests.find((manifest) => manifest.kind === 'Deployment');
  const container = deployment.spec.template.spec.containers[0];
  assert.deepEqual(container.resources.requests, { cpu: '250m', memory: '256Mi', 'ephemeral-storage': '64Mi' });
  assert.deepEqual(container.resources.limits, { cpu: '1', memory: '1Gi', 'ephemeral-storage': '256Mi' });
  assert.deepEqual(deployment.spec.template.spec.volumes, [{ name: 'tmp', emptyDir: { sizeLimit: '128Mi' } }]);
});

test('long service identities keep every generated Kubernetes object name bounded and referenced exactly', () => {
  const longName = `service-${'x'.repeat(90)}`;
  const compiled = compileProject({
    organization: { id: 'organization-cuid', slug: 'gdg' },
    project: { id: 'project-cuid', slug: 'long-service' },
    services: [{
      id: 'service-cuid',
      name: longName,
      type: 'web',
      sourceType: 'image',
      image: 'registry.local/web:1',
      env: { LOG_LEVEL: 'info', API_TOKEN: 'secret-value' },
      scaling: { minReplicas: 1, maxReplicas: 2 },
      allowPublicEgress: true,
    }],
    resources: [],
  });

  for (const manifest of compiled.manifests) {
    assert.ok(manifest.metadata.name.length <= 63, `${manifest.kind}/${manifest.metadata.name}`);
    if (manifest.metadata.namespace) assert.ok(manifest.metadata.namespace.length <= 63, manifest.metadata.namespace);
  }

  const deployment = compiled.manifests.find((manifest) => manifest.kind === 'Deployment');
  const ingress = compiled.manifests.find((manifest) => manifest.kind === 'Ingress');
  const objectNames = new Set(compiled.manifests.map((manifest) => manifest.metadata.name));
  for (const env of deployment.spec.template.spec.containers[0].env) {
    const reference = env.valueFrom.secretKeyRef?.name || env.valueFrom.configMapKeyRef?.name;
    assert.ok(objectNames.has(reference), `missing env source ${reference}`);
  }
  assert.ok(ingress.spec.tls[0].secretName.length <= 63, ingress.spec.tls[0].secretName);
});
