import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

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
  const [shell, login, project, deployment, resource, github] = await Promise.all([
    read('../apps/dashboard/components/console-ui.tsx'),
    read('../apps/dashboard/app/login/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx'),
    read('../apps/dashboard/app/github/page.tsx'),
  ]);
  assert.match(shell, /method="post"\s+action=\{apiAction\('\/auth\/logout'\)\}[\s\S]*?name="_returnTo"\s+value="\/login"/);
  for (const marker of [
    'name="_returnTo" type="hidden" value={next}',
    'name="_returnTo" type="hidden" value="/login?mode=verify"',
  ]) assert.ok(login.includes(marker), `${marker} auth return target missing`);
  for (const marker of [
    'name="_returnTo" value={`${base}?view=services`}', 'name="deploymentType" value="production"',
    'name="deploymentType" value="preview"', 'name="_method" value="PATCH"', 'name="_method" value="DELETE"',
    'name="_returnTo" value={`/org/${orgSlug}/projects`}', 'name="_confirmProject"',
  ]) assert.ok(project.includes(marker), `${marker} project mutation contract missing`);
  assert.match(deployment, /apiAction\(`\/deployments\/\$\{deploymentId\}\/rollback`[\s\S]*?name="_returnTo" value=\{`\$\{base\}\?view=overview`\}[\s\S]*?name="confirmed" value="true" required/);
  for (const marker of [
    'name="_returnTo" value={`${base}?view=query`}', 'name="_returnTo" value={`${base}?view=provider`}',
    'name="confirmed" value="true"', 'name="dryRun" value="true"', 'name="serviceId"', 'name="envPrefix"',
  ]) assert.ok(resource.includes(marker), `${marker} resource mutation contract missing`);
  for (const marker of [
    'name="_returnTo" value="/github?step=attach"', 'name="_returnTo" value="/github?step=sync"',
    'selectedRepository.fullName', 'encodeURIComponent(selectedRepository.fullName)',
  ]) assert.ok(github.includes(marker), `${marker} GitHub mutation contract missing`);
});

