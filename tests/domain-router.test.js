import test from 'node:test';
import assert from 'node:assert/strict';
import { domainPlanForProject, projectConsoleHostname, resourceConsoleHostname, serviceConsoleHostname, serviceHostname, workspaceConsoleHostname } from '../packages/core/src/domain-router.ts';
import { compileProject } from '../packages/core/src/manifest-compiler.ts';
import { previewRuntimePlan } from '../packages/core/src/preview-deployments.ts';

test('service hostnames use flat single-label routing under the base domain', () => {
  assert.equal(
    serviceHostname({ organizationSlug: 'gdg-hongik', projectSlug: 'festival-2026', serviceName: 'web' }),
    'apps--gdg-hongik--festival-2026.raibitserver.app',
  );
  assert.equal(
    serviceHostname({ organizationSlug: 'gdg-hongik', projectSlug: 'festival-2026', serviceName: 'web', preview: 'pr-32' }),
    'preview--pr-32--gdg-hongik--festival-2026.raibitserver.app',
  );
});

test('tenant project host labels preserve slug boundaries', () => {
  const victim = { organizationSlug: 'victim-team', projectSlug: 'api', baseDomain: 'example.test' };
  const attacker = { organizationSlug: 'victim', projectSlug: 'team-api', baseDomain: 'example.test' };
  assert.equal(serviceHostname(victim), 'apps--victim-team--api.example.test');
  assert.equal(serviceHostname(attacker), 'apps--victim--team-api.example.test');
  assert.notEqual(serviceHostname(victim), serviceHostname(attacker));
  assert.notEqual(
    serviceHostname({ ...victim, preview: 'pr-7' }),
    serviceHostname({ ...attacker, preview: 'pr-7' }),
  );
});

test('individual service/resource screens get separated flat console hostnames', () => {
  assert.equal(
    serviceConsoleHostname({ organizationSlug: 'gdg-hongik', projectSlug: 'festival-2026', serviceName: 'api' }),
    'console--gdg-hongik--festival-2026-api.raibitserver.app',
  );
  assert.equal(
    resourceConsoleHostname({ organizationSlug: 'gdg-hongik', projectSlug: 'festival-2026', resourceName: 'postgres' }),
    'resources--gdg-hongik--festival-2026-postgres.raibitserver.app',
  );
});

test('project domain plan keeps platform hosts and uses one wildcard TLS zone for tenant routes', () => {
  const plan = domainPlanForProject({
    organization: { slug: 'gdg-hongik' },
    project: { slug: 'festival-2026' },
    services: [{ name: 'web', type: 'web' }, { name: 'worker', type: 'worker' }],
    resources: [{ name: 'postgres', engine: 'postgresql' }],
  });
  assert.equal(plan.platform.dashboard, 'app.raibitserver.app');
  assert.equal(plan.services.find((service) => service.name === 'web').publicHostname, 'apps--gdg-hongik--festival-2026.raibitserver.app');
  assert.equal(plan.services.find((service) => service.name === 'worker').publicHostname, null);
  assert.deepEqual(plan.wildcardTls, ['*.raibitserver.app']);
});

test('preview runtime plan creates isolated workload and cleanup selector', () => {
  const plan = previewRuntimePlan({
    organization: { slug: 'gdg-hongik' },
    project: { slug: 'festival-2026' },
    service: { id: 'svc_1', name: 'web' },
    deploymentId: 'dep_1',
    pullRequestNumber: 32,
  });
  assert.equal(plan.url, 'https://preview--pr-32--gdg-hongik--festival-2026.raibitserver.app');
  assert.equal(plan.kubernetes.workloadName, 'pr-32-web-1fee3c968086');
  assert.equal(plan.kubernetes.labels['raibitserver.io/preview'], 'true');
  assert.match(plan.kubernetes.cleanupSelector, /raibitserver\.io\/deployment=dep_1/);
});

