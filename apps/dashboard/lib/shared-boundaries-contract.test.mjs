import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appDirectory = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, appDirectory), 'utf8');

test('shared document and chrome keep the public accessibility and theme contract', async () => {
  const [layout, themeMenu, header, footer, pageHeader, actionNavigation, sectionNavigation] = await Promise.all([
    read('app/layout.tsx'),
    read('components/theme-menu.tsx'),
    read('components/public-header.tsx'),
    read('components/public-footer.tsx'),
    read('components/page-header.tsx'),
    read('components/action-navigation.tsx'),
    read('components/section-navigation.tsx'),
  ]);

  assert.match(layout, /export const dynamic = 'force-dynamic'/);
  assert.match(layout, /lang="ko"/);
  assert.match(layout, /normalizeThemePreference\(requestCookies\.get\(THEME_COOKIE_NAME\)/);
  assert.match(layout, /data-theme=\{theme\}/);
  assert.match(layout, /href="#main-content"/);
  assert.match(layout, /<nav\s+aria-label="바로가기">/);
  assert.doesNotMatch(layout, /<div\s+id="main-content"/);
  assert.doesNotMatch(layout, /<main/);
  for (const source of [header, footer]) assert.match(source, /import\s+\{\s*Brand\s*\}/);
  for (const source of [layout, header, footer, pageHeader, actionNavigation, sectionNavigation]) assert.doesNotMatch(source, /['"]use client['"]/);
  assert.match(themeMenu, /^['"]use client['"]/);
  assert.match(themeMenu, /DropdownMenuRadioGroup/);
  assert.match(themeMenu, /aria-label=\{accessibleLabel\}/);
  assert.doesNotMatch(themeMenu, /nextThemePreference|data-theme-toggle/);
});

test('Given public chrome and the home hero When theme-aware responsive markup renders Then every link, action, and Korean copy contract remains deliberate', async () => {
  const [layout, header, home] = await Promise.all([
    read('app/layout.tsx'),
    read('components/public-header.tsx'),
    read('app/page.tsx'),
  ]);

  assert.match(header, /import\s+\{\s*ThemeMenu\s*\}\s+from\s+['"]\.\/theme-menu['"]/);
  assert.equal((header.match(/<ThemeMenu/g) ?? []).length, 1);
  assert.doesNotMatch(header, /['"]use client['"]/);
  assert.doesNotMatch(layout, /ThemeToggle|ThemeMenu/);
  assert.match(header, /flex-col[\s\S]*sm:flex-row/);
  assert.match(header, /w-full[\s\S]*sm:w-auto/);
  assert.match(header, /href: '\/status', label: '운영 현황'/);
  assert.match(header, /href: '\/support', label: '지원'/);
  assert.match(header, /aria-label="공개 화면 탐색"/);
  assert.match(home, /href=\{loginUrl\}[\s\S]{0,120}>\s*로그인/);
  assert.match(home, /href=\{consoleUrl\}[\s\S]{0,120}>\s*콘솔 들어가기/);
  assert.match(home, /href=\{consoleUrl\}[\s\S]{0,120}>\s*콘솔 시작하기/);
  assert.match(home, /href=\{signupUrl\}[\s\S]{0,120}>\s*가입 신청/);
  assert.match(home, /max-w-\[12ch\] break-keep \[overflow-wrap:anywhere\]/);
  assert.match(home, /만들고, 올리고, 운영하세요\./);
  assert.match(home, /text-pretty break-keep \[overflow-wrap:anywhere\]/);
  assert.match(home, /인천과학고등학교의 최고 정보 동아리 라이빗의 호스팅 서비스입니다\./);
});

test('loading and error boundaries expose neutral, sanitized recovery states', async () => {
  const [loading, routeError, globalError, notFound, screen, catalog, preview] = await Promise.all([
    read('app/loading.tsx'),
    read('app/error.tsx'),
    read('app/global-error.tsx'),
    read('app/not-found.tsx'),
    read('components/error-screen.tsx'),
    read('app/errors/page.tsx'),
    read('app/errors/[code]/page.tsx'),
  ]);

  assert.match(loading, /<main\s+id="main-content"\s+aria-busy="true"/);
  assert.equal((loading.match(/<main/g) ?? []).length, 1);
  assert.equal((loading.match(/<h1/g) ?? []).length, 1);
  assert.match(loading, /aria-live="polite"/);
  assert.match(loading, /aria-busy="true"/);
  assert.doesNotMatch(loading, /ConsoleShell|dashboardApiContext|getJson|SESSION_COOKIE|redirect\(/);
  for (const source of [routeError, globalError]) {
    assert.match(source, /normalizePublicIdentifier\(error\.digest\)/);
    assert.match(source, /reset/);
    assert.match(source, /다시 시도하기/);
  }
  assert.match(routeError, /role="alert"/);
  assert.match(globalError, /<html\s+lang="ko"/);
  assert.match(globalError, /<head>\s*<title>오류가 발생했습니다 · RAIBIT SERVER<\/title>\s*<\/head>/);
  assert.match(globalError, /<body/);
  assert.match(globalError, /import '\.\/globals\.css'/);
  assert.match(globalError, /data-theme="system"/);
  assert.match(notFound, /찾을 수 없습니다/);
  for (const source of [routeError, globalError, notFound, preview]) assert.match(source, /<ErrorScreen/);
  assert.match(screen, /<main\s+id="main-content"/);
  assert.equal((screen.match(/<main/g) ?? []).length, 1);
  assert.equal((screen.match(/<h1/g) ?? []).length, 1);
  assert.match(screen, /aria-live=\{isAlert \? 'assertive' : undefined\}/);
  assert.match(screen, /<dt>요청 경로<\/dt>/);
  assert.match(screen, /<dt>오류 식별자<\/dt>/);
  assert.match(catalog, /CLIENT_ERROR_STATUS_CODES/);
  assert.match(catalog, /SERVER_ERROR_STATUS_CODES/);
  assert.match(catalog, /<main\s+id="main-content"/);
  assert.match(preview, /notFound\(\)/);
  for (const source of [notFound, screen, catalog, preview]) assert.doesNotMatch(source, /['"]use client['"]/);
});

test('E2E-only fixture routes are inert without the explicit local environment and request host', async () => {
  const [layout, access, policy, fixtureLayout, loading, routeError, globalError, arm, primitiveFixture, browserSpec, dashboardFixtures, browserContracts, fixtureServer] = await Promise.all([
    read('app/layout.tsx'),
    read('app/errors/fixtures/fixture-access.ts'),
    read('lib/e2e-fixture-policy.js'),
    read('app/errors/fixtures/layout.tsx'),
    read('app/errors/fixtures/loading/page.tsx'),
    read('app/errors/fixtures/route-error/page.tsx'),
    read('app/errors/fixtures/global-error/page.tsx'),
    read('app/errors/fixtures/global-error/arm/route.ts'),
    read('app/primitives-fixture/page.tsx'),
    read('tests/e2e/specs/error-boundaries.spec.ts'),
    read('tests/e2e/helpers/fixtures.ts'),
    read('tests/e2e/helpers/contracts.ts'),
    read('tests/e2e/fixture/serve.mjs'),
  ]);

  for (const name of ['RAIBITSERVER_E2E_FIXTURES', 'RAIBITSERVER_BASE_DOMAIN', 'RAIBITSERVER_DASHBOARD_ORIGIN']) {
    assert.match(policy, new RegExp(name));
  }
  assert.match(layout, /e2eFixturesEnabled\(process\.env, requestHeaders\.get\('host'\)\)/);
  assert.match(access, /e2eFixturesEnabled\(process\.env, requestHeaders\.get\('host'\)\)/);
  assert.match(access, /notFound\(\)/);
  assert.match(fixtureLayout, /dynamic = 'force-dynamic'/);
  assert.match(loading, /new Promise\(\(\) => undefined\)/);
  assert.match(routeError, /assertE2eFixturesEnabled/);
  assert.match(primitiveFixture, /assertE2eFixturesEnabled/);
  assert.match(primitiveFixture, /errors\/fixtures\/fixture-access/);
  assert.match(primitiveFixture, /dynamic = "force-dynamic"/);
  assert.match(routeError, /T6_E2E_SECRET_SHOULD_NOT_RENDER/);
  assert.match(globalError, /redirect\('\/errors\/fixtures\/global-error\/arm'\)/);
  assert.match(arm, /const globalErrorFixturePath = '\/errors\/fixtures\/global-error'/);
  assert.match(arm, /path:\s*globalErrorFixturePath/);
  assert.match(layout, /T6_E2E_GLOBAL_ERROR/);
  assert.match(browserSpec, /RAIBITSERVER_E2E_FIXTURES=1/);
  assert.match(browserSpec, /\{\s*userPage\s*\}/);
  assert.match(dashboardFixtures, /installSession\(context, 'fixture-user-populated'\)/);
  assert.match(browserContracts, /name: 'raibitserver_session'/);
  assert.match(browserContracts, /domain: 'console\.localhost'/);
  assert.match(browserContracts, /export const DASHBOARD_ORIGIN = 'http:\/\/console\.localhost:3410'/);
  assert.match(browserSpec, /t6-errors-404/);
  assert.match(browserSpec, /t6-global-error/);
  assert.match(browserSpec, /public and auth skip links focus their sole main target/);
  assert.match(browserSpec, /page\.keyboard\.press\('Tab'\)/);
  assert.match(browserSpec, /new URL\(page\.url\(\)\)\.hash/);
  assert.match(fixtureServer, /RAIBITSERVER_CONSOLE_URL: 'http:\/\/console\.localhost:3410\/console'/);
  assert.match(fixtureServer, /RAIBITSERVER_BASE_DOMAIN: 'localhost'/);
  assert.match(browserSpec, /const PUBLIC_HOME_URL = 'http:\/\/localhost:3410\/'/);
  assert.match(browserSpec, /const CONSOLE_LOGIN_URL = `\$\{DASHBOARD_ORIGIN\}\/login`/);
  assert.match(browserSpec, /browser\.newContext\(\)/);
  assert.match(browserSpec, /waitUntil: 'networkidle'/);
  assert.match(browserSpec, /requestAnimationFrame/);
});

test('representative T6-T14 pages have one main landmark without a generic duplicate target', async () => {
  const publicPaths = [
    'app/page.tsx',
    'app/login/page.tsx',
    'app/status/page.tsx',
    'app/support/page.tsx',
    'app/contributors/page.tsx',
    'app/privacy/page.tsx',
  ];
  const consolePaths = [
    'app/console/page.tsx',
    'app/org/[orgSlug]/projects/page.tsx',
    'app/org/[orgSlug]/projects/[projectId]/page.tsx',
  ];
  const [publicSources, consoleSources, consoleShell] = await Promise.all([
    Promise.all(publicPaths.map(read)),
    Promise.all(consolePaths.map(read)),
    read('components/console-ui.tsx'),
  ]);

  for (const source of publicSources) {
    assert.equal((source.match(/<main/g) ?? []).length, 1);
    assert.equal((source.match(/id="main-content"/g) ?? []).length, 1);
  }
  for (const source of consoleSources) assert.equal((source.match(/<main/g) ?? []).length, 0);
  assert.equal((consoleShell.match(/<main/g) ?? []).length, 1);
  assert.equal((consoleShell.match(/id="main-content"/g) ?? []).length, 1);
});

test('React error surfaces remain independent from hosted HTML rendering', async () => {
  const reactSources = await Promise.all([
    read('app/error.tsx'),
    read('app/global-error.tsx'),
    read('app/not-found.tsx'),
    read('app/errors/page.tsx'),
    read('app/errors/[code]/page.tsx'),
    read('components/error-screen.tsx'),
  ]);

  for (const source of reactSources) assert.doesNotMatch(source, /renderHostedErrorHtml|api\/hosted-error/);
});
