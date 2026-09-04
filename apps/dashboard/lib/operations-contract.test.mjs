import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { decodeDeploymentRouteSegment, encodeDeploymentRouteSegment } from './deployment-route-segment.ts';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('deployment operations keep all five URL-addressed views and bounded semantic output', async () => {
  // Given: the deployment detail route is the server-owned operations surface.
  const source = await read('../app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx');

  // When: its route and presentation contracts are inspected.
  const viewUrls = ['overview', 'logs', 'events', 'rollback', 'cancel'];

  // Then: every view is addressable and operational output stays semantic and bounded.
  for (const view of viewUrls) assert.ok(source.includes(`view=${view}`), `missing deployment view=${view}`);
  assert.match(source, /<Table[\s\S]*?<TableHeader[\s\S]*?<TableHead/);
  assert.match(source, /overflow-x-auto/);
  assert.match(source, /role="log"[\s\S]*tabIndex=\{0\}/);
  assert.match(source, /aria-label=\{label\}/);
  assert.match(source, /focus-visible:ring-ring\/50/);
  assert.doesNotMatch(source, /<LogViewer/);
  assert.match(source, /break-all/);
  assert.match(source, /QUEUED[\s\S]*BUILDING[\s\S]*IMAGE_READY/);
});

test('deployment mutations preserve exact endpoints, fields, return paths, and confirmation rules', async () => {
  // Given: rollback and cancellation are native server-posted forms.
  const [source, operationSubmit] = await Promise.all([
    read('../app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx'),
    read('../components/operation-submit.tsx'),
  ]);

  // When: their machine-consumed contracts are inspected.
  // Then: rollback is confirmed, cancellation is status-gated, and no status mutation is exposed.
  assert.match(source, /apiAction\(`\/deployments\/\$\{encodedDeploymentId\}\/rollback`, context\)/);
  assert.match(source, /id="rollback-deployment"[\s\S]*name="imageUrl"[\s\S]*name="confirmed"[\s\S]*required/);
  assert.match(source, /apiAction\(`\/deployments\/\$\{encodedDeploymentId\}\/cancel`, context\)/);
  assert.match(source, /name="reason"/);
  assert.match(source, /returnTo=\{`\$\{base\}\?view=overview`\}/);
  assert.match(operationSubmit, /<form[\s\S]*action=\{action\}[\s\S]*method="post"/);
  assert.match(operationSubmit, /name="_returnTo"/);
  assert.doesNotMatch(source, /\/deployments\/\$\{(?:deploymentId|encodedDeploymentId)\}\/status/);
});