test('compiled ingress uses flat generated host when no custom domain exists', () => {
  const compiled = compileProject({
    organization: { slug: 'gdg-hongik' },
    project: { slug: 'festival-2026' },
    services: [{ name: 'web', type: 'web', sourceType: 'image', image: 'ghcr.io/demo/web:1', port: 3000 }],
    resources: [],
  });
  const ingress = compiled.manifests.find((manifest) => manifest.kind === 'Ingress');
  assert.equal(ingress.spec.rules[0].host, 'apps--gdg-hongik--festival-2026.raibitserver.app');
  assert.equal(compiled.domainPlan.services[0].consoleHostname, 'console--gdg-hongik--festival-2026-web.raibitserver.app');
});

test('multiple public web services receive stable production and preview hosts', () => {
  const services = [
    { name: 'api', type: 'web', sourceType: 'image', image: 'ghcr.io/demo/api:1', port: 3001 },
    { name: 'web', type: 'web', sourceType: 'image', image: 'ghcr.io/demo/web:1', port: 3000 },
  ];
  const project = { slug: 'festival-2026' };
  const organization = { slug: 'gdg-hongik' };
  const spec = { organization, project, services, resources: [] };

  const hostMap = (serviceList) => Object.fromEntries(domainPlanForProject({ ...spec, services: serviceList }).services
    .map((service) => [service.name, { production: service.publicHostname, preview: service.previewPattern }]));
  const expected = {
    api: {
      production: 'apps--gdg-hongik--festival-2026--api.raibitserver.app',
      preview: 'preview--pr-{number}--gdg-hongik--festival-2026--api.raibitserver.app',
    },
    web: {
      production: 'apps--gdg-hongik--festival-2026.raibitserver.app',
      preview: 'preview--pr-{number}--gdg-hongik--festival-2026.raibitserver.app',
    },
  };
  assert.deepEqual(hostMap(services), expected);
  assert.deepEqual(hostMap([...services].reverse()), expected, 'route ownership must not depend on service array order');

  const compiled = compileProject(spec);
  const ingresses = compiled.manifests.filter((manifest) => manifest.kind === 'Ingress');
  const ingressHosts = Object.fromEntries(ingresses.map((ingress) => [
    ingress.metadata.name,
    {
      host: ingress.spec.rules[0].host,
      backend: ingress.spec.rules[0].http.paths[0].backend.service.name,
    },
  ]));
  assert.deepEqual(ingressHosts, {
    api: { host: expected.api.production, backend: 'api' },
    web: { host: expected.web.production, backend: 'web' },
  });

  const apiPreview = previewRuntimePlan({ organization, project, service: services[0], pullRequestNumber: 32 });
  const webPreview = previewRuntimePlan({ organization, project, service: services[1], pullRequestNumber: 32 });
  assert.equal(apiPreview.host, 'preview--pr-32--gdg-hongik--festival-2026--api.raibitserver.app');
  assert.equal(webPreview.host, 'preview--pr-32--gdg-hongik--festival-2026.raibitserver.app');
  assert.notEqual(apiPreview.host, webPreview.host);

  const withoutNamedWeb = [
    { name: 'frontend', type: 'web' },
    { name: 'api', type: 'web' },
  ];
  assert.deepEqual(hostMap(withoutNamedWeb), hostMap([...withoutNamedWeb].reverse()));
  assert.equal(hostMap(withoutNamedWeb).api.production, 'apps--gdg-hongik--festival-2026--api.raibitserver.app');
  assert.equal(hostMap(withoutNamedWeb).frontend.production, 'apps--gdg-hongik--festival-2026--frontend.raibitserver.app');
});

test('service lifecycle changes never reassign the project base host', () => {
  const input = {
    organization: { slug: 'gdg-hongik' },
    project: { slug: 'festival-2026' },
  };
  const apiHost = (services) => domainPlanForProject({ ...input, services }).services
    .find((service) => service.name === 'api').publicHostname;
  const expected = 'apps--gdg-hongik--festival-2026--api.raibitserver.app';

  assert.equal(apiHost([{ name: 'api', type: 'web' }]), expected);
  assert.equal(apiHost([{ name: 'api', type: 'web' }, { name: 'zzz', type: 'web' }]), expected);
  assert.equal(apiHost([{ name: 'aaa', type: 'web' }, { name: 'api', type: 'web' }]), expected);
  assert.equal(apiHost([{ name: 'web', type: 'web' }, { name: 'api', type: 'web' }]), expected);
});

