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
  assert.ok(card.includes('서비스 {project.services ?? 0}개 · 리소스 {project.resources ?? 0}개'));
  assert.ok(card.includes('콘솔 열기 →'));
  assert.match(card, /<h2>/);
});

test('dashboard CSS keeps KPI surfaces horizontal and compact', async () => {
  const [css, layout] = await Promise.all([
    read('../apps/dashboard/app/globals.css'),
    read('../apps/dashboard/app/layout.tsx'),
  ]);
  for (const token of ['--color-canvas: #0b0e12', '--color-primary: #68df88', '--sidebar: 238px']) {
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
  const responsiveScroller = extractCssBlock(desktopBreakpoint, /\.(?:metric-strip|quick-actions)\s*/);
  assert.match(responsiveScroller, /overflow-x:\s*auto/);

  assert.match(css, /@media\s*\(max-width:\s*900px\)/);
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
    const visibleHeading = new RegExp(`<h[12][^>]*>\\s*${heading}\\s*</h[12]>`);
    assert.match(files[index], visibleHeading, `${heading} heading missing from ${path}`);
  }
  const combined = files.join('\n');
  for (const label of ['운영 현황', '사용자 관리', '저장소 연결', '로그인', '프로젝트 만들기', '배포 상세', '리소스 콘솔']) {
    assert.ok(combined.includes(label), `${label} visible heading missing`);
  }
});
