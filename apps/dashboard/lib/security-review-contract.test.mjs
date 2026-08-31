import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('Given the Windows E2E fixture When cleanup runs Then only tracked child processes may be terminated', async () => {
  const [failureCleanup, processTree] = await Promise.all([
    read('../tests/e2e/fixture/failure-cleanup.test.mjs'),
    read('../tests/e2e/fixture/process-tree.mjs'),
  ]);

  assert.doesNotMatch(failureCleanup, /Get-NetTCPConnection|OwningProcess|cleanupListeningPorts|taskkill\.exe/);
  assert.match(processTree, /String\(child\.pid\)/);
  assert.doesNotMatch(processTree, /Get-NetTCPConnection|LocalPort|OwningProcess/);
});

test('Given the local E2E dashboard When its server starts Then it binds only to loopback', async () => {
  const source = await read('../tests/e2e/fixture/serve.mjs');

  assert.match(source, /'--hostname', '127\.0\.0\.1'/);
  assert.doesNotMatch(source, /'--hostname', '0\.0\.0\.0'/);
});

test('Given error fixtures When their runtime policy is evaluated Then only an explicit local fixture environment is allowed', async () => {
  const source = await read('../app/errors/fixtures/fixture-access.ts');

  assert.match(source, /function e2eFixturesEnabled/);
  assert.match(source, /RAIBITSERVER_E2E_FIXTURES/);
  assert.match(source, /RAIBITSERVER_BASE_DOMAIN/);
  assert.match(source, /RAIBITSERVER_DASHBOARD_ORIGIN/);
  assert.match(source, /\.localhost/);
});

test('Given project hub data When it reaches presentation components Then API authorization context is absent', async () => {
  const [types, page, ...components] = await Promise.all([
    read('../components/project-hub/types.ts'),
    read('../app/org/[orgSlug]/projects/[projectId]/page.tsx'),
    read('../components/project-hub/operations.tsx'),
    read('../components/project-hub/services.tsx'),
    read('../components/project-hub/environment.tsx'),
    read('../components/project-hub/settings.tsx'),
  ]);

  assert.doesNotMatch(types, /DashboardApiContext|\bcontext:/);
  assert.doesNotMatch(page, /context: state\.context/);
  for (const component of components) assert.doesNotMatch(component, /data\.context/);
});

test('Given DESIGN.md verification guidance When the linter is invoked Then the package version is pinned', async () => {
  const design = await read('../../../DESIGN.md');

  assert.match(design, /npx --yes -p @google\/design\.md@0\.4\.0 designmd lint DESIGN\.md/);
  assert.doesNotMatch(design, /npx @google\/design\.md lint DESIGN\.md/);
});
