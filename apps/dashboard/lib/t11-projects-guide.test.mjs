import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { projectCreatePayloadFromForm } from './request-security.js';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('T11 project pages preserve organization-aware routes and aggregate counts', async () => {
  const [overview, projects, card] = await Promise.all([
    read('app/console/page.tsx'),
    read('app/org/[orgSlug]/projects/page.tsx'),
    read('components/project-card.tsx'),
  ]);
  assert.match(overview, /redirect\('\/login\?error=session_expired&next=\/console'\)/);
  assert.match(overview, /project\.organizationSlug \|\| project\.organizationId/);
  assert.match(overview, /project\.serviceCount \?\? project\.services/);
  assert.match(overview, /project\.resourceCount \?\? project\.resources/);
  assert.match(overview, /일부 정보를 불러오지 못했습니다\./);
  assert.doesNotMatch(overview, /issue\.message/);
  assert.match(projects, /orgSlug === 'all'/);
  assert.match(projects, /href=\{`\/org\/\$\{orgSlug\}\/projects\/\$\{project\.id\}`\}/);
  assert.match(card, /project\.services \?\? project\.serviceCount \?\? 0/);
  assert.match(card, /project\.resources \?\? project\.resourceCount \?\? 0/);
});

test('T11 optional creation form preserves native validation and source-specific controls', async () => {
  const [wizard, source] = await Promise.all([read('components/project-create-wizard.tsx'), read('components/creation-source-fields.tsx')]);
  assert.match(wizard, /<form method="post" action=\{action\}/);
  for (const name of ['name', 'slug', 'serviceName', 'type', 'database', 'cache']) assert.match(wizard, new RegExp(`name="${name}"`));
  for (const name of ['repoUrl', 'branch', 'sourceType', 'dockerfilePath', 'buildContext']) assert.match(source, new RegExp(`name="${name}"`));
  assert.match(wizard, /<CreationSourceFields imageField="image"/);
  assert.match(source, /name=\{imageField\} required=\{!isRepository\}/);
  assert.match(source, /<fieldset disabled=\{!isRepository\} hidden=\{!isRepository\}/);
  assert.match(source, /<fieldset disabled=\{isRepository\} hidden=\{isRepository\}/);
  assert.doesNotMatch(`${wizard}\n${source}`, /name="organizationId"|data-wizard-next|data-step=/);
  assert.match(wizard, /onInvalidCapture=[\s\S]*closest\('details'\)\?\.setAttribute\('open', ''\)/);
  assert.match(wizard, /<button type="submit"[^>]*data-wizard-submit>/);
  assert.doesNotMatch(wizard, /requestSubmit|\.submit\(/);
});

test('T11 optional resources attach to the created service without accepting client tenant identity', () => {
  const payload = projectCreatePayloadFromForm({ name: 'Club', sourceType: 'github', repoUrl: 'https://github.com/club/site', serviceName: 'web', type: 'web', database: 'postgresql', cache: 'redis', organizationId: 'outsider' });
  assert.equal(Object.hasOwn(payload, 'organizationId'), false);
  assert.deepEqual(payload.services[0].attachedResources, ['postgresql', 'redis']);
  assert.deepEqual(payload.resources, [{ name: 'postgresql', type: 'database', engine: 'postgresql' }, { name: 'redis', type: 'cache', engine: 'redis' }]);
});

test('T11 guide uses URL topics and resolves project destinations through the active organization', async () => {
  const guide = await read('app/guide/page.tsx');
  for (const topic of ['projects', 'source', 'environment', 'deployments', 'resources', 'github', 'administration']) {
    assert.match(guide, new RegExp(`/guide\\?topic=${topic}`));
  }
  assert.match(guide, /dashboardApiContext\(\)/);
  assert.match(guide, /getJson\('\/auth\/me'/);
  assert.match(guide, /context\.token \? getJson\('\/auth\/me'[\s\S]*: Promise\.resolve\(null\)/);
  assert.match(guide, /selectedWorkspace\(\{ subject: me\.body\?\.subject, memberships: me\.body\?\.memberships \}\)/);
  assert.match(guide, /return authenticated[\s\S]*<ConsoleShell[\s\S]*: <><PublicHeader[\s\S]*<main id="main-content">/);
  assert.match(guide, /href=\{authenticated \? nextHref : '\/login\?mode=signup'\}/);
  assert.doesNotMatch(guide, /redirect\(/);
  assert.match(guide, /`\/org\/\$\{encodeURIComponent\(orgSlug\)\}\/projects`/);
  assert.match(guide, /<span className=\{cn\('text-xs', current \? 'text-primary' : 'text-muted-foreground'\)\}>\{item\.description\}<\/span>/);
  assert.doesNotMatch(guide, /href: '\/projects'/);
});
