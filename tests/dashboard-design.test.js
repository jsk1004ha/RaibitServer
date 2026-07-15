import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const read = (path) => fs.readFile(new URL(path, import.meta.url), 'utf8');

const extractCssBlock = (css, startPattern) => {
  const match = startPattern.exec(css);
  assert.ok(match, `${startPattern} CSS block missing`);
  const openBrace = css.indexOf('{', match.index + match[0].length);
  assert.notEqual(openBrace, -1, `${startPattern} opening brace missing`);

  let depth = 0;
  for (let index = openBrace; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return css.slice(openBrace + 1, index);
  }
  assert.fail(`${startPattern} closing brace missing`);
};

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
    ['../apps/dashboard/app/page.tsx', 'overview'],
    ['../apps/dashboard/app/admin/page.tsx', 'admin'],
    ['../apps/dashboard/app/github/page.tsx', 'github'],
    ['../apps/dashboard/app/login/page.tsx', 'auth'],
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
  assert.match(shell, /type\s+NavItemId\s*=\s*'overview'\s*\|\s*'projects'\s*\|\s*'create-project'\s*\|\s*'github'\s*\|\s*'admin'\s*\|\s*'auth'/);
  assert.match(shell, /active\?:\s*NavItemId/);
  assert.match(shell, /id:\s*NavItemId/);
  for (const [id, label, href, icon] of [
    ['overview', '개요', '/', 'squares-2x2'],
    ['projects', '프로젝트', '/org/default/projects', 'folder'],
    ['create-project', '프로젝트 만들기', '/org/default/projects/new', 'plus'],
    ['github', 'GitHub 연결', '/github', 'arrow-top-right-on-square'],
    ['admin', '관리자', '/admin', 'user-group'],
    ['auth', '로그인', '/login', 'shield-check'],
  ]) {
    assert.ok(shell.includes(`id: '${id}'`), `${id} navigation id missing`);
    assert.ok(shell.includes(`label: '${label}'`), `${label} navigation label missing`);
    assert.ok(shell.includes(`href: '${href}'`), `${href} navigation href missing`);
    assert.ok(shell.includes(`icon: '${icon}'`), `${icon} navigation icon missing`);
  }
  assert.match(shell, /active\s*=\s*'overview'/);
  assert.match(shell, /active\s*===\s*item\.id/);
  assert.match(shell, /<Icon\s+name=\{item\.icon\}/);
  assert.equal(shell.match(/aria-current=\{active === item\.id \? 'page' : undefined\}/g)?.length, 2);
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

test('project cards render compact Korean console rows', async () => {
  const card = await read('../apps/dashboard/components/project-card.tsx');

  assert.match(card, /import\s+\{\s*Icon\s*\}\s+from\s+'\.\/icon'/);
  assert.match(card, /className="project-row-card"/);
  assert.match(card, /<Icon\s+name="folder"/);
  assert.ok(card.includes('서비스 {project.services ?? project.serviceCount ?? 0}개 · 리소스 {project.resources ?? project.resourceCount ?? 0}개'));
  assert.ok(card.includes('콘솔 열기 →'));
  assert.match(card, /<h2>/);
});

