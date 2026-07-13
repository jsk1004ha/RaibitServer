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

  for (const label of ['개요', '프로젝트', '배포', '리소스', '콘솔', 'GitHub 연결', '관리자']) {
    assert.ok(shell.includes(label), `${label} navigation label missing`);
  }
  for (const icon of ['squares-2x2', 'folder', 'rocket-launch', 'circle-stack', 'command-line', 'cog-6-tooth', 'magnifying-glass', 'bell', 'plus', 'server-stack']) {
    assert.ok(icons.includes(`'${icon}'`), `${icon} Heroicon missing`);
  }
  assert.match(icons, /export\s+type\s+IconName\s*=/);
  assert.match(icons, /const\s+iconPaths:\s*Record<IconName,\s*readonly\s+string\[\]>\s*=\s*\{/);
  assert.match(icons, /iconPaths\[name\]\.map\(/);
  for (const signature of [
    "'squares-2x2': ['M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25",
    "'rocket-launch': ['M15.59 14.37a6 6 0 0 1-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 0 0 6.16-12.12A14.98 14.98 0 0 0 9.631 8.41",
  ]) {
    assert.ok(icons.includes(signature), `${signature} official Heroicon path missing`);
  }
  assert.match(icons, /viewBox="0 0 24 24"/);
  assert.match(icons, /strokeWidth=\{1\.5\}/);
  assert.doesNotMatch(shell, />Dashboard</);
  assert.doesNotMatch(shell, />Create project</);
});

test('dashboard CSS keeps KPI surfaces horizontal and compact', async () => {
  const css = await read('../apps/dashboard/app/globals.css');
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

  const desktopBreakpoint = extractCssBlock(css, /@media\s*\(max-width:\s*1180px\)\s*/);
  const responsiveScroller = extractCssBlock(desktopBreakpoint, /\.(?:metric-strip|quick-actions)\s*/);
  assert.match(responsiveScroller, /overflow-x:\s*auto/);
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
