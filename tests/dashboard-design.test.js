import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { RESOURCE_CAPABILITIES } from '../packages/core/src/resource-capabilities.ts';

// allow: SIZE_OK — this is the plan-required route/form behavior ledger, not one production unit.
const read = (path) => fs.readFile(new URL(path, import.meta.url), 'utf8');
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');


test('approved RAIBIT visual contract identifies the redesign and its target surfaces', async () => {
  const design = await read('../DESIGN.md');
  for (const contract of [
    /name:\s*raibit-supabase-inspired/,
    /primary:\s*"#091936"/,
    /fontFamily:\s*"'Wanted Sans'/,
    /RAIBIT target pages:[^\n]*home \(`\/`\), `\/login`, `\/status`, `\/console`, and project\/service\/resource routes/,
    /Mobile \| < 768px/,
  ]) assert.match(design, contract);
});

test('native POST contracts preserve return targets, override fields, and confirmations', async () => {
  const [shell, login, projectRoute, projectServices, projectOperations, projectSettings, projectEnvironment, deployment, resource, resourceQuery, github] = await Promise.all([
    read('../apps/dashboard/components/console-ui.tsx'),
    read('../apps/dashboard/app/login/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx'),
    read('../apps/dashboard/components/project-hub/services.tsx'),
    read('../apps/dashboard/components/project-hub/operations.tsx'),
    read('../apps/dashboard/components/project-hub/settings.tsx'),
    read('../apps/dashboard/components/project-hub/environment.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx'),
    read('../apps/dashboard/components/resource-query-console.tsx'),
    read('../apps/dashboard/app/github/page.tsx'),
  ]);
  const project = [projectRoute, projectServices, projectOperations, projectSettings, projectEnvironment].join('\n');
  assert.match(shell, /method="post"\s+action=\{apiAction\('\/auth\/logout'\)\}[\s\S]*?name="_returnTo"\s+value="\/login"/);
  for (const marker of [
    'name="_returnTo" type="hidden" value={next}',
    'name="_returnTo" type="hidden" value="/login?mode=verify"',
  ]) assert.ok(login.includes(marker), `${marker} auth return target missing`);
  for (const marker of [
    'name="_returnTo" type="hidden" value={`${data.base}?view=services`}', 'name="deploymentType" type="hidden" value="production"',
    'name="deploymentType" type="hidden" value="preview"', 'name="_method" type="hidden" value="PATCH"', 'name="_method" type="hidden" value="DELETE"',
    'name="_returnTo" type="hidden" value={`/org/${orgSlug}/projects`}', 'name="_confirmProject"',
  ]) assert.ok(project.includes(marker), `${marker} project mutation contract missing`);
  assert.match(deployment, /apiAction\(`\/deployments\/\$\{encodedDeploymentId\}\/rollback`[\s\S]*?name="_returnTo" value=\{`\$\{base\}\?view=overview`\}[\s\S]*?name="confirmed" value="true" required/);
  assert.ok(resource.includes('returnTo={`${base}?view=query`}'), 'query return target wiring missing');
  assert.ok(resourceQuery.includes('<input name="_returnTo" type="hidden" value={returnTo} />'), 'query fallback return target missing');
  for (const marker of [
    'name="_returnTo" value={`${base}?view=provider`}',
    'name="confirmed" value="true"', 'ResourceProvisionActions', 'name="serviceId"', 'name="envPrefix"',
  ]) assert.ok(resource.includes(marker), `${marker} resource mutation contract missing`);
  for (const marker of [
    'name="_returnTo" value="/github?step=attach"', 'name="_returnTo" value="/github?step=sync"',
    'selectedRepository.fullName', 'encodeURIComponent(selectedRepository.fullName)',
  ]) assert.ok(github.includes(marker), `${marker} GitHub mutation contract missing`);
});

test('dashboard shell is Korean-first, server-first, and keeps route navigation typed', async () => {
  const shell = await read('../apps/dashboard/components/console-ui.tsx');

  for (const label of ['개요', '프로젝트', '프로젝트 만들기', 'GitHub 연결', '관리자', '로그인']) {
    assert.ok(shell.includes(label), `${label} navigation label missing`);
  }
  assert.match(shell, /type\s+NavItemId\s*=/);
  assert.match(shell, /getJson\('\/auth\/me'/);
  assert.match(shell, /if\s*\(!me\.ok\)\s*redirect\('\/login\?error=session_expired'\)/);
  assert.doesNotMatch(shell, /['"]use client['"]/);
  assert.doesNotMatch(shell, /<svg\b/);
  assert.doesNotMatch(shell, />Dashboard</);
  assert.doesNotMatch(shell, />Create project</);
});

test('shared dashboard primitives keep localized deterministic route and security contracts', async () => {
  const callerContracts = [
    ['../apps/dashboard/app/console/page.tsx', 'overview'],
    ['../apps/dashboard/app/admin/page.tsx', 'admin'],
    ['../apps/dashboard/app/github/page.tsx', 'github'],
    ['../apps/dashboard/app/guide/page.tsx', 'guide'],
    ['../apps/dashboard/app/org/[orgSlug]/projects/page.tsx', 'projects'],
    ['../apps/dashboard/app/org/[orgSlug]/projects/new/page.tsx', 'create-project'],
    ['../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx', 'projects'],
    ['../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx', 'projects'],
    ['../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx', 'projects'],
  ];
  const [shell, ...callers] = await Promise.all([
    read('../apps/dashboard/components/console-ui.tsx'),
    ...callerContracts.map(([path]) => read(path)),
  ]);

  assert.match(shell, /type\s+NavItemId\s*=\s*'overview'\s*\|\s*'projects'\s*\|\s*'create-project'\s*\|\s*'github'\s*\|\s*'guide'\s*\|\s*'admin'/);
  assert.match(shell, /active\?:\s*NavItemId/);
  assert.match(shell, /id:\s*NavItemId/);
  for (const [id, label, href, icon] of [
    ['overview', '개요', '/console', 'squares-2x2'],
    ['projects', '프로젝트', 'organizationLinks.projects', 'folder'],
    ['create-project', '프로젝트 만들기', 'organizationLinks.createProject', 'plus'],
    ['github', 'GitHub 연결', '/github', 'arrow-top-right-on-square'],
    ['guide', '사용 안내', '/guide', 'command-line'],
    ['admin', '관리자', '/admin', 'user-group'],
  ]) {
    assert.ok(shell.includes(`id: '${id}'`), `${id} navigation id missing`);
    assert.ok(shell.includes(`label: '${label}'`), `${label} navigation label missing`);
    const hrefContract = href.startsWith('organizationLinks.') ? `href: ${href}` : `href: '${href}'`;
    assert.ok(shell.includes(hrefContract), `${href} navigation href missing`);
    assert.ok(shell.includes(`icon: '${icon}'`), `${icon} navigation icon missing`);
  }
  assert.match(shell, /active\s*=\s*'overview'/);
  assert.match(shell, /resolveOrganizationRouteValue/);
  assert.match(shell, /const\s+current\s*=\s*active\s*===\s*item\.id/);
  assert.match(shell, /const\s+current\s*=\s*active\s*===\s*item\.id[\s\S]*aria-current=\{current \? 'page' : undefined\}/);
  for (const [index, [path, active]] of callerContracts.entries()) {
    assert.ok(callers[index].includes(`<ConsoleShell active="${active}"`), `${path} must use active id ${active}`);
  }

  assert.match(shell, /method="post"\s+action=\{apiAction\('\/auth\/logout'\)\}/);
  assert.match(shell, /name="_returnTo"\s+value="\/login"/);
  assert.match(shell, /ConsoleMobileNav/);
  assert.match(shell, /ConsoleSearch/);
});

test('console command palette provides keyboard search through an accessible Base UI dialog', async () => {
  const [shell, search, command, dialog] = await Promise.all([
    read('../apps/dashboard/components/console-ui.tsx'),
    read('../apps/dashboard/components/console-search.tsx'),
    read('../apps/dashboard/components/ui/command.tsx'),
    read('../apps/dashboard/components/ui/dialog.tsx'),
  ]);

  assert.match(shell, /<ConsoleSearch items=\{searchItems\}\s*\/>/);
  for (const projectMenu of ['프로젝트 현황', '서비스', '배포', '리소스', '로그', '설정']) {
    assert.ok(shell.includes(`label: '${projectMenu}'`), `${projectMenu} project search item missing`);
  }
  for (const marker of ["'use client'", '메뉴 검색', 'aria-haspopup="dialog"', 'CommandDialog', 'CommandInput', 'CommandList', 'CommandGroup', 'CommandItem', 'CommandEmpty', "event.key === '/'"]) {
    assert.ok(search.includes(marker), `${marker} command palette contract missing`);
  }
  assert.match(search, /event\.metaKey\s*\|\|\s*event\.ctrlKey/);
  for (const marker of ['<Dialog ', '<DialogContent', '<DialogTitle>', '<DialogDescription>']) {
    assert.ok(command.includes(marker), `${marker} command dialog composition missing`);
  }
  assert.match(dialog, /@base-ui\/react\/dialog/);
  assert.match(dialog, /DialogPrimitive\.Backdrop/);
  assert.match(dialog, /DialogPrimitive\.Popup/);
  assert.doesNotMatch(search, /role="dialog"|aria-modal="true"|event\.key === 'Escape'|event\.key === 'ArrowDown'|event\.key === 'ArrowUp'/);
  assert.ok(shell.includes('사용 설명서'));
  assert.doesNotMatch(shell, /\{actions\}/);
});

test('project cards render compact Korean console rows', async () => {
  const card = await read('../apps/dashboard/components/project-card.tsx');

  assert.match(card, /from 'lucide-react'/);
  assert.match(card, /from '@\/components\/ui\/card'/);
  assert.match(card, /from '@\/components\/ui\/badge'/);
  assert.ok(card.includes('serviceCount = project.services ?? project.serviceCount ?? 0'));
  assert.ok(card.includes('resourceCount = project.resources ?? project.resourceCount ?? 0'));
  assert.ok(card.includes('서비스 {serviceCount}개'));
  assert.ok(card.includes('리소스 {resourceCount}개'));
  assert.ok(card.includes('aria-label={`${title} 프로젝트 콘솔 열기`}'));
});

test('public landing keeps the introduction focused and exposes an auto-refreshing system status', async () => {
  const [home, status, statusPanel, statusRoute, statusModel, contributors, support, privacy, footer] = await Promise.all([
    read('../apps/dashboard/app/page.tsx'),
    read('../apps/dashboard/app/status/page.tsx'),
    read('../apps/dashboard/components/system-status-panel.tsx'),
    read('../apps/dashboard/app/api/status/route.ts'),
    read('../apps/dashboard/lib/status-model.js'),
    read('../apps/dashboard/app/contributors/page.tsx'),
    read('../apps/dashboard/app/support/page.tsx'),
    read('../apps/dashboard/app/privacy/page.tsx'),
    read('../apps/dashboard/components/public-footer.tsx'),
  ]);

  assert.doesNotMatch(home, /['"]use client['"]|searchParams|query\.variant/);
  assert.match(home, /<h1[^>]*>[\s\S]*만들고, 올리고, 운영하세요\.[\s\S]*<\/h1>/);
  assert.ok(home.includes('인천과학고등학교의 최고 정보 동아리 라이빗의 호스팅 서비스입니다.'));
  assert.ok(home.includes('loadPublicSites(5)'));
  assert.ok(home.includes('운영 중인 사이트'));
  assert.ok(home.includes('LIVE'));
  assert.ok(home.includes('href="/status"'));
  assert.ok(home.includes('전체 시스템 상태'));
  assert.ok(status.includes('loadSystemStatus()'));
  assert.ok(status.includes('RAIBIT SERVER 상태'));
  assert.ok(status.includes('<SystemStatusPanel initialStatus={status} />'));
  assert.doesNotMatch(status, /loadPublicSites|public-site-list/);
  for (const marker of ['"use client"', 'fetch("/api/status"', 'window.setInterval', 'visibilitychange', '초 자동 갱신', '배포 버전', 'snapshot.deployment.commitUrl', 'GitHub 커밋', 'aria-label={refreshing ? "상태 확인 중" : "상태 새로고침"}', 'aria-busy={refreshing}', 'aria-live="polite"']) {
    assert.ok(statusPanel.includes(marker), `${marker} status UI contract missing`);
  }
  assert.doesNotMatch(statusPanel, /<svg\b|status-refresh-icon/);
  for (const marker of ['웹 콘솔', '제어 서버', '데이터 저장소']) assert.ok(statusModel.includes(marker), `${marker} status model missing`);
  for (const marker of ['commitSha', 'shortCommitSha', 'https://github.com/']) assert.ok(statusModel.includes(marker), `${marker} deployment version contract missing`);
  assert.ok(statusRoute.includes('loadSystemStatus()'));
  assert.ok(statusRoute.includes("'cache-control': 'no-store, max-age=0'"));
  assert.ok(home.includes('콘솔 시작하기'));
  assert.ok(home.includes('"/login?mode=signup"'));
  assert.ok(home.includes('<PublicFooter />'));
  assert.match(contributors, /<h1[^>]*>\s*기여자\s*<\/h1>/);
  assert.ok(contributors.includes('2309'));
  assert.ok(contributors.includes('김준서'));
  assert.ok(contributors.includes('RAIBIT SERVER 개발'));
  assert.ok(contributors.includes('teacher'));
  assert.ok(contributors.includes('최희진'));
  assert.ok(contributors.includes('서버컴퓨터와 도메인 구매'));
  assert.ok(contributors.indexOf('최희진') < contributors.indexOf('김준서'));
  assert.ok(contributors.includes('<PublicFooter />'));
  assert.match(support, /<h1[^>]*>\s*도움이 필요하신가요\?\s*<\/h1>/);
  assert.ok(support.includes('ishsraibit@gmail.com'));
  assert.ok(support.includes('GitHub Issues'));
  assert.match(privacy, /<h1[^>]*>\s*개인정보처리방침\s*<\/h1>/);
  assert.ok(privacy.includes('이름, 학번, 라이빗 동아리원 여부, 이메일, 비밀번호 해시'));
  assert.ok(privacy.includes('raibitserver_session'));
  assert.ok(privacy.includes('ishsraibit@gmail.com'));
  assert.ok(footer.includes('href="/support"'));
  assert.ok(footer.includes('href="/status"'));
  assert.ok(footer.includes('운영 현황'));
  assert.ok(footer.includes('https://github.com/jsk1004ha/RaibitServer'));
  assert.ok(footer.includes('href="/contributors"'));
  assert.ok(footer.includes('href="/privacy"'));
  assert.ok(footer.includes('개인정보 처리방침'));
  assert.ok(footer.includes('© 2026 Raibit, ISHS.'));
});

test('project list is a compact Korean row-card view scoped to its organization', async () => {
  const projects = await read('../apps/dashboard/app/org/[orgSlug]/projects/page.tsx');

  assert.ok(projects.includes('<ConsoleShell active="projects"'));
  assert.doesNotMatch(projects, /crumbs=/);
  assert.match(projects, /<h1[^>]*>프로젝트<\/h1>/);
  assert.ok(projects.includes('프로젝트 만들기'));
  assert.ok(projects.includes('첫 프로젝트 만들기'));
  assert.match(projects, /<ProjectCard\s+key=\{project\.id\}/);
  assert.ok(projects.includes('href={`/org/${orgSlug}/projects/${project.id}`}'));
  assert.ok(projects.includes('href={`/org/${orgSlug}/projects/new`}'));
  for (const marker of ['loadDashboardOverview()', 'project.organizationSlug', 'project.organizationId', "orgSlug === 'all'", '.filter((project)']) {
    assert.ok(projects.includes(marker), `${marker} project data marker missing`);
  }
  for (const oldCopy of ['Workspace', 'Create project', 'projects</h1>', 'No projects returned']) {
    assert.ok(!projects.includes(oldCopy), `${oldCopy} old visible copy remains`);
  }
});

test('project workflows preserve their server-orchestrated actions after feature extraction', async () => {
  const [createProject, wizard, projectRoute, projectHub, projectModel, overview, services, operations, environment, settings, shared] = await Promise.all([
    read('../apps/dashboard/app/org/[orgSlug]/projects/new/page.tsx'),
    read('../apps/dashboard/components/project-create-wizard.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx'),
    read('../apps/dashboard/components/project-hub/project-hub.tsx'),
    read('../apps/dashboard/components/project-hub/model.ts'),
    read('../apps/dashboard/components/project-hub/overview.tsx'),
    read('../apps/dashboard/components/project-hub/services.tsx'),
    read('../apps/dashboard/components/project-hub/operations.tsx'),
    read('../apps/dashboard/components/project-hub/environment.tsx'),
    read('../apps/dashboard/components/project-hub/settings.tsx'),
    read('../apps/dashboard/components/project-hub/shared.tsx'),
  ]);
  const createSource = `${createProject}\n${wizard}`;
  const projectDetail = [projectRoute, projectHub, projectModel, overview, services, operations, environment, settings, shared].join('\n');

  for (const marker of [
    '프로젝트 만들기', '프로젝트 기본 정보', '저장소 연결', '첫 서비스', '관리형 리소스', '프로젝트 이름', '조직',
    '저장소 URL', '브랜치', 'Dockerfile 경로', '빌드 컨텍스트', '서비스 유형',
    '데이터베이스', '캐시', '이전', '다음',
  ]) {
    assert.ok(createSource.includes(marker), `${marker} create-project marker missing`);
  }
  assert.ok(createProject.includes('<ConsoleShell active="create-project"'));
  assert.ok(createProject.includes("<ProjectCreateWizard action={apiAction('/projects')} orgSlug={orgSlug} />"));
  assert.match(wizard, /<form\s+ref=\{formRef\}\s+method="post"\s+action=\{action\}/);
  for (const name of ['name', 'slug', 'serviceName', 'repoUrl', 'branch', 'sourceType', 'image', 'dockerfilePath', 'buildContext', 'type', 'database', 'cache']) {
    assert.ok(createSource.includes(`name="${name}"`), `${name} create-project field missing`);
  }
  assert.doesNotMatch(createSource, /name="organizationId"/);
  for (const contract of [
    'value={orgSlug}', 'defaultValue="github"', 'value="github"', 'value="image"',
    'defaultValue="web"', 'value="web"', 'value="worker"', 'value="cron"', 'value="job"',
  ]) {
    assert.ok(createSource.includes(contract), `${contract} create-project value/default missing`);
  }
  for (const oldCopy of ['>Create project<', '>1 Source<', '>2 Service<', '>3 Resource<', '>POST /projects<']) {
    assert.ok(!createProject.includes(oldCopy), `${oldCopy} old visible create-project copy remains`);
  }

  for (const marker of [
    '현황', '서비스', '배포', '리소스', '환경 변수', '로그', '설정',
    '서비스 만들기', '운영 배포', '미리보기', '배포 내역',
    '리소스 추가', '관리형 리소스', '프로젝트 삭제',
    '런타임 로그', 'ProjectHub', "['services', 'new-service', 'edit-service'].includes(data.view)", "data.view === 'deployments'", "['resources', 'new-resource'].includes(data.view)",
  ]) {
    assert.ok(projectDetail.includes(marker), `${marker} project-detail marker missing`);
  }
  assert.match(projectRoute, /import\s+\{\s*ProjectHub\s*\}/);
  assert.match(projectHub, /projectNavigation\(data\.base\)/);
  assert.match(projectHub, /<LoadIssues issues=\{data\.loadErrors\}/);
  assert.match(shared, /export function MetricGrid/);
  assert.match(shared, /export function RuntimeLogViewer/);
  for (const metric of ["label: '서비스'", "label: '리소스'", "label: '배포'", 'data.services.length', 'data.resources.length', 'data.deployments.length', 'data.previewDeployments.length']) {
    assert.ok(projectRoute.includes(metric) || projectDetail.includes(metric), `${metric} project metric missing`);
  }

  for (const action of [
    '/projects/${data.projectId}/services',
    '/projects/${data.projectId}/resources',
    '/projects/${data.projectId}/services/${service.id}/deployments',
    '/services/${service?.id}',
    '/projects/${data.projectId}',
  ]) {
    assert.ok(projectDetail.includes(action), `${action} project form action missing`);
  }
  assert.ok(projectDetail.includes('name="_method" type="hidden" value="PATCH"'));
  assert.ok(projectDetail.includes('name="_method" type="hidden" value="DELETE"'));
  assert.ok(projectDetail.includes('name="_confirmProject"'));
  assert.ok(projectDetail.includes('설정 저장'));
  assert.ok(projectDetail.includes('프로젝트 삭제'));
  assert.ok(projectDetail.includes('name="deploymentType" type="hidden" value="production"'));
  assert.ok(projectDetail.includes('name="deploymentType" type="hidden" value="preview"'));
  assert.ok(projectDetail.includes('href={`${data.base}/deployments/${deployment.id}`}'));
  assert.ok(projectDetail.includes('href={`${data.base}/resources/${resource.id}/console`}'));
  for (const name of ['name', 'type', 'sourceType', 'repoUrl', 'branch', 'imageUrl', 'dockerfilePath', 'buildContext', 'engine']) {
    assert.ok(projectDetail.includes(`name="${name}"`), `${name} project-detail field missing`);
  }
  for (const deferred of ['loadProjectConsole(projectId)', 'data.resources.map']) {
    assert.ok(projectRoute.includes(deferred) || projectDetail.includes(deferred), `${deferred} deferred project data marker missing`);
  }
  for (const eagerData of ['state.resourceConsoles', 'state.buildLogs', 'state.deploymentEvents', 'state.runtimeLogs']) {
    assert.ok(!projectRoute.includes(eagerData), `${eagerData} eager detail loading must remain absent`);
  }
  for (const oldCopy of ['>Project console<', '>New service<', '>Deploy<', '>Overview<', '>Create service<', '>Deployments<', '>Create resource<', '>Danger zone<', '>Build logs<', '>Deployment events<', '>Runtime logs<']) {
    assert.ok(!projectDetail.includes(oldCopy), `${oldCopy} old visible project-detail copy remains`);
  }
});

test('dynamic project routes await Next 16 params before rendering route-bound UI', async () => {
  const [projects, createProject, projectDetail] = await Promise.all([
    read('../apps/dashboard/app/org/[orgSlug]/projects/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/new/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx'),
  ]);

  assert.match(projects, /params:\s*Promise<\{\s*orgSlug:\s*string\s*\}>/);
  assert.ok(projects.includes('const [{ orgSlug }, state] = await Promise.all([params, loadDashboardOverview()]);'));
  assert.ok(projects.includes('orgValue={orgSlug}'));
  assert.doesNotMatch(projects, /crumbs=/);

  assert.match(createProject, /params:\s*Promise<\{\s*orgSlug:\s*string\s*\}>/);
  assert.ok(createProject.includes('const { orgSlug } = await params;'));
  assert.ok(createProject.includes('orgValue={orgSlug}'));
  assert.doesNotMatch(createProject, /crumbs=/);

  assert.match(projectDetail, /params:\s*Promise<\{\s*orgSlug:\s*string;\s*projectId:\s*string\s*\}>/);
  assert.ok(projectDetail.includes('const [{ orgSlug, projectId }, query] = await Promise.all([params, searchParams]);'));
  assert.ok(projectDetail.includes('orgValue={organizationLabel}'));
  assert.ok(projectDetail.includes('orgRouteValue={orgSlug}'));
  assert.doesNotMatch(projectDetail, /crumbs=/);

  for (const [path, source] of [
    ['projects', projects],
    ['projects/new', createProject],
    ['projects/[projectId]', projectDetail],
  ]) {
    assert.doesNotMatch(source, /params\.(?:orgSlug|projectId)/, `${path} reads unresolved params`);
    assert.doesNotMatch(source, /crumbs=/, `${path} must keep page context out of the global top bar`);
  }
});

test('project workflow controls derive tenant scope server-side and expose accessible sequential navigation', async () => {
  const [createProject, wizard, projectDetail] = await Promise.all([
    read('../apps/dashboard/app/org/[orgSlug]/projects/new/page.tsx'),
    read('../apps/dashboard/components/project-create-wizard.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx'),
  ]);

  assert.ok(wizard.includes('id="project-organization" value={orgSlug} readOnly aria-describedby="organization-scope-note"'));
  assert.ok(wizard.includes('로그인 권한으로 확인'));
  assert.doesNotMatch(wizard, /<input[^>]*name="organizationId"/);
  assert.match(wizard, /<SectionNavigationScroll as="ol"[^>]*>/);
  assert.ok(wizard.includes('hidden={step !== 0}'));
  assert.ok(wizard.includes('hidden={step !== 3}'));
  assert.ok(wizard.includes('disabled={index > step}'));

  const [projectHub, services, operations] = await Promise.all([
    read('../apps/dashboard/components/project-hub/project-hub.tsx'),
    read('../apps/dashboard/components/project-hub/services.tsx'),
    read('../apps/dashboard/components/project-hub/operations.tsx'),
  ]);
  const projectFeatures = `${projectHub}\n${services}\n${operations}`;
  assert.ok(projectHub.includes('projectNavigation(data.base)'));
  for (const field of ['name="name"', 'name="type"', 'name="sourceType"', 'name="repoUrl"', 'name="branch"', 'name="imageUrl"', 'name="dockerfilePath"', 'name="buildContext"', 'name="engine"']) {
    assert.ok(projectFeatures.includes(field), `${field} explicit form field missing`);
  }
  for (const option of [
    "['web', '웹']", "['private', '비공개 서비스']",
    "['worker', '워커']", "['cron', '예약 작업']",
    "['job', '일회성 작업']",
  ]) {
    assert.ok(projectFeatures.includes(option), `${option} localized enum label missing`);
  }
  const dashboardRequire = createRequire(new URL('../apps/dashboard/package.json', import.meta.url));
  const React = dashboardRequire('react');
  const { renderToStaticMarkup } = dashboardRequire('react-dom/server');
  const ast = ts.createSourceFile('operations.tsx', operations, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let projection;
  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'Select') {
      projection = node.children.find(child => ts.isJsxExpression(child) && child.expression?.getText(ast).startsWith('RESOURCE_CAPABILITIES.map'))?.expression.getText(ast);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(projection, 'resource selector must have a generated option projection');
  const compiled = ts.transpileModule(`const result = (${projection});`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  const renderOptions = new Function('React', 'RESOURCE_CAPABILITIES', 'liveEngines', `${compiled}\nreturn result;`);
  const options = renderOptions(React, RESOURCE_CAPABILITIES, new Set(RESOURCE_CAPABILITIES.filter(entry => entry.local.provision).map(entry => entry.engine)));
  const releaseOptions = renderOptions(React, RESOURCE_CAPABILITIES, new Set());
  assert.ok(releaseOptions.every(option => option.props.disabled), 'server-unavailable engines must all remain disabled');
  assert.match(operations, /entry\.live && entry\.permitted/);
  assert.deepEqual(options.map(option => option.props.value), RESOURCE_CAPABILITIES.map(entry => entry.engine));
  for (const option of options) {
    const supported = ['postgresql', 'mysql', 'mariadb', 'mongodb', 'sqlite', 'redis', 'valkey'].includes(option.props.value);
    assert.equal(option.props.disabled, !supported, option.props.value);
    assert.ok(renderToStaticMarkup(option).includes(supported ? '로컬 전용' : '준비 중'));
  }
  assert.match(renderToStaticMarkup(options.find(option => option.props.value === 'object-storage')), /객체 저장소 · 준비 중/);
});

test('deployment detail awaits route params and keeps operational controls on a compact Korean surface', async () => {
  const deployment = await read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx');

  assert.match(deployment, /params:\s*Promise<\{\s*orgSlug:\s*string;\s*projectId:\s*string;\s*deploymentId:\s*string\s*\}>/);
  assert.ok(deployment.includes('const [{ orgSlug, projectId, deploymentId }, query] = await Promise.all([params, searchParams]);'));
  assert.doesNotMatch(deployment, /params\.(?:orgSlug|projectId|deploymentId)/);
  assert.match(deployment, /await\s+Promise\.all\(\[/);
  assert.match(deployment, /import\s+\{\s*decodeDeploymentRouteSegment,\s*encodeDeploymentRouteSegment\s*\}\s+from '@\/lib\/deployment-route-segment'/);
  assert.match(deployment, /const decodedDeploymentId = decodeDeploymentRouteSegment\(deploymentId\);/);
  assert.match(deployment, /const encodedDeploymentId = encodeDeploymentRouteSegment\(deploymentId\);/);
  for (const apiMarker of [
    'dashboardApiContext()',
    'getJson(`/deployments/${encodedDeploymentId}`',
    'getJson(`/deployments/${encodedDeploymentId}/logs`',
    'getJson(`/deployments/${encodedDeploymentId}/events`',
    'apiAction(`/deployments/${encodedDeploymentId}/rollback`, context)',
    'apiAction(`/deployments/${encodedDeploymentId}/cancel`, context)',
  ]) {
    assert.ok(deployment.includes(apiMarker), `${apiMarker} deployment operation missing`);
  }
  assert.match(deployment, /const base = `\/org\/\$\{orgSlug\}\/projects\/\$\{projectId\}\/deployments\/\$\{encodedDeploymentId\}`;/);
  assert.match(deployment, /배포 ID · <span[^>]*>\{decodedDeploymentId\}<\/span>/);
  assert.doesNotMatch(deployment, /(?:getJson|apiAction)\(`\/deployments\/\$\{deploymentId\}/);
  assert.doesNotMatch(deployment, /deployments\/\$\{encodeURIComponent\(deploymentId\)\}/);
  assert.doesNotMatch(deployment, /encodeURIComponent\(encodeDeploymentRouteSegment\(/);
  for (const marker of [
    '배포 상세', '이미지 정보', '빌드 로그', '배포 이벤트', '롤백 확인', '배포 취소',
    '배포 목록', '롤백', '상태는 빌더와 오케스트레이터가 갱신합니다.', 'detail.errorCode', 'detail.errorMessage', 'SectionNav', "view === 'logs'", "view === 'events'",
  ]) {
    assert.ok(deployment.includes(marker), `${marker} deployment marker missing`);
  }
  for (const field of ['imageUrl', 'reason']) {
    assert.ok(deployment.includes(`name="${field}"`), `${field} deployment field missing`);
  }
  assert.ok(!deployment.includes('apiAction(`/deployments/${deploymentId}/status`, context)'), 'tenant dashboard must not expose the system-owned status mutation');
  for (const field of ['status', 'imageDigest', 'errorMessage']) assert.ok(!deployment.includes(`name="${field}"`), `${field} system-owned field must be read-only`);
  assert.ok(deployment.includes("view === 'events'"));
  assert.doesNotMatch(deployment, />실시간</);
  assert.ok(deployment.includes('id="rollback-deployment"'));
  assert.match(deployment, /function DeploymentStream\(\{ rows, field, label, empty \}/);
  assert.match(deployment, /role="log"\s+tabIndex=\{0\}/);
  assert.match(deployment, /className="log-viewer[^\"]*focus-visible:outline-none[^\"]*focus-visible:ring-3/);
  assert.match(deployment, /text-inverse-foreground/);
  assert.match(deployment, /font-mono\s+text-xs/);
  assert.match(deployment, /break-all\s+whitespace-pre-wrap/);
  assert.match(deployment, /<DeploymentStream rows=\{logs\.body\?\.logs \|\| \[\]\} field="line" label="마스킹된 빌드 로그"/);
  assert.match(deployment, /<DeploymentStream rows=\{events\.body\?\.events \|\| \[\]\} field="message" label="배포 이벤트 기록"/);
  assert.doesNotMatch(deployment, /<LogViewer\b/);
  assert.doesNotMatch(deployment, /<button[^>]*type="button"[^>]*>(?:Copy|Download)<\/button>/);
});

test('resource console awaits route params and links localized tabs to real operational sections', async () => {
  const [resource, queryConsole] = await Promise.all([
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx'),
    read('../apps/dashboard/components/resource-query-console.tsx'),
  ]);
  const resourceContract = `${resource}\n${queryConsole}`;

  assert.match(resource, /params:\s*Promise<\{\s*orgSlug:\s*string;\s*projectId:\s*string;\s*resourceId:\s*string\s*\}>/);
  assert.ok(resource.includes('const [{ orgSlug, projectId, resourceId }, queryParams] = await Promise.all([params, searchParams]);'));
  assert.doesNotMatch(resource, /params\.(?:orgSlug|projectId|resourceId)/);
  assert.ok(resource.includes('loadResourceConsole(resourceId, view)'));
  for (const engineDefault of [
    "postgresql: { query: 'SELECT 1', command: 'SELECT 1'",
    "mongodb: { query: 'db.health.find({})', command: 'db.getCollectionNames()'",
    "redis: { query: 'SCAN 0 MATCH * COUNT 100', command: 'GET health:ready'",
    "'object-storage': { query: 'LIST objects', command: 'mc ls'",
    "nats: { query: 'subjects', command: 'nats stream ls'",
  ]) {
    assert.ok(resource.includes(engineDefault), `${engineDefault} resource default missing`);
  }
  for (const action of [
    'apiAction(`/resources/${resourceId}/console/query`, state.context)',
    'apiAction(`/resources/${resourceId}/console/command`, state.context)',
    'apiAction(`/resources/${resourceId}/provision`, state.context)',
    'apiAction(`/resources/${resourceId}/attach`, state.context)',
  ]) {
    assert.ok(resource.includes(action), `${action} resource operation missing`);
  }
  for (const [label, target] of [
    ['데이터 구조', 'view=schema'], ['쿼리', 'view=query'], ['백업', 'view=backups'], ['연결', 'view=connection'],
  ]) {
    assert.ok(resource.includes(target), `${target} resource screen target missing`);
    assert.ok(resource.includes(`label: '${label}'`), `${label} resource screen label missing`);
  }
  for (const marker of [
    '리소스 콘솔', '쿼리 실행', '공급자 명령 실행',
    'ResourceProvisionActions', '서비스에 연결', 'provider-owned-secret',
  ]) {
    assert.ok(resource.includes(marker), `${marker} resource marker missing`);
  }
  assert.ok(resource.includes('<ResourceQueryConsole action={apiAction(`/resources/${resourceId}/console/query`, state.context)}'));
  const provisioning = await read('../apps/dashboard/components/resource-provision-actions.tsx');
  for (const marker of ['계획 미리보기', '실제 실행 요청', 'preview-plan', 'live-provision', 'ResourceAvailabilitySchema.safeParse', 'ResourceProvisionResultSchema', 'aria-busy', 'aria-live="polite"']) assert.ok(provisioning.includes(marker), marker);
  assert.doesNotMatch(resource, /name="dryRun"/);
  for (const field of ['query', 'command', 'confirmed', 'serviceId', 'envPrefix']) {
    assert.ok(resourceContract.includes(`name="${field}"`), `${field} resource field missing`);
  }
  assert.equal(resourceContract.match(/name="confirmed"/g)?.length, 2);
  assert.match(queryConsole, /fetch\(action,[\s\S]*?body: JSON\.stringify\(\{ confirmed, query \}\)/);
  assert.match(queryConsole, /<section aria-label="쿼리 결과"/);

  assert.match(resource, /id="provider-command"[\s\S]*?<button[^>]*type="submit"[^>]*>공급자 명령 실행<\/button>/);

  const backupSection = resource.match(/\{view === 'backups' \? <section[\s\S]*?<\/section> : null\}/)?.[0];
  assert.ok(backupSection, 'independent backup empty state missing');
  assert.ok(backupSection.includes('복구 지점 준비 중'));
  assert.doesNotMatch(backupSection, /\/provision|apiAction\(/);
  assert.doesNotMatch(resource, /<form[^>]*id="backups"/);
  assert.match(resource, /<ResourceProvisionActions action=\{apiAction\(`\/resources\/\$\{resourceId\}\/provision`/);
  assert.match(provisioning, /id="provisioning"/);
  assert.ok(provisioning.includes('<h2>프로비저닝</h2>'));
  for (const marker of ['MetricStrip', 'resource-overview-grid', '리소스 정보', '빠른 시작', '보안 연결', '/guide?topic=resources']) {
    assert.ok(resource.includes(marker), `${marker} beginner resource overview marker missing`);
  }
});

test('console navigation distinguishes tab and sequential step behavior', async () => {
  const [shell, github] = await Promise.all([
    read('../apps/dashboard/components/console-ui.tsx'),
    read('../apps/dashboard/app/github/page.tsx'),
  ]);
  assert.ok(shell.includes("variant = 'tabs'"));
  assert.ok(shell.includes("variant?: 'tabs' | 'steps'"));
  assert.ok(github.includes('variant="steps"'));
});

test('guide keeps detailed help in one topic per screen', async () => {
  const [guide, proxy] = await Promise.all([
    read('../apps/dashboard/app/guide/page.tsx'),
    read('../apps/dashboard/proxy.ts'),
  ]);
  for (const marker of [
    "const topics = ['projects', 'source', 'environment', 'deployments', 'resources', 'github', 'administration'] as const",
    '프로젝트 시작', '소스 자동 인식', '환경 변수와 비밀키', 'AI 배포와 수동 배포', '관리형 리소스', 'GitHub 연결', '사용자 승인과 밴',
    '/guide?topic=projects', '/guide?topic=source', '/guide?topic=environment', '/guide?topic=deployments', '/guide?topic=resources', '/guide?topic=github', '/guide?topic=administration',
    '<ConsoleShell active="guide"', 'navItems.map((item)', "aria-current={current ? 'page' : undefined}",
  ]) {
    assert.ok(guide.includes(marker), `${marker} guide marker missing`);
  }
  assert.ok(proxy.includes("pathname === '/guide'"));
});



test('primary dashboard pages expose Korean visible headings', async () => {
  const routes = [
    ['../apps/dashboard/app/console/page.tsx', '내 프로젝트'],
    ['../apps/dashboard/app/admin/page.tsx', '가입 신청 확인'],
    ['../apps/dashboard/app/github/page.tsx', 'GitHub 연결'],
    ['../apps/dashboard/app/contributors/page.tsx', '기여자'],
    ['../apps/dashboard/app/support/page.tsx', '도움이 필요하신가요?'],
    ['../apps/dashboard/app/privacy/page.tsx', '개인정보처리방침'],
    ['../apps/dashboard/app/org/[orgSlug]/projects/page.tsx', '프로젝트'],
    ['../apps/dashboard/app/org/[orgSlug]/projects/new/page.tsx', '프로젝트 만들기'],
    ['../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx', '프로젝트 콘솔'],
    ['../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx', '배포 상세'],
    ['../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx', '리소스 콘솔'],
  ];
  const [files, projectHub] = await Promise.all([
    Promise.all(routes.map(([path]) => read(path))),
    read('../apps/dashboard/components/project-hub/project-hub.tsx'),
  ]);
  for (const [index, [path, heading]] of routes.entries()) {
    if (heading === '프로젝트 콘솔') {
      assert.match(projectHub, /<PageHeader[^>]*title=\{data\.projectName\}/, `dynamic project heading missing from ${path}`);
      continue;
    }
    if (heading === '리소스 콘솔') {
      assert.match(files[index], /<h1[^>]*>\{resource\.name\s*\|\|\s*'리소스 콘솔'\}<\/h1>/, `dynamic resource heading missing from ${path}`);
      continue;
    }
    const visibleHeading = new RegExp(`<h[12][^>]*>\\s*${escapeRegExp(heading)}\\s*</h[12]>`);
    assert.match(files[index], visibleHeading, `${heading} heading missing from ${path}`);
  }
  const combined = files.join('\n');
  for (const label of ['내 프로젝트', '가입 신청 확인', '저장소 연결', '기여자', '도움이 필요하신가요?', '개인정보처리방침', '프로젝트 만들기', '배포 상세', '리소스 콘솔']) {
    assert.ok(combined.includes(label), `${label} visible heading missing`);
  }
});

test('GitHub console keeps integration contracts behind a Korean workflow', async () => {
  const github = await read('../apps/dashboard/app/github/page.tsx');

  assert.ok(github.includes('<ConsoleShell active="github"'));
  assert.doesNotMatch(github, /components\/icon/);
  assert.match(github, /<h1[^>]*>GitHub 연결<\/h1>/);
  for (const heading of ['GitHub App 연결', '저장소 선택', '서비스 연결', '저장소 동기화']) {
    assert.ok(github.includes(`<h2>${heading}</h2>`), `${heading} GitHub section missing`);
  }
  for (const path of ['/github/install', '/github/repositories/import', '`/projects/${firstService.projectId}/services/${firstService.id}/github`', '`/github/repositories/${encodeURIComponent(selectedRepository.fullName)}/sync`']) {
    assert.ok(github.includes(path), `${path} GitHub action path missing`);
  }
  for (const field of ['projectId', 'integrationId', 'repositoryId', 'serviceName', 'branch']) {
    assert.ok(github.includes(`name="${field}"`), `${field} GitHub field missing`);
  }
  for (const identifier of ['selectedRepository.fullName', 'encodeURIComponent(selectedRepository.fullName)', 'integrationId', 'repositoryId', 'repository.private']) {
    assert.ok(github.includes(identifier), `${identifier} GitHub evidence missing`);
  }
  assert.ok(github.includes('`/projects/${firstService.projectId}/services/${firstService.id}/github`'), 'attach action must pair a service with its own project');
  assert.ok(!github.includes('`/projects/${firstProject.id}/services/${firstService.id}/github`'), 'attach action must not cross-pair independent project and service rows');
  assert.ok(github.includes('canAttachRepository ? ('));
  assert.match(github, /<button[^>]*type="submit"[^>]*>연결<\/button>/);
  assert.ok(github.includes('연결할 서비스와 저장소가 필요합니다.'));
  assert.ok(github.includes('canSyncRepository ? ('));
  assert.match(github, /<button[^>]*type="submit"[^>]*>동기화<\/button>/);
  assert.ok(github.includes('동기화할 저장소가 없습니다.'));
  assert.ok(!github.includes("'/projects/project-id/services/service-id/github'"));
  assert.ok(!github.includes("'/github/repositories/owner%2Frepo/sync'"));
  assert.doesNotMatch(github, /name="(?:token|installationId|repoUrl)"/);
  assert.ok(github.includes('계정과 저장소를 GitHub에서 선택합니다.'));
  for (const oldCopy of ['Repository import and preview deployments', 'Connect integration', 'Import repository', 'Attach repository to service', 'Sync repository metadata']) {
    assert.ok(!github.includes(oldCopy), `${oldCopy} old GitHub copy remains`);
  }
});

test('admin console focuses on signup identity review and approval actions', async () => {
  const admin = await read('../apps/dashboard/app/admin/page.tsx');

  assert.ok(admin.includes('<ConsoleShell active="admin"'));
  assert.match(admin, /<h1[^>]*>가입 신청 확인<\/h1>/);
  assert.ok(admin.includes("if (!state.authorized) redirect('/console')"));
  assert.ok(admin.includes('<h2>승인 대기 신청</h2>'));
  for (const action of ['클럽 회원 승인', '일반 사용자 승인', '거절']) {
    assert.match(admin, new RegExp(`>\\s*${action}\\s*<`), `${action} admin action missing`);
  }
  for (const path of ['/approve', '/reject']) {
    assert.ok(admin.includes(path), `${path} admin action path missing`);
  }
  for (const value of ['CLUB_MEMBER', 'NON_CLUB']) {
    assert.ok(admin.includes(`name="accountType" value="${value}"`), `${value} hidden account type missing`);
  }
  for (const evidence of ['user.name', 'user.studentId', 'user.clubMemberClaim', 'user.email', 'state.pendingUsers']) {
    assert.ok(admin.includes(evidence), `${evidence} signup review evidence missing`);
  }
  for (const label of ["ADMIN: '관리자'", "USER: '사용자'", "CLUB_MEMBER: '클럽 회원'", "NON_CLUB: '일반 사용자'"]) {
    assert.ok(admin.includes(label), `${label} admin display label missing`);
  }
  assert.ok(admin.includes('roleLabels[user.role ||'));
  assert.ok(admin.includes('accountTypeLabels[user.accountType]'));
  for (const marker of ['사용자 이용 제한', '/ban', '/unban', 'user.isBanned', '밴 즉시 기존 로그인 세션이 모두 만료됩니다.']) {
    assert.ok(admin.includes(marker), `${marker} user-ban marker missing`);
  }
  assert.doesNotMatch(admin, /<td>\{user\.role\s*\|\|\s*'USER'\}\s*\/\s*\{user\.accountType\}<\/td>/);
  assert.ok(!admin.includes('새 가입은 NON_CLUB / PENDING'));
});

test('login keeps each auth activity focused and uses the same-origin control BFF', async () => {
  const [login, api] = await Promise.all([
    read('../apps/dashboard/app/login/page.tsx'),
    read('../apps/dashboard/lib/api.ts'),
  ]);

  assert.doesNotMatch(login, /dashboardApiContext/);
  for (const endpoint of ['/auth/login', '/auth/signup', '/auth/email/verify', '/auth/email/resend']) {
    assert.ok(login.includes(`apiAction('${endpoint}')`), `${endpoint} same-origin form action missing`);
  }
  assert.ok(api.includes('return `/api/control'));
  assert.doesNotMatch(login, /\/api\/(?:session|control-plane)/);
  for (const field of ['name', 'studentId', 'clubMemberClaim', 'email', 'password', 'code']) {
    assert.ok(login.includes(`name="${field}"`), `${field} auth field missing`);
  }
  assert.ok(!login.includes('name="organizationSlug"'), 'signup should not ask users to create a workspace');
  assert.ok(login.includes("const modes = ['login', 'signup', 'verify'] as const"));
  assert.ok(login.includes("mode === 'login' ? <form"));
  assert.ok(login.includes("mode === 'signup' ? <form"));
  assert.ok(login.includes("mode === 'verify' ? <>"));
  assert.ok(login.includes('관리자 확인을 위해 정확한 정보를 입력해 주세요.'));
  assert.ok(login.includes('name="password" type="password" autoComplete="current-password"'));
  assert.ok(login.includes('name="password" type="password" autoComplete="new-password"'));
  assert.ok(login.includes('name="code" inputMode="numeric" autoComplete="one-time-code"'));
});



test('project operations preserve secret management and AI safety review behavior', async () => {
  const [page, environment, operations] = await Promise.all([
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx'),
    read('../apps/dashboard/components/project-hub/environment.tsx'),
    read('../apps/dashboard/components/project-hub/operations.tsx'),
  ]);
  const source = `${page}\n${environment}\n${operations}`;
  for (const marker of [
    '환경 변수', '.env 텍스트 가져오기', '비밀값으로 암호화하여 저장',
    "view === 'agent'", 'AI 배포 관리자', '/deployment-agent/plan', '/deployment-agent/apply',
    '외부 AI에는 서비스 이름·유형과 위협 코드만 전달합니다.',
  ]) assert.ok(source.includes(marker), `${marker} project operation marker missing`);
});




test('global loading boundary stays session-neutral for public routes', async () => {
  const loading = await read('../apps/dashboard/app/loading.tsx');

  assert.doesNotMatch(loading, /ConsoleShell/);
  assert.doesNotMatch(
    loading,
    /redirect\(|dashboardApiContext|getJson|SESSION_COOKIE/,
  );
  assert.match(loading, /aria-busy="true"/);
});