test('long production and preview route labels are bounded deterministically', () => {
  const organization = { id: 'organization-cuid', slug: `club-${'a'.repeat(70)}` };
  const project = { id: 'project-cuid', slug: `project-${'b'.repeat(70)}` };
  const services = [
    { id: 'svc-web', name: 'web', type: 'web' },
    { id: 'svc-api', name: `api-${'c'.repeat(70)}`, type: 'web' },
  ];
  const resourceName = `postgres-${'d'.repeat(70)}`;
  const plan = domainPlanForProject({ organization, project, services });
  const webHost = plan.services.find((service) => service.name === 'web').publicHostname;
  const apiHost = plan.services.find((service) => service.name.startsWith('api-')).publicHostname;
  const webPreview = previewRuntimePlan({ organization, project, service: services[0], pullRequestNumber: 32 }).host;
  const apiPreview = previewRuntimePlan({ organization, project, service: services[1], pullRequestNumber: 32 }).host;

  for (const service of plan.services) {
    const runtimeHost = previewRuntimePlan({
      organization,
      project,
      service: services.find((candidate) => service.name === candidate.name || candidate.name.startsWith(service.name)),
      pullRequestNumber: 32,
    }).host;
    assert.equal(service.previewPattern.replace('{number}', '32'), runtimeHost, `${service.name} preview pattern must resolve to the runtime host`);
    assert.ok(service.previewPattern.split('.')[0].length <= 63, service.previewPattern);
  }

  assert.equal(webHost, 'apps--club-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-f685a6d8b3db.raibitserver.app');
  assert.equal(apiHost, 'apps--club-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-f027e0adb928.raibitserver.app');
  assert.equal(webPreview, 'preview--pr-32--club-aaaaaaaaaaaaaaaaaaaaa-1aae2be83a21.raibitserver.app');
  assert.equal(apiPreview, 'preview--pr-32--club-aaaaaaaaaaaaaaaaaaaaa-c53d1bfc23ce.raibitserver.app');

  const publicHosts = [
    webHost,
    apiHost,
    webPreview,
    apiPreview,
    serviceConsoleHostname({ organizationSlug: organization.slug, projectSlug: project.slug, serviceName: services[1].name }),
    resourceConsoleHostname({ organizationSlug: organization.slug, projectSlug: project.slug, resourceName }),
    projectConsoleHostname({ organizationSlug: organization.slug, projectSlug: project.slug }),
    workspaceConsoleHostname({ organizationSlug: organization.slug }),
  ];
  assert.equal(publicHosts[4], 'console--club-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-eb89d81060b2.raibitserver.app');
  assert.equal(publicHosts[5], 'resources--club-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-cb4fe7c45e64.raibitserver.app');
  assert.equal(publicHosts[6], 'console--club-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-df0498a09034.raibitserver.app');
  assert.equal(publicHosts[7], 'console--club-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-13937423f373.raibitserver.app');
  for (const host of publicHosts) assert.ok(host.split('.')[0].length <= 63, host);

  const compiled = compileProject({
    organization,
    project,
    services: [{ ...services[0], sourceType: 'image', image: 'registry.local/web:1', port: 3000 }],
    resources: [],
  });
  assert.equal(compiled.metadata.namespace, 'organization-cuid--project-bbbbbbbbbbbbbbbbbbbbbbb-0629a21786b1');
  assert.equal(compiled.manifests.find((manifest) => manifest.kind === 'Namespace').metadata.name, compiled.metadata.namespace);

  const previewPlan = previewRuntimePlan({ organization, project, service: services[1], deploymentId: 'deployment-long', pullRequestNumber: 2147483647 });
  for (const name of [
    previewPlan.kubernetes.namespace,
    previewPlan.kubernetes.workloadName,
    previewPlan.kubernetes.deploymentName,
    previewPlan.kubernetes.serviceName,
    previewPlan.kubernetes.ingressName,
  ]) assert.ok(name.length <= 63, name);
  assert.equal(previewPlan.kubernetes.namespace, compiled.metadata.namespace);
  assert.match(previewPlan.kubernetes.workloadName, /^pr-2147483647-api-/);
});
