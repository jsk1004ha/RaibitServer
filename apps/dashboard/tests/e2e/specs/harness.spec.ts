import { test, expect } from '../helpers/fixtures';
import { captureScreenshot, expectAccessible, expectRoute, FIXTURE_ORIGIN, installSession, nativeFormData, observeBrowserErrors, VIEWPORT_MATRIX } from '../helpers/contracts';

test('@harness real login preserves exact native FormData and reaches console', async ({ page, request }, testInfo) => {
  const assertNoErrors = observeBrowserErrors(page);
  await page.goto('/login?next=%2Fconsole');
  await page.getByLabel('이메일').fill('user@fixture.test');
  await page.getByLabel('비밀번호').fill('fixture-user-pass');
  expect(await nativeFormData(page, 'form.auth-form')).toEqual([['_returnTo', '/console'], ['email', 'user@fixture.test'], ['password', 'fixture-user-pass']]);
  await page.getByRole('button', { name: '콘솔에 로그인' }).click();
  await expectRoute(page, '/console', { notice: 'saved' });
  await expect(page.getByRole('heading', { name: '내 프로젝트' })).toBeVisible();
  const csp = await page.request.get('http://127.0.0.1:3410/console', { headers: { host: 'console.localhost:3410', cookie: 'raibitserver_session=fixture-user-populated' } });
  expect(csp.headers()['content-security-policy']).toContain("default-src 'self'");
  const fixtureLog = await request.get(`${FIXTURE_ORIGIN}/__fixture/requests`);
  const requests = (await fixtureLog.json()).requests;
  expect(requests.some((entry: { path: string; body: Record<string, string> }) => entry.path === '/api/auth/login' && entry.body.password === '[MASKED]')).toBeTruthy();
  await expectAccessible(page);
  await captureScreenshot(page, testInfo, 'happy-login-console');
  assertNoErrors();
});

test('@harness invalid credentials and upstream failure are sanitized', async ({ page }, testInfo) => {
  const assertNoErrors = observeBrowserErrors(page, [401, 500]);
  await page.goto('/login?next=%2Flogin');
  await page.getByLabel('이메일').fill('user@fixture.test');
  await page.getByLabel('비밀번호').fill('wrong-password-not-secret');
  await page.getByRole('button', { name: '콘솔에 로그인' }).click();
  await expectRoute(page, '/login', { error: 'invalid_credentials' });
  await expect(page.locator('.auth-message[role="alert"]')).toContainText('이메일 또는 비밀번호');
  await expect(page.locator('body')).not.toContainText('wrong-password-not-secret');
  await page.goto('/login?next=%2Flogin');
  await page.getByLabel('이메일').fill('failure@fixture.test');
  await page.getByLabel('비밀번호').fill('upstream-input-must-not-reflect');
  await page.getByRole('button', { name: '콘솔에 로그인' }).click();
  await expectRoute(page, '/login', { error: 'fixture_upstream_secret_must_not_escape' });
  await expect(page.locator('.auth-message[role="alert"]')).toHaveText('요청을 처리하지 못했습니다. 입력 내용을 확인해 주세요.');
  await expect(page.locator('body')).not.toContainText(/fixture_upstream_secret|upstream-input/);
  await captureScreenshot(page, testInfo, 'failure-sanitized-login');
  assertNoErrors();
});

test('@harness reusable role and deterministic state contexts enforce contracts', async ({ browser, userPage, adminPage }) => {
  for (const [page, path, heading] of [[userPage, '/console', '내 프로젝트'], [adminPage, '/admin', '가입 신청 확인']] as const) {
    const assertNoErrors = observeBrowserErrors(page);
    await page.goto(path); await expect(page.getByRole('heading', { name: heading })).toBeVisible(); assertNoErrors();
  }
  const userAdmin = await userPage.goto('/admin'); expect(userAdmin?.url()).toContain('/console');
  for (const [token, text] of [['fixture-user-empty', '아직 프로젝트가 없습니다.'], ['fixture-user-partial', '결정적 운영 프로젝트'], ['fixture-user-long', '배포 로그가 길어져도']] as const) {
    const context = await browser.newContext(); await installSession(context, token); const page = await context.newPage();
    const assertNoErrors = observeBrowserErrors(page, token.includes('partial') ? [500] : []); await page.goto('/console'); await expect(page.locator('body')).toContainText(text); assertNoErrors(); await context.close();
  }
  const expired = await browser.newContext(); await installSession(expired, 'fixture-expired'); const expiredPage = await expired.newPage(); await expiredPage.goto('/console'); await expectRoute(expiredPage, '/login', { error: 'session_expired' }); await expired.close();
});

test('@harness seeded project, deployment, resource, GitHub, status and viewport matrix are stable', async ({ userPage }, testInfo) => {
  for (const viewport of VIEWPORT_MATRIX) { await userPage.setViewportSize(viewport); await userPage.goto('/console'); await expect(userPage.getByText('결정적 운영 프로젝트')).toBeVisible(); }
  await userPage.goto('/org/raibit/projects/prj_fixture_001?view=deployments'); await expect(userPage.getByText('sha256:fixture0001')).toBeVisible();
  await userPage.goto('/org/raibit/projects/prj_fixture_001?view=resources'); await expect(userPage.getByText('primary-postgres')).toBeVisible();
  await userPage.goto('/github'); await expect(userPage.locator('body')).toContainText(/raibit-fixture|fixture-app/);
  await userPage.goto('/status'); await expect(userPage.getByRole('heading', { name: '모든 시스템 정상' })).toBeVisible();
  await captureScreenshot(userPage, testInfo, 'status-seeded');
});
