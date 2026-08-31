import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const matrixUrl = new URL('../apps/dashboard/tests/e2e/regression-matrix.ts', import.meta.url);
const browserContractsUrl = new URL('../apps/dashboard/tests/e2e/helpers/contracts.ts', import.meta.url);

test('Given the final dashboard matrix, when completeness is audited, then every route, role, state, viewport, and risk is executable', async () => {
  const matrix = await import(matrixUrl.href);
  const ids = matrix.ROUTE_MATRIX.map((scenario) => scenario.id);

  assert.equal(ids.length, 131);
  assert.equal(new Set(ids).size, ids.length);
  const batchedIds = matrix.ROUTE_BATCHES.flatMap((batch) => batch.scenarios.map((scenario) => scenario.id));
  assert.deepEqual(new Set(batchedIds), new Set(ids));
  assert.equal(batchedIds.length, ids.length);
  assert.equal(Math.max(...matrix.ROUTE_BATCHES.map((batch) => batch.scenarios.length)), matrix.ROUTE_BATCH_SIZE);
  assert.equal(matrix.ROUTE_BATCHES.every((batch) => batch.scenarios.length > 0 && batch.scenarios.length <= matrix.ROUTE_BATCH_SIZE), true);
  assert.deepEqual(matrix.HOSTED_ERROR_CASES, [404, 422, 503, 507, 599]);
  assert.deepEqual(matrix.MATRIX_TIMEOUTS, { routeBaseMs: 6000, routeStepMs: 1800, templateMs: 15000, hostedErrorMs: 15000 });
  assert.deepEqual(new Set(matrix.ROLES), new Set(['anonymous', 'user', 'admin']));
  assert.deepEqual(new Set(matrix.FIXTURE_STATES), new Set(['populated', 'empty', 'partial', 'long', 'hostile', 'expired']));
  assert.deepEqual(matrix.TEMPLATE_VIEWPORTS, [{ width: 375, height: 812 }, { width: 1280, height: 800 }]);
  assert.deepEqual(matrix.SHELL_VIEWPORTS, [{ width: 767, height: 1024 }, { width: 768, height: 1024 }]);

  const routes = new Set(matrix.ROUTE_MATRIX.map((scenario) => scenario.path));
  for (const route of ['/', '/status', '/support', '/privacy', '/contributors', '/console', '/org/raibit/projects', '/org/raibit/projects/new', '/admin']) {
    assert.equal(routes.has(route), true, `missing route ${route}`);
  }
  for (const topic of matrix.GUIDE_TOPICS) assert.equal(routes.has(`/guide?topic=${topic}`), true, `missing guide topic ${topic}`);
  for (const view of matrix.PROJECT_VIEWS) assert.equal([...routes].some((route) => route.includes(`view=${view}`)), true, `missing project view ${view}`);
  for (const view of matrix.DEPLOYMENT_VIEWS) assert.equal([...routes].some((route) => route.includes(`view=${view}`)), true, `missing deployment view ${view}`);
  for (const view of matrix.RESOURCE_VIEWS) assert.equal([...routes].some((route) => route.includes(`view=${view}`)), true, `missing resource view ${view}`);
  for (const step of matrix.GITHUB_STEPS) assert.equal(routes.has(`/github?step=${step}`), true, `missing GitHub step ${step}`);
  for (const code of matrix.ERROR_STATUS_CODES) assert.equal(routes.has(`/errors/${code}`), true, `missing error code ${code}`);
  const publicErrorPreviews = matrix.ROUTE_MATRIX.filter((scenario) => scenario.family === 'errors' && scenario.expected === 'document');
  assert.equal(publicErrorPreviews.length, matrix.ERROR_STATUS_CODES.length + 2);
  assert.equal(publicErrorPreviews.every((scenario) => scenario.origin === 'public' && scenario.actor === 'anonymous'), true);
  assert.equal(matrix.ROUTE_MATRIX.some((scenario) => scenario.id === 'anonymous-console-error-preview'
    && scenario.origin === 'console'
    && scenario.path === '/errors/503'
    && scenario.actor === 'anonymous'
    && scenario.expected === 'login-redirect'), true);
  assert.deepEqual(matrix.TEMPLATE_MATRIX.find(([id]) => id === 'error'), ['error', 'public', '/errors/503', 'anonymous', 'populated']);

  const protectedFamilies = new Set(matrix.ROUTE_MATRIX.filter((scenario) => scenario.state === 'expired').map((scenario) => scenario.family));
  for (const family of ['console', 'projects', 'guide', 'project', 'deployment', 'resource', 'github', 'admin']) {
    assert.equal(protectedFamilies.has(family), true, `missing expired ${family}`);
  }

  const states = new Set(matrix.ROUTE_MATRIX.map((scenario) => scenario.state));
  for (const state of matrix.FIXTURE_STATES) assert.equal(states.has(state), true, `unexecuted state ${state}`);
  const actors = new Set(matrix.ROUTE_MATRIX.map((scenario) => scenario.actor));
  for (const role of matrix.ROLES) assert.equal(actors.has(role), true, `unexecuted role ${role}`);
  for (const family of ['console', 'projects', 'guide', 'project', 'deployment', 'resource', 'github', 'admin']) {
    assert.equal(matrix.ROUTE_MATRIX.some((scenario) => scenario.actor === 'anonymous' && scenario.family === family && scenario.expected === 'login-redirect'), true, `missing anonymous redirect ${family}`);
  }
  assert.equal(matrix.ROUTE_MATRIX.some((scenario) => scenario.id === 'user-admin-denied' && scenario.expected === 'console-redirect'), true);

  const risks = new Set(matrix.COVERAGE_EVIDENCE.map((entry) => entry.risk));
  for (const risk of ['happy-mutation', 'destructive-failure', 'keyboard-focus', 'touch-target', 'reduced-motion', 'axe', 'console-network-csp-hydration', 'hosted-error-headers', 'secrets', 'overflow-scroll']) {
    assert.equal(risks.has(risk), true, `missing risk ${risk}`);
  }
  for (const entry of matrix.COVERAGE_EVIDENCE) {
    const source = await readFile(new URL(`../${entry.spec}`, import.meta.url), 'utf8');
    assert.match(source, new RegExp(entry.marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${entry.id} marker missing`);
  }
});

test('Given Next transition trees, when document landmarks are audited, then only rendered landmarks count', async () => {
  const runtime = await readFile(new URL('../apps/dashboard/tests/e2e/helpers/t16-runtime.ts', import.meta.url), 'utf8');

  assert.match(runtime, /visibleMainCount/);
  assert.match(runtime, /visibleHeadingCount/);
  assert.match(runtime, /accessibleMainCount/);
  assert.match(runtime, /accessibleHeadingCount/);
  assert.match(runtime, /hiddenDuplicatesSafe/);
  assert.match(runtime, /getClientRects\(\)\.length > 0/);
  assert.doesNotMatch(runtime, /mainCount: 1/);
});

test('Given aggregate browser evidence, when legacy assertions run, then they stay narrowly scoped and deterministic', async () => {
  const [contracts, harness, publicSurfaces, projectHub, t15, t16] = await Promise.all([
    readFile(new URL('../apps/dashboard/tests/e2e/helpers/contracts.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/dashboard/tests/e2e/specs/harness.spec.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/dashboard/tests/e2e/specs/public-surfaces.spec.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/dashboard/tests/e2e/specs/t12-project-hub.spec.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/dashboard/tests/e2e/specs/t15-preflight-cutover.spec.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/dashboard/tests/e2e/specs/t16-full-regression-matrix.spec.ts', import.meta.url), 'utf8'),
  ]);

  for (const source of [contracts, t15, t16]) assert.match(source, /isBenignNextPrefetchCancellation/);
  for (const marker of ["request.method() === 'GET'", "request.resourceType() === 'fetch'", '!request.isNavigationRequest()', "url.searchParams.has('_rsc')", "headers.rsc === '1'", "headers['next-router-prefetch'] === '1'"]) assert.match(contracts, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(harness, /\[data-slot="alert-title"\]/);
  assert.match(harness, /\[data-slot="alert-description"\]/);
  assert.match(harness, /\[data-slot="table"\] tbody/);
  assert.match(publicSurfaces, /footer\[aria-live="polite"\]/);
  assert.match(projectHub, /gotoWithNetworkChangedRetry/);
  assert.doesNotMatch(projectHub, /__fixture\/state/);
});

test('Given a failed request, when the benign prefetch signature is checked, then every exact field is required', async () => {
  const { isBenignNextPrefetchCancellation } = await import(browserContractsUrl.href);
  const request = (overrides = {}) => {
    const values = {
      errorText: 'net::ERR_ABORTED', method: 'GET', resourceType: 'fetch', navigation: false,
      url: 'http://console.localhost:3410/org/raibit/projects?_rsc=fixture',
      headers: { rsc: '1', 'next-router-prefetch': '1' }, ...overrides,
    };
    return {
      failure: () => ({ errorText: values.errorText }), method: () => values.method,
      resourceType: () => values.resourceType, isNavigationRequest: () => values.navigation,
      url: () => values.url, headers: () => values.headers,
    };
  };

  assert.equal(isBenignNextPrefetchCancellation(request()), true);
  for (const changed of [
    { errorText: 'net::ERR_FAILED' }, { method: 'POST' }, { resourceType: 'document' }, { navigation: true },
    { url: 'http://localhost:3410/org/raibit/projects?_rsc=fixture' },
    { url: 'http://console.localhost:3410/org/raibit/projects' }, { headers: { rsc: '0', 'next-router-prefetch': '1' } },
    { headers: { rsc: '1', 'next-router-prefetch': '0' } },
  ]) assert.equal(isBenignNextPrefetchCancellation(request(changed)), false);
});

test('Given a top-level navigation, when the exact network-changed error occurs, then only one retry is permitted', async () => {
  const { gotoWithNetworkChangedRetry } = await import(browserContractsUrl.href);
  const path = '/org/raibit/projects/prj_fixture_001?view=services';
  const target = `http://console.localhost:3410${path}`;
  let attempts = 0;
  const recovered = { goto: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error(`page.goto: net::ERR_NETWORK_CHANGED at ${target}`);
    return 'response';
  } };
  assert.equal(await gotoWithNetworkChangedRetry(recovered, path), 'response');
  assert.equal(attempts, 2);

  let rejectedAttempts = 0;
  const rejected = { goto: async () => { rejectedAttempts += 1; throw new Error(`page.goto: net::ERR_FAILED at ${target}`); } };
  await assert.rejects(() => gotoWithNetworkChangedRetry(rejected, path), /ERR_FAILED/);
  assert.equal(rejectedAttempts, 1);
});
