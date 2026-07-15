import test from 'node:test';
import assert from 'node:assert/strict';
import { domainPlanForProject, projectConsoleHostname, resourceConsoleHostname, serviceConsoleHostname, serviceHostname, workspaceConsoleHostname } from '../packages/core/src/domain-router.ts';
import { compileProject } from '../packages/core/src/manifest-compiler.ts';
import { previewRuntimePlan } from '../packages/core/src/preview-deployments.ts';

test('service hostnames use subdomain-first single-label routing', () => {
  assert.equal(
    serviceHostname({ organizationSlug: 'gdg-hongik', projectSlug: 'festival-2026', serviceName: 'web' }),
    'gdg-hongik--festival-2026.apps.raibitserver.app',
  );
  assert.equal(
    serviceHostname({ organizationSlug: 'gdg-hongik', projectSlug: 'festival-2026', serviceName: 'web', preview: 'pr-32' }),
    'pr-32-gdg-hongik--festival-2026.preview.raibitserver.app',
  );
});

test('tenant project host labels preserve slug boundaries', () => {
  const victim = { organizationSlug: 'victim-team', projectSlug: 'api', baseDomain: 'example.test' };
  const attacker = { organizationSlug: 'victim', projectSlug: 'team-api', baseDomain: 'example.test' };
  assert.equal(serviceHostname(victim), 'victim-team--api.apps.example.test');
  assert.equal(serviceHostname(attacker), 'victim--team-api.apps.example.test');
  assert.notEqual(serviceHostname(victim), serviceHostname(attacker));
  assert.notEqual(
    serviceHostname({ ...victim, preview: 'pr-7' }),
    serviceHostname({ ...attacker, preview: 'pr-7' }),
  );
});

test('individual service/resource screens get separated console subdomains', () => {
  assert.equal(
    serviceConsoleHostname({ organizationSlug: 'gdg-hongik', projectSlug: 'festival-2026', serviceName: 'api' }),
    'gdg-hongik--festival-2026-api.console.raibitserver.app',
  );
  assert.equal(
    resourceConsoleHostname({ organizationSlug: 'gdg-hongik', projectSlug: 'festival-2026', resourceName: 'postgres' }),
    'gdg-hongik--festival-2026-postgres.resources.raibitserver.app',
  );
});

test('project domain plan separates platform, app, preview, console, and resource zones', () => {
  const plan = domainPlanForProject({
    organization: { slug: 'gdg-hongik' },
    project: { slug: 'festival-2026' },
    services: [{ name: 'web', type: 'web' }, { name: 'worker', type: 'worker' }],
    resources: [{ name: 'postgres', engine: 'postgresql' }],
  });
  assert.equal(plan.platform.dashboard, 'app.raibitserver.app');
  assert.equal(plan.services.find((service) => service.name === 'web').publicHostname, 'gdg-hongik--festival-2026.apps.raibitserver.app');
  assert.equal(plan.services.find((service) => service.name === 'worker').publicHostname, null);
  assert.equal(plan.wildcardTls.includes('*.apps.raibitserver.app'), true);
});

test('preview runtime plan creates isolated workload and cleanup selector', () => {
  const plan = previewRuntimePlan({
    organization: { slug: 'gdg-hongik' },
    project: { slug: 'festival-2026' },
    service: { id: 'svc_1', name: 'web' },
    deploymentId: 'dep_1',
    pullRequestNumber: 32,
  });
  assert.equal(plan.url, 'https://pr-32-gdg-hongik--festival-2026.preview.raibitserver.app');
  assert.equal(plan.kubernetes.workloadName, 'pr-32-web-1fee3c968086');
  assert.equal(plan.kubernetes.labels['raibitserver.io/preview'], 'true');
  assert.match(plan.kubernetes.cleanupSelector, /raibitserver\.io\/deployment=dep_1/);
});

test('compiled ingress uses subdomain-first generated host when no custom domain exists', () => {
  const compiled = compileProject({
    organization: { slug: 'gdg-hongik' },
    project: { slug: 'festival-2026' },
    services: [{ name: 'web', type: 'web', sourceType: 'image', image: 'ghcr.io/demo/web:1', port: 3000 }],
    resources: [],
  });
  const ingress = compiled.manifests.find((manifest) => manifest.kind === 'Ingress');
  assert.equal(ingress.spec.rules[0].host, 'gdg-hongik--festival-2026.apps.raibitserver.app');
  assert.equal(compiled.domainPlan.services[0].consoleHostname, 'gdg-hongik--festival-2026-web.console.raibitserver.app');
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
      production: 'gdg-hongik--festival-2026--api.apps.raibitserver.app',
      preview: 'pr-{number}-gdg-hongik--festival-2026--api.preview.raibitserver.app',
    },
    web: {
      production: 'gdg-hongik--festival-2026.apps.raibitserver.app',
      preview: 'pr-{number}-gdg-hongik--festival-2026.preview.raibitserver.app',
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
  assert.equal(apiPreview.host, 'pr-32-gdg-hongik--festival-2026--api.preview.raibitserver.app');
  assert.equal(webPreview.host, 'pr-32-gdg-hongik--festival-2026.preview.raibitserver.app');
  assert.notEqual(apiPreview.host, webPreview.host);

  const withoutNamedWeb = [
    { name: 'frontend', type: 'web' },
    { name: 'api', type: 'web' },
  ];
  assert.deepEqual(hostMap(withoutNamedWeb), hostMap([...withoutNamedWeb].reverse()));
  assert.equal(hostMap(withoutNamedWeb).api.production, 'gdg-hongik--festival-2026--api.apps.raibitserver.app');
  assert.equal(hostMap(withoutNamedWeb).frontend.production, 'gdg-hongik--festival-2026--frontend.apps.raibitserver.app');
});

test('service lifecycle changes never reassign the project base host', () => {
  const input = {
    organization: { slug: 'gdg-hongik' },
    project: { slug: 'festival-2026' },
  };
  const apiHost = (services) => domainPlanForProject({ ...input, services }).services
    .find((service) => service.name === 'api').publicHostname;
  const expected = 'gdg-hongik--festival-2026--api.apps.raibitserver.app';

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

  assert.equal(webHost, 'club-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1aae2be83a21.apps.raibitserver.app');
  assert.equal(apiHost, 'club-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-c53d1bfc23ce.apps.raibitserver.app');
  assert.equal(webPreview, 'pr-32-club-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1aae2be83a21.preview.raibitserver.app');
  assert.equal(apiPreview, 'pr-32-club-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-c53d1bfc23ce.preview.raibitserver.app');

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
  assert.equal(publicHosts[4], 'club-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-aea88c2165fd.console.raibitserver.app');
  assert.equal(publicHosts[5], 'club-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-741e03c433cc.resources.raibitserver.app');
  assert.equal(publicHosts[6], 'club-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1aae2be83a21.console.raibitserver.app');
  assert.equal(publicHosts[7], 'club-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-8e3e3e737f50.console.raibitserver.app');
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
