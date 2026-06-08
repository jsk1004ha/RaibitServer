import test from 'node:test';
import assert from 'node:assert/strict';
import { domainPlanForProject, resourceConsoleHostname, serviceConsoleHostname, serviceHostname } from '../packages/core/src/domain-router.ts';
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
  assert.equal(plan.kubernetes.workloadName, 'pr-32-web');
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