test('overview prioritizes compact Korean operations data and four quick actions', async () => {
  const home = await read('../apps/dashboard/app/page.tsx');

  assert.match(home, /import\s+\{\s*ConsoleShell,\s*MetricStrip,\s*StatusBadge\s*\}\s+from\s+'\.\.\/components\/console-ui'/);
  assert.doesNotMatch(home, /\bMetricCard\b/);
  assert.ok(home.includes('crumbs={`${createOrgSlug} / 운영 현황`}'));
  assert.match(home, /<h1\s+className="page-title">운영 현황<\/h1>/);
  assert.ok(home.includes('프로젝트, 배포, 관리형 리소스 상태를 확인하세요.'));
  assert.match(home, /<MetricStrip\s+items=\{\[/);
  for (const marker of [
    "label: '운영 중인 프로젝트'",
    "detail: '제어 영역 기준'",
    'progress: Math.min(projects.length * 10, 100)',
    "label: 'GitHub 연결'",
    "detail: '설치 및 저장소'",
    "tone: 'info'",
    "label: '사용량 기록'",
    "detail: '현재 할당량'",
    "tone: 'warn'",
  ]) {
    assert.ok(home.includes(marker), `${marker} overview metric missing`);
  }
  assert.equal(home.match(/className="quick-action"/g)?.length, 4);
  for (const label of ['새 프로젝트', 'GitHub 연결', '로그인', 'API 상태']) {
    assert.ok(home.includes(label), `${label} quick action missing`);
  }
  for (const apiMarker of ['loadDashboardOverview', "apiAction('/health')", 'state.context.baseUrl', 'state.health.error', 'user?.email', 'subject?.id']) {
    assert.ok(home.includes(apiMarker), `${apiMarker} live data marker missing`);
  }
  for (const oldCopy of ['API connection', 'Project consoles', 'Console routes', 'Create project', 'No projects returned', 'PRODUCT CONSOLE']) {
    assert.ok(!home.includes(oldCopy), `${oldCopy} old visible copy remains`);
  }
});

test('project list is a compact Korean row-card view scoped to its organization', async () => {
  const projects = await read('../apps/dashboard/app/org/[orgSlug]/projects/page.tsx');

  assert.ok(projects.includes('<ConsoleShell active="projects"'));
  assert.ok(projects.includes('crumbs={`${orgSlug} / 프로젝트`}'));
  assert.match(projects, /<h1\s+className="page-title">프로젝트<\/h1>/);
  assert.ok(projects.includes('프로젝트 만들기'));
  assert.ok(projects.includes('첫 프로젝트 만들기'));
  assert.match(projects, /<ProjectCard\s+key=\{project\.id\}/);
  assert.ok(projects.includes('href={`/org/${orgSlug}/projects/${project.id}`}'));
  assert.ok(projects.includes('href={`/org/${orgSlug}/projects/new`}'));
  for (const marker of ['loadDashboardOverview()', 'project.organizationSlug', 'project.organizationId', "orgSlug === 'all'"]) {
    assert.ok(projects.includes(marker), `${marker} project data marker missing`);
  }
  for (const oldCopy of ['Workspace', 'Create project', 'projects</h1>', 'No projects returned']) {
    assert.ok(!projects.includes(oldCopy), `${oldCopy} old visible copy remains`);
  }
});

test('project workflows keep their operational contracts behind a Korean console surface', async () => {
  const [createProject, projectDetail] = await Promise.all([
    read('../apps/dashboard/app/org/[orgSlug]/projects/new/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx'),
  ]);

  for (const marker of [
    '프로젝트 만들기', '1 소스', '2 서비스', '3 리소스', '프로젝트 이름', '조직',
    '저장소 URL', '브랜치', 'Dockerfile 경로', '빌드 컨텍스트', '서비스 유형',
    '데이터베이스', '캐시', '생성될 원하는 상태', '할당량 미리보기',
  ]) {
    assert.ok(createProject.includes(marker), `${marker} create-project marker missing`);
  }
  assert.ok(createProject.includes('<ConsoleShell active="create-project"'));
  assert.match(createProject, /<form\s+method="post"\s+action=\{apiAction\('\/projects'\)\}/);
  for (const name of ['name', 'slug', 'repoUrl', 'branch', 'sourceType', 'image', 'dockerfilePath', 'buildContext', 'type', 'database', 'cache']) {
    assert.ok(createProject.includes(`name="${name}"`), `${name} create-project field missing`);
  }
  for (const contract of [
    'value={orgSlug}', 'defaultValue="github"', 'value="github"', 'value="image"',
    'defaultValue="web"', 'value="web"', 'value="worker"', 'value="cron"', 'value="job"',
  ]) {
    assert.ok(createProject.includes(contract), `${contract} create-project value/default missing`);
  }
  for (const oldCopy of ['>Create project<', '>1 Source<', '>2 Service<', '>3 Resource<', '>POST /projects<']) {
    assert.ok(!createProject.includes(oldCopy), `${oldCopy} old visible create-project copy remains`);
  }

  for (const marker of [
    '프로젝트 콘솔', '새 서비스', '배포', '개요', '서비스', '리소스', '도메인',
    '환경 변수', '감사', '설정', '서비스 만들기', 'Dockerfile 우선', '서비스와 배포',
    '운영 환경에 배포', '미리보기 만들기', '배포 내역', '미리보기 배포',
    '리소스 추가', '관리형 리소스', '위험 영역', '감사 로그 필수', '빌드 로그',
    '배포 이벤트', '런타임 로그', '상세 화면에서 불러오기',
  ]) {
    assert.ok(projectDetail.includes(marker), `${marker} project-detail marker missing`);
  }
  assert.match(projectDetail, /import\s+\{\s*ConsoleShell,\s*MetricStrip,\s*StatusBadge\s*\}/);
  assert.doesNotMatch(projectDetail, /\bMetricCard\b/);
  assert.match(projectDetail, /<MetricStrip\s+items=\{\[/);
  for (const metric of ["label: '서비스'", "label: '리소스'", "label: '배포'", 'state.services.length', 'state.resources.length', 'state.deployments.length', 'state.previewDeployments.length']) {
    assert.ok(projectDetail.includes(metric), `${metric} project metric missing`);
  }

  for (const action of [
    'apiAction(`/projects/${projectId}/services`, state.context)',
    'apiAction(`/projects/${projectId}/resources`, state.context)',
    'apiAction(`/projects/${projectId}/services/${service.id}/deployments`, state.context)',
  ]) {
    assert.ok(projectDetail.includes(action), `${action} project form action missing`);
  }
  assert.ok(projectDetail.includes('<input type="hidden" name="deploymentType" value="production" />'));
  assert.ok(projectDetail.includes('<input type="hidden" name="deploymentType" value="preview" />'));
  assert.ok(projectDetail.includes('href={`/org/${orgSlug}/projects/${projectId}/deployments/${deployment.id}`}'));
  assert.ok(projectDetail.includes('href={`/org/${orgSlug}/projects/${projectId}/resources/${resource.id}/console`}'));
  for (const name of ['name', 'type', 'sourceType', 'repoUrl', 'branch', 'imageUrl', 'dockerfilePath', 'buildContext', 'engine']) {
    assert.ok(projectDetail.includes(`name="${name}"`), `${name} project-detail field missing`);
  }
  for (const deferred of ['loadProjectConsole(projectId)', 'state.resources.map', '/console/query', '/console/schema']) {
    assert.ok(projectDetail.includes(deferred), `${deferred} deferred project data marker missing`);
  }
  for (const eagerData of ['state.resourceConsoles', 'state.buildLogs', 'state.deploymentEvents', 'state.runtimeLogs', 'Promise.all(']) {
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
  assert.ok(projects.includes('crumbs={`${orgSlug} / 프로젝트`}'));

  assert.match(createProject, /params:\s*Promise<\{\s*orgSlug:\s*string\s*\}>/);
  assert.ok(createProject.includes('const { orgSlug } = await params;'));
  assert.ok(createProject.includes('orgValue={orgSlug}'));
  assert.ok(createProject.includes('crumbs={`${orgSlug} / 프로젝트 만들기`}'));

  assert.match(projectDetail, /params:\s*Promise<\{\s*orgSlug:\s*string;\s*projectId:\s*string\s*\}>/);
  assert.ok(projectDetail.includes('const { orgSlug, projectId } = await params;'));
  assert.ok(projectDetail.includes('orgValue={orgSlug}'));
  assert.ok(projectDetail.includes('crumbs={`${orgSlug} / ${projectName} / 개요`}'));

  for (const [path, source] of [
    ['projects', projects],
    ['projects/new', createProject],
    ['projects/[projectId]', projectDetail],
  ]) {
    assert.doesNotMatch(source, /params\.(?:orgSlug|projectId)/, `${path} reads unresolved params`);
    assert.doesNotMatch(source, /crumbs=\{`[^`]*undefined/, `${path} can render undefined crumbs`);
  }
});

test('project workflow controls derive tenant scope server-side and expose accessible labels without inert buttons', async () => {
  const [createProject, projectDetail] = await Promise.all([
    read('../apps/dashboard/app/org/[orgSlug]/projects/new/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx'),
  ]);

  assert.ok(createProject.includes('<label>조직 <input value={orgSlug} readOnly aria-describedby="organization-scope-note" /></label>'));
  assert.ok(createProject.includes('실제 조직 권한은 로그인한 계정에서 확인합니다.'));
  assert.doesNotMatch(createProject, /<input[^>]*name="organizationId"/);
  assert.match(createProject, /<ol\s+className="tabs"[^>]*>/);
  assert.doesNotMatch(createProject, /<button[^>]*className="tab/);

  assert.match(projectDetail, /<ol\s+className="tabs"[^>]*>/);
  assert.doesNotMatch(projectDetail, /<button[^>]*className="tab/);
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
  assert.ok(deployment.includes('const { orgSlug, projectId, deploymentId } = await params;'));
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
    '배포 상세', '상태와 이미지', '빌드 로그', '배포 이벤트', '롤백 확인', '배포 취소',
    '프로젝트 콘솔', '롤백', '상태는 빌더와 오케스트레이터가 자동으로 갱신합니다.', 'detail.errorCode', 'detail.errorMessage',
  ]) {
    assert.ok(deployment.includes(marker), `${marker} deployment marker missing`);
  }
  for (const field of ['imageUrl', 'reason']) {
    assert.ok(deployment.includes(`name="${field}"`), `${field} deployment field missing`);
  }
  assert.ok(!deployment.includes('apiAction(`/deployments/${deploymentId}/status`, context)'), 'tenant dashboard must not expose the system-owned status mutation');
  for (const field of ['status', 'imageDigest', 'errorMessage']) assert.ok(!deployment.includes(`name="${field}"`), `${field} system-owned field must be read-only`);
  assert.ok(deployment.includes('최근 이벤트'));
  assert.doesNotMatch(deployment, />실시간</);
  assert.ok(deployment.includes('id="rollback-deployment"'));
  assert.match(deployment, /import\s+\{\s*ConsoleShell,\s*LogViewer,\s*MetricCard,\s*StatusBadge\s*\}/);
  assert.doesNotMatch(deployment, /<button[^>]*type="button"[^>]*>(?:Copy|Download)<\/button>/);
});

test('resource console awaits route params and links localized tabs to real operational sections', async () => {
  const resource = await read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx');

  assert.match(resource, /params:\s*Promise<\{\s*orgSlug:\s*string;\s*projectId:\s*string;\s*resourceId:\s*string\s*\}>/);
  assert.ok(resource.includes('const { orgSlug, projectId, resourceId } = await params;'));
  assert.doesNotMatch(resource, /params\.(?:orgSlug|projectId|resourceId)/);
  assert.ok(resource.includes('loadResourceConsole(resourceId)'));
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
    ['스키마', '#schema'], ['쿼리', '#query'], ['백업', '#backups'], ['연결', '#connection'],
  ]) {
    assert.ok(resource.includes(`href="${target}"`), `${target} resource tab target missing`);
    assert.ok(resource.includes(`>${label}</a>`), `${label} resource tab label missing`);
    assert.ok(resource.includes(`id="${target.slice(1)}"`), `${target} resource section missing`);
  }
  assert.doesNotMatch(resource, /<button[^>]*className="tab/);
  for (const marker of [
    '리소스 콘솔', '자격 증명 교체', '쿼리 실행', '공급자 명령 실행',
    '프로비저닝 계획 만들기', '서비스에 연결', 'provider-owned-secret',
  ]) {
    assert.ok(resource.includes(marker), `${marker} resource marker missing`);
  }
  for (const field of ['query', 'command', 'confirmed', 'dryRun', 'serviceId', 'envPrefix']) {
    assert.ok(resource.includes(`name="${field}"`), `${field} resource field missing`);
  }
  assert.equal(resource.match(/name="confirmed"/g)?.length, 2);

  const credentialAction = resource.match(/<button[^>]*>자격 증명 교체<\/button>/)?.[0];
  assert.ok(credentialAction, 'credential rotation action missing');
  assert.match(credentialAction, /type="button"/);
  assert.match(credentialAction, /\sdisabled(?:\s|>)/);
  assert.match(credentialAction, /aria-describedby="credential-rotation-note"/);
  assert.doesNotMatch(credentialAction, /type="submit"|form="provider-command"/);
  assert.ok(resource.includes('id="credential-rotation-note"'));
  assert.ok(resource.includes('공급자 교체 API 준비 중'));
  assert.match(resource, /id="provider-command"[\s\S]*?<button type="submit">공급자 명령 실행<\/button>/);

  const backupSection = resource.match(/<section className="card" id="backups">[\s\S]*?<\/section>/)?.[0];
  assert.ok(backupSection, 'independent backup empty state missing');
  assert.ok(backupSection.includes('백업 API 준비 중'));
  assert.doesNotMatch(backupSection, /\/provision|apiAction\(/);
  assert.doesNotMatch(resource, /<form[^>]*id="backups"/);
  assert.match(resource, /<form id="provisioning"[^>]*action=\{apiAction\(`\/resources\/\$\{resourceId\}\/provision`/);
  assert.ok(resource.includes('<h2>프로비저닝 계획</h2>'));
});

test('dashboard two-column layouts align independent panels to the top', async () => {
  const css = await read('../apps/dashboard/app/globals.css');
  const dashboardGrid = extractCssBlock(css, /^\.dashboard-grid\s*(?=\{)/m);

  assert.match(dashboardGrid, /align-items:\s*start/);
});

test('dashboard CSS keeps KPI surfaces horizontal and compact', async () => {
  const [css, layout] = await Promise.all([
    read('../apps/dashboard/app/globals.css'),
    read('../apps/dashboard/app/layout.tsx'),
  ]);
  for (const token of ['--color-canvas: #0b0e12', '--color-primary: #68df88', '--color-control-border: #65717d', '--sidebar: 238px']) {
    assert.ok(css.includes(token), `${token} token missing`);
  }
  assert.match(css, /\.metric-strip\s*\{/);
  assert.match(css, /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(150px,\s*1fr\)\)/);
  assert.match(css, /min-height:\s*78px/);
  assert.match(css, /@media\s*\(max-width:\s*1180px\)/);
  assert.match(css, /overflow-x:\s*auto/);

  const metricStrip = extractCssBlock(css, /\.metric-strip\s*/);
  assert.match(metricStrip, /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(150px,\s*1fr\)\)/);
  assert.match(metricStrip, /min-height:\s*78px/);

  const finalMetric = extractCssBlock(css, /\.metric-item:last-child\s*/);
  assert.match(finalMetric, /border-right:\s*(?:0|none)/);

  const metricLabel = extractCssBlock(css, /\.metric-label\s*/);
  assert.match(metricLabel, /white-space:\s*nowrap/);
  assert.match(metricLabel, /overflow:\s*hidden/);
  assert.match(metricLabel, /text-overflow:\s*ellipsis/);

  const desktopBreakpoint = extractCssBlock(css, /@media\s*\(max-width:\s*1180px\)\s*/);
  const responsiveScroller = extractCssBlock(desktopBreakpoint, /\.metric-strip\s*/);
  assert.match(responsiveScroller, /display:\s*flex/);
  assert.match(responsiveScroller, /overflow-x:\s*auto/);
  const responsiveMetric = extractCssBlock(desktopBreakpoint, /\.metric-item\s*/);
  assert.match(responsiveMetric, /flex:\s*1\s+0\s+150px/);

  assert.match(css, /@media\s*\(max-width:\s*900px\)/);
  const tabletBreakpoint = extractCssBlock(css, /@media\s*\(max-width:\s*900px\)\s*/);
  const tabletNavigation = extractCssBlock(tabletBreakpoint, /\.mobile-nav\s*/);
  assert.match(tabletNavigation, /position:\s*static/);
  assert.doesNotMatch(css, /\.mobile-nav\s*\{[^}]*\btop\s*:/gs);
  const mobileBreakpoint = extractCssBlock(css, /@media\s*\(max-width:\s*720px\)\s*/);
  const mobileMetrics = extractCssBlock(mobileBreakpoint, /\.metric-strip\s*/);
  assert.match(mobileMetrics, /display:\s*flex/);
  assert.match(mobileMetrics, /overflow-x:\s*auto/);
  assert.match(mobileMetrics, /scroll-snap-type:\s*x\s+proximity/);
  assert.match(mobileBreakpoint, /scroll-snap-align:\s*start/);

  const focusVisible = extractCssBlock(css, /:focus-visible\s*/);
  assert.match(focusVisible, /outline:\s*2px\s+solid\s+var\(--color-primary\)/);
  assert.match(focusVisible, /outline-offset:\s*2px/);

  const icon = extractCssBlock(css, /\.icon\s*/);
  assert.match(icon, /width:\s*18px/);
  assert.match(icon, /height:\s*18px/);
  assert.match(icon, /flex:\s*0\s+0\s+auto/);

  const reducedMotion = extractCssBlock(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*/);
  assert.match(reducedMotion, /scroll-behavior:\s*auto\s*!important/);
  assert.match(reducedMotion, /transition-duration:\s*0\.01ms\s*!important/);
  assert.match(reducedMotion, /animation-duration:\s*0\.01ms\s*!important/);

  assert.match(css, /button\[type="submit"\]:not\(\.btn\)/);
  assert.doesNotMatch(css, /button:not\(\.btn\)/);
  const textInputSelector = /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="submit"\]\):not\(\[type="hidden"\]\)/;
  assert.match(css, textInputSelector);

  const neutralControls = extractCssBlock(css, /\.btn,\s*button\[type="submit"\]:not\(\.btn\)\s*/);
  assert.match(neutralControls, /border:\s*1px\s+solid\s+var\(--color-control-border\)/);
  const textControls = extractCssBlock(
    css,
    new RegExp(`^\\.input,[\\s\\S]*?${textInputSelector.source},\\s*select,`, 'm'),
  );
  assert.match(textControls, /border:\s*1px\s+solid\s+var\(--color-control-border\)/);
  const quickAction = extractCssBlock(css, /^\.quick-action\s*(?=\{)/m);
  assert.match(quickAction, /border:\s*1px\s+solid\s+var\(--color-control-border\)/);
  const panel = extractCssBlock(css, /^\.card\s*(?=\{)/m);
  assert.match(panel, /border:\s*1px\s+solid\s+var\(--color-border\)/);

  assert.ok(
    layout.includes("description: '클럽, 학교, 소규모 팀을 위한 컨테이너 기반 PaaS 및 DBaaS.'"),
    'Korean metadata description missing',
  );
});

test('primary dashboard pages expose Korean visible headings', async () => {
  const routes = [
    ['../apps/dashboard/app/page.tsx', '운영 현황'],
    ['../apps/dashboard/app/admin/page.tsx', '사용자 관리'],
    ['../apps/dashboard/app/github/page.tsx', '저장소 연결과 미리보기 배포'],
    ['../apps/dashboard/app/login/page.tsx', '로그인'],
    ['../apps/dashboard/app/org/[orgSlug]/projects/page.tsx', '프로젝트'],
    ['../apps/dashboard/app/org/[orgSlug]/projects/new/page.tsx', '프로젝트 만들기'],
    ['../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx', '프로젝트 콘솔'],
    ['../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx', '배포 상세'],
    ['../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx', '리소스 콘솔'],
  ];
  const files = await Promise.all(routes.map(([path]) => read(path)));
  for (const [index, [path, heading]] of routes.entries()) {
    if (heading === '프로젝트 콘솔') {
      assert.match(files[index], /<p\s+className="eyebrow">프로젝트 콘솔<\/p>/, `프로젝트 콘솔 route label missing from ${path}`);
      assert.match(files[index], /<h1\s+className="page-title">\{projectName\}<\/h1>/, `dynamic project heading missing from ${path}`);
      continue;
    }
    const visibleHeading = new RegExp(`<h[12][^>]*>\\s*${heading}\\s*</h[12]>`);
    assert.match(files[index], visibleHeading, `${heading} heading missing from ${path}`);
  }
  const combined = files.join('\n');
  for (const label of ['운영 현황', '사용자 관리', '저장소 연결', '로그인', '프로젝트 만들기', '배포 상세', '리소스 콘솔']) {
    assert.ok(combined.includes(label), `${label} visible heading missing`);
  }
});

test('GitHub console keeps integration contracts behind a compact Korean workflow', async () => {
  const github = await read('../apps/dashboard/app/github/page.tsx');

  assert.ok(github.includes('<ConsoleShell active="github"'));
  assert.match(github, /import\s+\{\s*Icon\s*\}\s+from\s+'\.\.\/\.\.\/components\/icon'/);
  assert.match(github, /<h1\s+className="page-title">저장소 연결과 미리보기 배포<\/h1>/);
  for (const heading of ['GitHub 연결', '저장소 가져오기', '서비스에 저장소 연결', '저장소 정보 동기화']) {
    assert.ok(github.includes(`<h2>${heading}</h2>`), `${heading} GitHub section missing`);
  }
  for (const path of ['/integrations/github', '/github/repositories/import', '/projects/:projectId/services/:serviceId/github', '/github/repositories/:repositoryId/sync']) {
    assert.ok(github.includes(path), `${path} GitHub action path missing`);
  }
  for (const field of ['projectId', 'integrationId', 'repositoryId', 'serviceName', 'branch']) {
    assert.ok(github.includes(`name="${field}"`), `${field} GitHub field missing`);
  }
  for (const identifier of ['firstRepository.fullName', 'encodeURIComponent(firstRepository.fullName)', 'x-github-event', 'x-github-delivery', 'x-hub-signature-256', '웹훅 / 미리보기 계약']) {
    assert.ok(github.includes(identifier), `${identifier} GitHub evidence missing`);
  }
  assert.ok(github.includes('`/projects/${firstService.projectId}/services/${firstService.id}/github`'), 'attach action must pair a service with its own project');
  assert.ok(!github.includes('`/projects/${firstProject.id}/services/${firstService.id}/github`'), 'attach action must not cross-pair independent project and service rows');
  assert.ok(github.includes('action={canAttachRepository ? apiAction('));
  assert.ok(github.includes(': undefined} className="card stack"'));
  assert.ok(github.includes('<fieldset className="stack" disabled={!canAttachRepository}>'));
  assert.ok(github.includes('<button type="submit" disabled={!canAttachRepository}>서비스에 연결</button>'));
  assert.ok(github.includes('연결할 서비스가 없습니다. 먼저 프로젝트에 서비스를 만드세요.'));
  assert.ok(github.includes('action={canSyncRepository ? apiAction('));
  assert.ok(github.includes('<fieldset className="stack" disabled={!canSyncRepository}>'));
  assert.ok(github.includes('<button type="submit" disabled={!canSyncRepository}>정보 동기화</button>'));
  assert.ok(github.includes('동기화할 저장소가 없습니다. 먼저 저장소를 가져오세요.'));
  assert.ok(!github.includes("'/projects/project-id/services/service-id/github'"));
  assert.ok(!github.includes("'/github/repositories/owner%2Frepo/sync'"));
  assert.doesNotMatch(github, /name="(?:token|installationId|repoUrl)"/);
  assert.ok(github.includes('GitHub App callback이 조직 소유권을 검증'));
  assert.doesNotMatch(github, /(?:minHeight|height):\s*['"]?\d/);
  for (const oldCopy of ['Repository import and preview deployments', 'Connect integration', 'Import repository', 'Attach repository to service', 'Sync repository metadata']) {
    assert.ok(!github.includes(oldCopy), `${oldCopy} old GitHub copy remains`);
  }
});

test('admin console preserves approval, quota, and audit actions with explicit Korean controls', async () => {
  const admin = await read('../apps/dashboard/app/admin/page.tsx');

  assert.ok(admin.includes('<ConsoleShell active="admin"'));
  assert.match(admin, /<h1\s+className="page-title">사용자 관리<\/h1>/);
  for (const heading of ['사용자', '할당량 편집', '거절 확인']) {
    assert.ok(admin.includes(`<h2>${heading}</h2>`), `${heading} admin section missing`);
  }
  for (const action of ['클럽 회원으로 승인', '일반 사용자로 승인', '거절', '할당량 저장']) {
    assert.match(admin, new RegExp(`>\\s*${action}\\s*<`), `${action} admin action missing`);
  }
  for (const path of ['/approve', '/reject', '/quota']) {
    assert.ok(admin.includes(path), `${path} admin action path missing`);
  }
  for (const value of ['CLUB_MEMBER', 'NON_CLUB']) {
    assert.ok(admin.includes(`name="accountType" value="${value}"`), `${value} hidden account type missing`);
  }
  for (const field of ['maxProjects', 'maxServices']) {
    assert.ok(admin.includes(`name="${field}"`), `${field} quota field missing`);
  }
  assert.match(admin, /className="inline-actions danger-zone"/);
  assert.match(admin, /<label>프로젝트 수\s*<input\s+name="maxProjects"/);
  assert.match(admin, /<label>서비스 수\s*<input\s+name="maxServices"/);
  for (const evidence of ['state.quotas', 'state.usage', 'state.auditLogs']) {
    assert.ok(admin.includes(evidence), `${evidence} admin evidence missing`);
  }
  for (const label of ["ADMIN: '관리자'", "USER: '사용자'", "CLUB_MEMBER: '클럽 회원'", "NON_CLUB: '일반 사용자'"]) {
    assert.ok(admin.includes(label), `${label} admin display label missing`);
  }
  assert.ok(admin.includes('roleLabels[user.role ||'));
  assert.ok(admin.includes('accountTypeLabels[user.accountType]'));
  assert.doesNotMatch(admin, /<td>\{user\.role\s*\|\|\s*'USER'\}\s*\/\s*\{user\.accountType\}<\/td>/);
  assert.ok(!admin.includes('새 가입은 NON_CLUB / PENDING'));
});

test('login console keeps same-origin auth endpoints and explains verification before approval', async () => {
  const login = await read('../apps/dashboard/app/login/page.tsx');

  assert.ok(login.includes('<ConsoleShell active="auth"'));
  assert.match(login, /import\s+\{\s*ConsoleShell\s*\}\s+from\s+'\.\.\/\.\.\/components\/console-ui'/);
  assert.doesNotMatch(login, /dashboardApiContext/);
  for (const endpoint of ['/auth/login', '/auth/signup', '/auth/email/verify', '/auth/email/resend', '/auth/github/login', '/auth/github/callback']) {
    assert.ok(login.includes(`apiAction('${endpoint}')`), `${endpoint} must keep same-origin apiAction`);
  }
  for (const heading of ['로그인', '가입 신청', '이메일 인증', '인증 코드 다시 보내기', 'GitHub 연결']) {
    assert.match(login, new RegExp(`<h[12][^>]*>\\s*${heading}\\s*</h[12]>`), `${heading} login heading missing`);
  }
  assert.match(login, />\s*GitHub로 계속하기\s*</);
  for (const field of ['email', 'password', 'organizationSlug', 'code', 'githubId', 'login']) {
    assert.ok(login.includes(`name="${field}"`), `${field} auth field missing`);
  }
  assert.ok(login.includes('name="localDev" type="hidden" value="1"'));
  assert.ok(login.includes('인증 코드를 확인한 뒤에만 계정이 만들어집니다.'));
  assert.ok(login.includes('관리자 승인 결과가 계정의 사용 가능 기능을 결정합니다.'));
  assert.ok(login.includes("const githubLoginEndpoint = apiAction('/auth/github/login');"));
  assert.ok(login.includes("const githubCallbackEndpoint = apiAction('/auth/github/callback');"));
  assert.doesNotMatch(login, /href=\{(?:githubLoginEndpoint|apiAction\('\/auth\/github\/login'\))/);
  assert.doesNotMatch(login, /<form[^>]+(?:githubCallbackEndpoint|auth\/github\/callback)/s);
  assert.ok(login.includes('<button className="btn btn-primary" type="button" disabled aria-describedby="github-oauth-status">GitHub로 계속하기</button>'));
  assert.ok(login.includes('id="github-oauth-status"'));
  assert.ok(login.includes('GitHub OAuth 연결은 준비 중입니다.'));
  assert.ok(login.includes('<fieldset disabled>'));
  assert.ok(login.includes('<button type="button" disabled>GitHub 연결</button>'));
  assert.ok(login.includes('현재 API는 OAuth 계획과 연결 대기 상태만 제공합니다.'));
  assert.ok(login.includes('name="password" type="password" autoComplete="current-password"'));
  assert.ok(login.includes('name="password" type="password" autoComplete="new-password"'));
  assert.ok(login.includes('name="code" inputMode="numeric" autoComplete="one-time-code"'));
  assert.match(login, /className="grid grid-2 grid-start"/);
  assert.doesNotMatch(login, /<main\s+className="hero"/);
});

test('Task 8 form grids opt out of card stretching without changing the shared grid', async () => {
  const [css, github, login] = await Promise.all([
    read('../apps/dashboard/app/globals.css'),
    read('../apps/dashboard/app/github/page.tsx'),
    read('../apps/dashboard/app/login/page.tsx'),
  ]);

  const gridStart = extractCssBlock(css, /^\.grid-start\s*(?=\{)/m);
  assert.match(gridStart, /align-items:\s*start/);
  const gridTwo = extractCssBlock(css, /^\.grid-2\s*(?=\{)/m);
  assert.doesNotMatch(gridTwo, /align-items/);
  assert.match(github, /className="grid grid-2 grid-start"/);
  assert.match(login, /className="grid grid-2 grid-start"/);
});

test('disabled Task 8 controls look inactive and reset only disabled card fieldsets', async () => {
  const css = await read('../apps/dashboard/app/globals.css');

  const disabledButton = extractCssBlock(css, /^button:disabled,\s*\ninput\[type="submit"\]:disabled\s*(?=\{)/m);
  const opacity = Number(/opacity:\s*([\d.]+)/.exec(disabledButton)?.[1]);
  assert.ok(opacity > 0 && opacity < 1, 'disabled button opacity must be below 1');
  assert.match(disabledButton, /cursor:\s*not-allowed/);
  assert.match(disabledButton, /filter:\s*saturate\([\d.]+\)/);

  const disabledPrimary = extractCssBlock(css, /^\.btn-primary:disabled,\s*\nbutton\[type="submit"\]:not\(\.btn\):disabled,\s*\ninput\[type="submit"\]:disabled\s*(?=\{)/m);
  assert.match(disabledPrimary, /border-color:\s*var\(--color-control-border\)/);
  assert.match(disabledPrimary, /background:\s*var\(--color-surface-strong\)/);
  assert.match(disabledPrimary, /color:\s*var\(--color-text-muted\)/);
  assert.doesNotMatch(disabledPrimary, /var\(--color-primary\)/);

  const disabledHover = extractCssBlock(css, /^button:disabled:hover,\s*\ninput\[type="submit"\]:disabled:hover\s*(?=\{)/m);
  assert.match(disabledHover, /transform:\s*none/);
  assert.match(disabledHover, /background:\s*var\(--color-surface-strong\)/);

  const disabledFieldset = extractCssBlock(css, /^\.card fieldset:disabled,\s*\n\.stack > fieldset:disabled\s*(?=\{)/m);
  for (const reset of [/margin:\s*0/, /padding:\s*0/, /border:\s*0/, /min-width:\s*0/]) {
    assert.match(disabledFieldset, reset);
  }
  assert.doesNotMatch(css, /^fieldset\s*(?=\{)/m, 'general fieldsets must remain unchanged');
});