test('dashboard shell is Korean-first and uses typed Heroicons', async () => {
  const [shell, icons] = await Promise.all([
    read('../apps/dashboard/components/console-ui.tsx'),
    read('../apps/dashboard/components/icon.tsx'),
  ]);

  for (const label of ['개요', '프로젝트', '프로젝트 만들기', 'GitHub 연결', '관리자', '로그인']) {
    assert.ok(shell.includes(label), `${label} navigation label missing`);
  }
  for (const icon of ['squares-2x2', 'folder', 'rocket-launch', 'circle-stack', 'command-line', 'cog-6-tooth', 'magnifying-glass', 'bell', 'plus', 'server-stack']) {
    assert.ok(icons.includes(`'${icon}'`), `${icon} Heroicon missing`);
  }
  assert.match(icons, /type\s+IconName\s*=/);
  assert.match(icons, /export\s+type\s+(?:IconName\s*=|\{\s*IconName\s*\})/);
  assert.match(icons, /const\s+iconPaths:\s*Record<IconName,\s*readonly\s+string\[\]>\s*=\s*\{/);
  assert.match(icons, /iconPaths\[name\]\.map\(/);
  for (const signature of [
    "'squares-2x2': ['M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z']",
    "'rocket-launch': ['M15.59 14.37a6 6 0 0 1-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 0 0 6.16-12.12A14.98 14.98 0 0 0 9.631 8.41",
  ]) {
    assert.ok(icons.includes(signature), `${signature} official Heroicon path missing`);
  }
  assert.match(icons, /viewBox="0 0 24 24"/);
  assert.match(icons, /strokeWidth=\{1\.5\}/);
  assert.doesNotMatch(shell, />Dashboard</);
  assert.doesNotMatch(shell, />Create project</);
});

test('shared dashboard primitives keep localized deterministic contracts', async () => {
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

  assert.match(shell, /import\s+\{\s*Icon\s*\}\s+from\s+'\.\/icon'/);
  assert.match(shell, /import\s+type\s+\{\s*IconName\s*\}\s+from\s+'\.\/icon'/);
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
  assert.match(shell, /<Icon\s+name=\{item\.icon\}/);
  assert.match(shell, /const\s+current\s*=\s*active\s*===\s*item\.id[\s\S]*aria-current=\{current \? 'page' : undefined\}/);
  for (const [index, [path, active]] of callerContracts.entries()) {
    assert.ok(callers[index].includes(`<ConsoleShell active="${active}"`), `${path} must use active id ${active}`);
  }

  assert.match(shell, /export\s+function\s+MetricStrip/);
  assert.match(shell, /title=\{item\.label\}/);
  for (const contract of ['metric-strip', '주요 지표', 'metric-item', 'metric-label', 'metric-value', 'metric-detail', 'metric-meter']) {
    assert.ok(shell.includes(contract), `${contract} metric contract missing`);
  }
  assert.match(shell, /Math\.min\(100,\s*Math\.max\(0,/);
  assert.match(shell, /Number\.isFinite\(/);
  assert.match(shell, /Number\.isFinite\(item\.progress\)\s*\?/);

  for (const [status, label] of [
    ['active', '활성'], ['ready', '준비됨'], ['healthy', '정상'], ['running', '실행 중'],
    ['pending', '대기 중'], ['queued', '대기열'], ['building', '빌드 중'], ['failed', '실패'],
    ['rejected', '거절됨'], ['blocked', '차단됨'], ['offline', '오프라인'],
  ]) {
    assert.ok(shell.includes(`${status}: '${label}'`), `${status} localized status missing`);
  }
  assert.match(shell, /data-status=\{text\}/);
  assert.match(shell, /<i\s*\/>/);
  assert.ok(shell.includes("empty = '표시할 로그가 없습니다.'"));
  assert.ok(shell.includes("row.createdAt || row.timestamp || '이벤트'"));
  assert.ok(shell.includes("row.level || row.type || '정보'"));
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

  assert.match(card, /import\s+\{\s*Icon\s*\}\s+from\s+'\.\/icon'/);
  assert.match(card, /<Icon\s+name="folder"/);
  assert.ok(card.includes('서비스 {project.services ?? project.serviceCount ?? 0}개 · 리소스 {project.resources ?? project.resourceCount ?? 0}개'));
  assert.ok(card.includes('콘솔 열기 →'));
  assert.match(card, /<h2>/);
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

  assert.ok(home.includes("String(query.variant || 'editorial')"));
  assert.ok(home.includes('landing-variant-${variant}'));
  assert.ok(home.includes('<h1 id="landing-title">만들고,<br />올리고,<br />운영하세요.</h1>'));
  assert.ok(home.includes('인천과학고등학교의 최고 정보 동아리 라이빗의 호스팅 서비스입니다.'));
  assert.ok(home.includes('loadPublicSites(5)'));
  assert.ok(home.includes('운영 중인 사이트'));
  assert.ok(home.includes('LIVE'));
  assert.ok(home.includes('href="/status"'));
  assert.ok(home.includes('상태 보기 →'));
  assert.ok(status.includes('loadSystemStatus()'));
  assert.ok(status.includes('RAIBIT SERVER 상태'));
  assert.ok(status.includes('<SystemStatusPanel initialStatus={status} />'));
  assert.doesNotMatch(status, /loadPublicSites|public-site-list/);
  for (const marker of ["'use client'", "fetch('/api/status'", 'window.setInterval', 'visibilitychange', '초 자동 갱신', '배포 버전', 'snapshot.deployment.commitUrl', 'GitHub 커밋', "aria-label={refreshing ? '상태 확인 중' : '상태 새로고침'}", '<svg', 'status-refresh-icon']) {
    assert.ok(statusPanel.includes(marker), `${marker} status UI contract missing`);
  }
  for (const marker of ['웹 콘솔', '제어 서버', '데이터 저장소']) assert.ok(statusModel.includes(marker), `${marker} status model missing`);
  for (const marker of ['commitSha', 'shortCommitSha', 'https://github.com/']) assert.ok(statusModel.includes(marker), `${marker} deployment version contract missing`);
  assert.ok(statusRoute.includes('loadSystemStatus()'));
  assert.ok(statusRoute.includes("'cache-control': 'no-store, max-age=0'"));
  assert.ok(home.includes('콘솔 시작하기'));
  assert.ok(home.includes('/login?mode=signup'));
  assert.ok(home.includes('<PublicFooter />'));
  assert.ok(contributors.includes('<h1 id="contributors-title">기여자</h1>'));
  assert.ok(contributors.includes('2309'));
  assert.ok(contributors.includes('김준서'));
  assert.ok(contributors.includes('RAIBIT SERVER 개발'));
  assert.ok(contributors.includes('teacher'));
  assert.ok(contributors.includes('최희진'));
  assert.ok(contributors.includes('서버컴퓨터와 도메인 구매'));
  assert.ok(contributors.includes('contributor-card-featured'));
  assert.ok(contributors.includes('contributor-crown'));
  assert.ok(contributors.includes('contributor-sparkles'));
  assert.ok(contributors.indexOf('최희진') < contributors.indexOf('김준서'));
  assert.ok(contributors.includes('<PublicFooter />'));
  assert.ok(support.includes('<h1 id="support-title">도움이 필요하신가요?</h1>'));
  assert.ok(support.includes('ishsraibit@gmail.com'));
  assert.ok(support.includes('GitHub Issues ↗'));
  assert.ok(privacy.includes('<h1>개인정보처리방침</h1>'));
  assert.ok(privacy.includes('이름, 학번, 라이빗 동아리원 여부, 이메일, 비밀번호 해시'));
  assert.ok(privacy.includes('raibitserver_session'));
  assert.ok(privacy.includes('ishsraibit@gmail.com'));
  assert.ok(footer.includes('href="/support"'));
  assert.ok(footer.includes('href="/status"'));
  assert.ok(footer.includes('System Status'));
  assert.ok(footer.includes('https://github.com/jsk1004ha/RaibitServer'));
  assert.ok(footer.includes('href="/contributors"'));
  assert.ok(footer.includes('href="/privacy"'));
  assert.ok(footer.includes('Privacy Policy'));
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
  for (const marker of ['loadDashboardOverview()', 'project.organizationSlug', 'project.organizationId', "orgSlug === 'all'", '.filter((project: any)']) {
    assert.ok(projects.includes(marker), `${marker} project data marker missing`);
  }
  for (const oldCopy of ['Workspace', 'Create project', 'projects</h1>', 'No projects returned']) {
    assert.ok(!projects.includes(oldCopy), `${oldCopy} old visible copy remains`);
  }
});

test('project workflows keep their operational contracts behind a Korean console surface', async () => {
  const [createProject, wizard, projectDetail] = await Promise.all([
    read('../apps/dashboard/app/org/[orgSlug]/projects/new/page.tsx'),
    read('../apps/dashboard/components/project-create-wizard.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx'),
  ]);
  const createSource = `${createProject}\n${wizard}`;

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
    '현황', '서비스', '배포', '리소스', '로그', '설정',
    '서비스 만들기', '운영 배포', '미리보기', '배포 내역',
    '리소스 추가', '관리형 리소스', '프로젝트 삭제',
    '런타임 로그', 'SectionNav', "view === 'services'", "view === 'deployments'", "view === 'resources'",
  ]) {
    assert.ok(projectDetail.includes(marker), `${marker} project-detail marker missing`);
  }
  assert.match(projectDetail, /import\s+\{\s*ConsoleShell,\s*LoadErrorSummary,\s*LogViewer,\s*MetricStrip,\s*SectionNav,\s*StatusBadge\s*\}/);
  assert.doesNotMatch(projectDetail, /\bMetricCard\b/);
  assert.match(projectDetail, /<MetricStrip\s+items=\{\[/);
  for (const metric of ["label: '서비스'", "label: '리소스'", "label: '배포'", 'state.services.length', 'state.resources.length', 'state.deployments.length', 'state.previewDeployments.length']) {
    assert.ok(projectDetail.includes(metric), `${metric} project metric missing`);
  }

  for (const action of [
    'apiAction(`/projects/${projectId}/services`, state.context)',
    'apiAction(`/projects/${projectId}/resources`, state.context)',
    'apiAction(`/projects/${projectId}/services/${service.id}/deployments`, state.context)',
    'apiAction(`/services/${serviceSettings.id}`, state.context)',
    'apiAction(`/projects/${projectId}`, state.context)',
  ]) {
    assert.ok(projectDetail.includes(action), `${action} project form action missing`);
  }
  assert.ok(projectDetail.includes('<input type="hidden" name="_method" value="PATCH" />'));
  assert.ok(projectDetail.includes('<input type="hidden" name="_method" value="DELETE" />'));
  assert.ok(projectDetail.includes('name="_confirmProject"'));
  assert.ok(projectDetail.includes('설정 저장'));
  assert.ok(projectDetail.includes('프로젝트 삭제'));
  assert.ok(projectDetail.includes('<input type="hidden" name="deploymentType" value="production" />'));
  assert.ok(projectDetail.includes('<input type="hidden" name="deploymentType" value="preview" />'));
  assert.ok(projectDetail.includes('href={`${base}/deployments/${deployment.id}`}'));
  assert.ok(projectDetail.includes('href={`${base}/resources/${resource.id}/console`}'));
  for (const name of ['name', 'type', 'sourceType', 'repoUrl', 'branch', 'imageUrl', 'dockerfilePath', 'buildContext', 'engine']) {
    assert.ok(projectDetail.includes(`name="${name}"`), `${name} project-detail field missing`);
  }
  for (const deferred of ['loadProjectConsole(projectId)', 'state.resources.map']) {
    assert.ok(projectDetail.includes(deferred), `${deferred} deferred project data marker missing`);
  }
  for (const eagerData of ['state.resourceConsoles', 'state.buildLogs', 'state.deploymentEvents', 'state.runtimeLogs']) {
    assert.ok(!projectDetail.includes(eagerData), `${eagerData} eager detail loading must remain absent`);
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
  assert.ok(projects.includes('const { orgSlug } = await params;'));
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

  assert.ok(wizard.includes('<label>조직 <input value={orgSlug} readOnly aria-describedby="organization-scope-note" /></label>'));
  assert.ok(wizard.includes('로그인 권한으로 확인'));
  assert.doesNotMatch(wizard, /<input[^>]*name="organizationId"/);
  assert.match(wizard, /<ol[^>]*>/);
  assert.ok(wizard.includes('hidden={step !== 0}'));
  assert.ok(wizard.includes('hidden={step !== 3}'));
  assert.ok(wizard.includes('disabled={index > step}'));

  assert.ok(projectDetail.includes("<SectionNav items={navItems} current={view === 'edit-service' ? 'services' : view}"));
  for (const field of [
    '<label>서비스 이름 <input name="name"',
    '<label>서비스 유형 <select name="type"',
    '<label>소스 유형 <select name="sourceType"',
    '<label>저장소 URL <input name="repoUrl"',
    '<label>브랜치 <input name="branch"',
    '<label>이미지 <input name="imageUrl"',
    '<label>Dockerfile 경로 <input name="dockerfilePath"',
    '<label>빌드 컨텍스트 <input name="buildContext"',
    '<label>리소스 이름 <input name="name"',
    '<label>엔진 <select name="engine"',
  ]) {
    assert.ok(projectDetail.includes(field), `${field} explicit label missing`);
  }
  for (const option of [
    '<option value="web">웹</option>', '<option value="private">비공개 서비스</option>',
    '<option value="worker">워커</option>', '<option value="cron">예약 작업</option>',
    '<option value="job">일회성 작업</option>', '<option value="object-storage">객체 저장소</option>',
  ]) {
    assert.ok(projectDetail.includes(option), `${option} localized enum label missing`);
  }
});

test('deployment detail awaits route params and keeps operational controls on a compact Korean surface', async () => {
  const deployment = await read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx');

  assert.match(deployment, /params:\s*Promise<\{\s*orgSlug:\s*string;\s*projectId:\s*string;\s*deploymentId:\s*string\s*\}>/);
  assert.ok(deployment.includes('const [{ orgSlug, projectId, deploymentId }, query] = await Promise.all([params, searchParams]);'));
  assert.doesNotMatch(deployment, /params\.(?:orgSlug|projectId|deploymentId)/);
  assert.match(deployment, /await\s+Promise\.all\(\[/);
  for (const apiMarker of [
    'dashboardApiContext()',
    'getJson(`/deployments/${encodeURIComponent(deploymentId)}`',
    'getJson(`/deployments/${encodeURIComponent(deploymentId)}/logs`',
    'getJson(`/deployments/${encodeURIComponent(deploymentId)}/events`',
    'apiAction(`/deployments/${deploymentId}/rollback`, context)',
    'apiAction(`/deployments/${deploymentId}/cancel`, context)',
  ]) {
    assert.ok(deployment.includes(apiMarker), `${apiMarker} deployment operation missing`);
  }
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
  assert.match(deployment, /import\s+\{\s*ConsoleShell,\s*LoadErrorSummary,\s*LogViewer,\s*MetricStrip,\s*SectionNav,\s*StatusBadge\s*\}/);
  assert.doesNotMatch(deployment, /<button[^>]*type="button"[^>]*>(?:Copy|Download)<\/button>/);
});

test('resource console awaits route params and links localized tabs to real operational sections', async () => {
  const resource = await read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx');

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
    '계획 만들기', '서비스에 연결', 'provider-owned-secret',
  ]) {
    assert.ok(resource.includes(marker), `${marker} resource marker missing`);
  }
  for (const field of ['query', 'command', 'confirmed', 'dryRun', 'serviceId', 'envPrefix']) {
    assert.ok(resource.includes(`name="${field}"`), `${field} resource field missing`);
  }
  assert.equal(resource.match(/name="confirmed"/g)?.length, 2);

  assert.match(resource, /id="provider-command"[\s\S]*?<button[^>]*type="submit"[^>]*>공급자 명령 실행<\/button>/);

  const backupSection = resource.match(/\{view === 'backups' \? <section[\s\S]*?<\/section> : null\}/)?.[0];
  assert.ok(backupSection, 'independent backup empty state missing');
  assert.ok(backupSection.includes('복구 지점 준비 중'));
  assert.doesNotMatch(backupSection, /\/provision|apiAction\(/);
  assert.doesNotMatch(resource, /<form[^>]*id="backups"/);
  assert.match(resource, /<form id="provisioning"[^>]*action=\{apiAction\(`\/resources\/\$\{resourceId\}\/provision`/);
  assert.ok(resource.includes('<h2>프로비저닝</h2>'));
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
    '<ConsoleShell active="guide"', '<SectionNav items={navItems} current={topic}',
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
  const files = await Promise.all(routes.map(([path]) => read(path)));
  for (const [index, [path, heading]] of routes.entries()) {
    if (heading === '프로젝트 콘솔') {
      assert.match(files[index], /<h1[^>]*>\{projectName\}<\/h1>/, `dynamic project heading missing from ${path}`);
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
  const page = await read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx');
  for (const marker of [
    '환경 변수', '.env 텍스트 가져오기', '비밀값으로 암호화하여 저장',
    "id: 'agent'", 'AI 배포 관리자', '/deployment-agent/plan', '/deployment-agent/apply',
    '외부 AI에는 서비스 이름·유형과 위협 코드만 전달합니다.',
  ]) assert.ok(page.includes(marker), `${marker} project operation marker missing`);
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