test('deployment route IDs decode at most once and use one canonical encoded path segment', () => {
  const sourcePath = '../app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx';
  const hostile = 'dep_fixture_<img src=x onerror=fixture-hostile-id>';
  const longId = `dep_fixture_${'x'.repeat(180)}`;
  const cases = [
    { input: hostile, decoded: hostile, encoded: encodeURIComponent(hostile) },
    { input: encodeURIComponent(hostile), decoded: hostile, encoded: encodeURIComponent(hostile) },
    { input: 'dep_100%_ready', decoded: 'dep_100%_ready', encoded: 'dep_100%25_ready' },
    { input: 'dep_%E0%A4%A', decoded: 'dep_%E0%A4%A', encoded: 'dep_%25E0%25A4%25A' },
    { input: 'dep_fixture_parent/child', decoded: 'dep_fixture_parent/child', encoded: 'dep_fixture_parent%2Fchild' },
    { input: longId, decoded: longId, encoded: longId },
  ];

  for (const scenario of cases) {
    assert.equal(decodeDeploymentRouteSegment(scenario.input), scenario.decoded);
    assert.equal(encodeDeploymentRouteSegment(scenario.input), scenario.encoded);
    assert.ok(!encodeDeploymentRouteSegment(scenario.input).includes('/'), `route separator escaped for ${scenario.input}`);
  }
  assert.doesNotMatch(encodeDeploymentRouteSegment(encodeURIComponent(hostile)), /%253C/);
  return read(sourcePath).then((source) => {
    assert.match(source, /const decodedDeploymentId = decodeDeploymentRouteSegment\(deploymentId\)/);
    assert.match(source, /const encodedDeploymentId = encodeDeploymentRouteSegment\(deploymentId\)/);
    assert.match(source, /getJson\(`\/deployments\/\$\{encodedDeploymentId\}`/);
    assert.match(source, /apiAction\(`\/deployments\/\$\{encodedDeploymentId\}\/rollback`/);
    assert.match(source, /apiAction\(`\/deployments\/\$\{encodedDeploymentId\}\/cancel`/);
    assert.match(source, /deployments\/\$\{encodedDeploymentId\}`/);
    assert.match(source, />\{decodedDeploymentId\}<\/span>/);
    assert.doesNotMatch(source, /deployments\/\$\{deploymentId\}/);
  });
});

test('resource operations keep seven views, engine defaults, and exact mutation contracts', async () => {
  // Given: the resource console keeps server-owned loading and a bounded client query leaf.
  const [source, queryConsole, operationSubmit] = await Promise.all([
    read('../app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx'),
    read('../components/resource-query-console.tsx'),
    read('../components/operation-submit.tsx'),
  ]);
  const mutationSource = `${source}\n${queryConsole}\n${operationSubmit}`;

  // When: its URL, engine, and native form contracts are inspected.
  // Then: all seven views and all four mutation endpoints remain present.
  for (const view of ['overview', 'schema', 'query', 'connection', 'backups', 'provision', 'provider']) {
    assert.ok(source.includes(`view=${view}`), `missing resource view=${view}`);
  }
  for (const endpoint of ['/console/query', '/console/command', '/provision', '/attach']) {
    assert.ok(mutationSource.includes(endpoint), `missing resource endpoint ${endpoint}`);
  }
  for (const field of ['query', 'command', 'confirmed', 'serviceId', 'envPrefix', '_returnTo']) {
    assert.ok(mutationSource.includes(`name="${field}"`), `missing resource field ${field}`);
  }
  assert.equal(mutationSource.match(/name="confirmed"/g)?.length, 2);
  const provisioning = await read('../components/resource-provision-actions.tsx');
  for (const marker of ['preview-plan', 'live-provision', 'OperationSubmit', 'returnTo']) assert.ok(provisioning.includes(marker), marker);
  for (const marker of ['running.current', 'aria-busy', 'aria-live="polite"', 'name="_returnTo"']) assert.ok(operationSubmit.includes(marker), marker);
  assert.doesNotMatch(source, /name="dryRun"/);
  assert.match(source, /id="provider-command"[\s\S]*name="confirmed"[\s\S]*required/);
  assert.match(queryConsole, /name="query"[\s\S]*name="confirmed"[\s\S]*value="true"(?![\s\S]*required)/);
  assert.match(queryConsole, /fetch\(action,[\s\S]*'content-type': 'application\/json'/);
  assert.match(queryConsole, /if \(!response\.ok\)/);
  assert.match(source, /postgresql:[\s\S]*mongodb:[\s\S]*redis:[\s\S]*'object-storage':[\s\S]*nats:/);
  assert.match(source, /provider-owned-secret/);
  assert.match(source, /filter\(\(\[key\]\) => key !== 'connectionInfo'\)/);
});

test('resource schema stays server-owned while query results use one bounded client leaf', async () => {
  // Given: partial, empty, and long provider data can reach the server-rendered page.
  const [source, queryConsole] = await Promise.all([
    read('../app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx'),
    read('../components/resource-query-console.tsx'),
  ]);

  // When: its presentation boundary is inspected.
  // Then: server data stays server-rendered and only the interactive query owns client state.
  assert.match(source, /<Table[\s\S]*?<TableHeader[\s\S]*?<TableHead/);
  assert.match(source, /overflow-x-auto/);
  assert.match(source, /code-panel/);
  assert.match(source, /break-all/);
  assert.doesNotMatch(source, /['"]use client['"]/);
  assert.doesNotMatch(source, /use(?:State|Effect|Reducer|Query)\s*\(/);
  assert.match(queryConsole, /^['"]use client['"]/);
  assert.match(queryConsole, /aria-label="쿼리 결과"/);
  assert.match(queryConsole, /overflow-x-auto/);
  assert.doesNotMatch(queryConsole, /dangerouslySetInnerHTML/);
});
