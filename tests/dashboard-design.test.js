import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const read = (path) => fs.readFile(new URL(path, import.meta.url), 'utf8');

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
});

test('primary dashboard pages expose Korean visible headings', async () => {
  const files = await Promise.all([
    read('../apps/dashboard/app/page.tsx'),
    read('../apps/dashboard/app/admin/page.tsx'),
    read('../apps/dashboard/app/github/page.tsx'),
    read('../apps/dashboard/app/login/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/new/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx'),
  ]);
  const combined = files.join('\n');
  for (const label of ['운영 현황', '사용자 관리', '저장소 연결', '로그인', '프로젝트 만들기', '배포 상세', '리소스 콘솔']) {
    assert.ok(combined.includes(label), `${label} visible heading missing`);
  }
});
