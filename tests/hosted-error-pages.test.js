import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const read = (path) => fs.readFile(path, 'utf8');

test('Helm wires a dedicated hosted-error backend to the replicated dashboard pods', async () => {
  const [values, services, dashboard, orchestrator, hostedErrors, validation] = await Promise.all([
    read('infra/helm/raibitserver/values.yaml'),
    read('infra/helm/raibitserver/templates/services.yaml'),
    read('infra/helm/raibitserver/templates/dashboard-deployment.yaml'),
    read('infra/helm/raibitserver/templates/orchestrator-deployment.yaml'),
    read('infra/helm/raibitserver/templates/hosted-errors.yaml'),
    read('infra/helm/raibitserver/templates/validate.yaml'),
  ]);

  assert.match(values, /hostedErrors:[\s\S]*enabled:\s*true[\s\S]*"500"[\s\S]*"502"[\s\S]*"503"[\s\S]*"504"/);
  assert.match(services, /name:[^\n]*-hosted-errors[\s\S]*selector:[\s\S]*app\.kubernetes\.io\/name:\s*raibitserver-dashboard/);
  assert.match(dashboard, /RAIBITSERVER_BASE_DOMAIN[\s\S]*\.Values\.ingress\.hosts\.public/);
  assert.match(orchestrator, /RAIBITSERVER_INGRESS_CUSTOM_HTTP_ERRORS[\s\S]*hostedErrors\.statuses/);
  assert.match(orchestrator, /RAIBITSERVER_INGRESS_ERROR_MIDDLEWARE[\s\S]*@kubernetescrd/);

  assert.match(hostedErrors, /kind:\s*Ingress[\s\S]*printf\s+"\*\.%s"[\s\S]*-hosted-errors/);
  assert.match(hostedErrors, /kind:\s*Middleware[\s\S]*query:\s*\/api\/hosted-error\?code=\{status\}/);
  assert.match(hostedErrors, /passHostHeader:\s*false/);
  assert.match(hostedErrors, /errorRequestHeaders:\s*\[\]/);
  assert.match(hostedErrors, /default\s+\.Values\.ingress\.tls\.existingSecret\s+\.Values\.hostedErrors\.fallbackIngress\.tls\.existingSecret/);
  assert.doesNotMatch(validation, /hosted error fallback requires a wildcard TLS existingSecret/);
  assert.match(validation, /may contain only 500, 502, 503, and 504/);
});

test('hosted error documentation preserves application-owned 404s and publishes verification routes', async () => {
  const [guide, design, readme, route, component, css, catalog] = await Promise.all([
    read('docs/hosted-error-pages.md'),
    read('DESIGN.md'),
    read('README.md'),
    read('apps/dashboard/app/api/hosted-error/route.ts'),
    read('apps/dashboard/components/error-screen.tsx'),
    read('apps/dashboard/app/globals.css'),
    read('apps/dashboard/app/errors/page.tsx'),
  ]);

  assert.match(guide, /사용자 앱이 직접 반환한 404[\s\S]*유지/);
  assert.match(guide, /\/errors\/404/);
  assert.match(guide, /38종/);
  assert.match(guide, /\/errors\/422/);
  assert.match(guide, /\/errors\/507/);
  assert.match(guide, /\/api\/hosted-error\?code=503/);
  assert.match(guide, /default-backend-service/);
  assert.match(guide, /crossProviderNamespaces/);
  assert.doesNotMatch(guide, /custom-http-errors:\s*"404/);
  assert.match(route, /x-request-id/);
  assert.match(route, /randomUUID\(\)/);
  assert.match(route, /'x-error-id': identifier/);
  assert.match(component, /className="error-signal"/);
  assert.match(component, /className="error-copy"/);
  assert.match(css, /\.error-screen\s*\{[\s\S]*?grid-template-columns: minmax\(0, 0\.95fr\) minmax\(420px, 1\.05fr\)/);
  assert.doesNotMatch(css, /\.error-screen\s*\{[^}]*background:\s*var\(--color-surface\)/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.error-actions[\s\S]*?width: 100%/);
  assert.match(css, /\.error-code-list\[data-columns="2"\]/);
  assert.match(catalog, /CLIENT_ERROR_STATUS_CODES/);
  assert.match(catalog, /SERVER_ERROR_STATUS_CODES/);
  assert.match(catalog, /오류 화면 전체 목록/);
  assert.match(design, /### 8\.10 오류 화면/);
  assert.match(design, /카드를 사용하지 않고 화면 전체/);
  assert.match(design, /활성 4xx·5xx 38종/);
  assert.match(readme, /공통 오류 화면/);
});
