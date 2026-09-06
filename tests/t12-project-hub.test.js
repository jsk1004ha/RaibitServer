import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const projectPageUrl = new URL('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx', import.meta.url);
const featureDirectoryUrl = new URL('../apps/dashboard/components/project-hub/', import.meta.url);
const sectionNavigationUrl = new URL('../apps/dashboard/components/section-navigation.tsx', import.meta.url);
const sectionNavigationScrollUrl = new URL('../apps/dashboard/components/section-navigation-scroll.tsx', import.meta.url);

async function projectHubSource() {
  const entries = await fs.readdir(featureDirectoryUrl);
  const sources = await Promise.all(entries.filter((entry) => entry.endsWith('.tsx') || entry.endsWith('.ts')).map((entry) => fs.readFile(new URL(entry, featureDirectoryUrl), 'utf8')));
  return sources.join('\n');
}

test('project detail remains a server loader for every durable URL view', async () => {
  // Given the project detail route and its server-safe view modules.
  const [page, hub] = await Promise.all([fs.readFile(projectPageUrl, 'utf8'), projectHubSource()]);

  // When the route contract is inspected.
  const source = `${page}\n${hub}`;

  // Then all views remain query-addressable without a client data layer.
  assert.doesNotMatch(page, /^["']use client["'];/m);
  assert.match(page, /loadProjectConsole\(projectId\)/);
  for (const view of ['overview', 'services', 'new-service', 'edit-service', 'deployments', 'agent', 'resources', 'new-resource', 'environment', 'logs', 'settings']) {
    assert.ok(source.includes(`'${view}'`), `${view} view is missing`);
  }
  assert.match(source, /view=environment&serviceId=/);
  assert.match(source, /view=edit-service&serviceId=/);
});

test('project hub preserves native mutation payloads and explicit destructive confirmation', async () => {
  // Given the complete project hub source.
  const source = await projectHubSource();

  // When native form contracts and the deletion dialog are inspected.
  const requiredMarkers = ['name="_returnTo"', '/deployment-agent/apply', '/env-file'];

  // Then native payloads remain intact and deletion requires explicit confirmation.
  for (const marker of requiredMarkers) assert.ok(source.includes(marker), `${marker} is missing`);
  assert.match(source, /method: 'PATCH'/);
  assert.match(source, /method: 'POST'/);
  assert.match(source, /name="deploymentType"[^>]+value="production"/);
  assert.match(source, /name="deploymentType"[^>]+value="preview"/);
  assert.match(source, /영향과 복구 절차를 확인했습니다\./);
  assert.match(source, /editedEnvironment\?\.isSecret \? ''/);
  assert.match(source, /disabled=\{!plan\.canApply\}/);
  assert.match(source, /id="project-delete-confirmed"/);
  assert.match(source, /disabled=\{!deleteConfirmed \|\| deletion\.kind === 'pending'\}/);
  assert.match(source, /settings\/deletion/);
  assert.match(source, /JSON\.stringify\(\{ confirmed: true \}\)/);
  assert.doesNotMatch(source, /name="_confirmProject"/);
});

test('project hub exposes explicit empty, partial-error, and long-log surfaces', async () => {
  // Given the complete project hub source.
  const source = await projectHubSource();

  // When operational edge states are inspected.
  // Then empty collections, partial loading, and wrapping logs are represented.
  for (const copy of ['일부 정보를 불러오지 못했습니다.', '서비스가 없습니다.', '리소스가 없습니다.', '아직 배포가 없습니다.', '표시할 런타임 로그가 없습니다.']) {
    assert.ok(source.includes(copy), `${copy} edge state is missing`);
  }
  assert.match(source, /overflow-wrap-anywhere|break-words/);
  assert.match(source, /overflow-x-auto/);
});

test('project hub contains narrow content and renders one deploy form pair per service', async () => {
  // Given the route frame and service view source.
  const [hub, services] = await Promise.all([
    fs.readFile(new URL('project-hub.tsx', featureDirectoryUrl), 'utf8'),
    fs.readFile(new URL('services.tsx', featureDirectoryUrl), 'utf8'),
  ]);

  // When responsive containment and service iteration are inspected.
  const serviceIterations = services.match(/data\.services\.map/g) || [];

  // Then the route contains intrinsic tab width in an owned scroller, and each service has one semantic action pair.
  assert.match(hub, /min-w-0 max-w-full/);
  assert.match(hub, /overflow-x-hidden/);
  assert.match(hub, /block w-full min-w-0 max-w-full overflow-x-auto/);
  assert.match(hub, /\[&>nav\]:relative \[&>nav\]:w-max \[&>nav\]:min-w-full/);
  assert.match(hub, /\[&>nav>div\]:w-max \[&>nav>div\]:min-w-full \[&>nav>div\]:overflow-visible/);
  assert.match(hub, /aria-label="프로젝트 화면 탐색 스크롤"/);
  assert.match(hub, /data-project-nav-viewport[\s\S]+role="region"[\s\S]+tabIndex=\{0\}/);
  assert.equal(serviceIterations.length, 1);
  assert.match(services, /data-service-id=\{service\.id\}/);
  assert.doesNotMatch(services, /hidden md:block[\s\S]+md:hidden/);
  assert.match(services, /lg:grid-cols-\[minmax\(0,1\.25fr\)_4\.5rem_6rem_minmax\(0,1fr\)_auto_auto\]/);
  assert.doesNotMatch(services, /md:grid-cols-\[minmax\(0,1\.25fr\)_4\.5rem_6rem_minmax\(0,1fr\)_auto_auto\]/);
  assert.equal((services.match(/name="deploymentType"[^>]+value="production"/g) || []).length, 1);
  assert.equal((services.match(/name="deploymentType"[^>]+value="preview"/g) || []).length, 1);
});

test('runtime logs expose a labelled keyboard-scroll viewport', async () => {
  // Given the runtime log viewer source.
  const shared = await fs.readFile(new URL('shared.tsx', featureDirectoryUrl), 'utf8');

  // When its overflow contract is inspected.
  // Then keyboard users can focus the labelled scroll region and see focus treatment.
  assert.match(shared, /role="log" aria-label="런타임 로그" data-runtime-log-viewport tabIndex=\{0\}/);
  assert.match(shared, /overflow-auto/);
  assert.match(shared, /focus-visible:ring-3/);
  assert.match(shared, /lg:grid-cols-\[10rem_5rem_minmax\(0,1fr\)\]/);
  assert.doesNotMatch(shared, /sm:grid-cols-\[10rem_5rem_minmax\(0,1fr\)\]/);
});

test('project navigation reveals the active tab after direct mobile navigation', async () => {
  // Given a URL-addressable project view whose active tab may start outside the narrow viewport.
  const [navigation, scroll] = await Promise.all([
    fs.readFile(sectionNavigationUrl, 'utf8'),
    fs.readFile(sectionNavigationScrollUrl, 'utf8'),
  ]);

  // When the isolated scroll leaf hydrates, then the server-rendered current item is centered without a vertical page jump.
  assert.doesNotMatch(navigation, /['"]use client['"]/);
  assert.match(navigation, /<SectionNavigationScroll current=\{current\}[^>]*>/);
  assert.match(scroll, /^'use client';/);
  assert.match(scroll, /querySelector<HTMLElement>\('\[aria-current\]'\)/);
  assert.match(scroll, /scrollIntoView\(\{ block: 'nearest', inline: 'center' \}\)/);
});

test('service creation keeps baseline sources while editing retains advanced sources and a valid port range', async () => {
  // Given the service create/edit form source.
  const services = await fs.readFile(new URL('services.tsx', featureDirectoryUrl), 'utf8');

  // When source choices and numeric constraints are inspected.
  // Then create stays on the supported baseline, while edit preserves legacy choices and TCP port bounds.
  assert.match(services, /const createSourceTypes = \[[\s\S]*?'github'[\s\S]*?'image'[\s\S]*?'local'[\s\S]*?\] as const;/);
  const createSources = services.match(/const createSourceTypes = \[([\s\S]*?)\] as const;/)?.[1] || '';
  assert.doesNotMatch(createSources, /'gitlab'|'zip'/);
  assert.match(services, /const editSourceTypes = \[[\s\S]*?'gitlab'[\s\S]*?'zip'/);
  assert.match(services, /service \? editSourceTypes : createSourceTypes/);
  assert.match(services, /label="포트" max=\{65535\} min=\{1\}/);
});
