import { test, expect } from '../helpers/fixtures';
import { DASHBOARD_ORIGIN, expectAccessible, installSession, nativeFormData } from '../helpers/contracts';

test('@t14 GitHub seeded and empty workflows keep deterministic step routes and native mutation data', async ({ browser, userPage }) => {
  await userPage.setViewportSize({ width: 375, height: 812 });
  await userPage.goto('/github?step=connect');
  await expect(userPage.getByRole('heading', { name: 'GitHub App 연결', exact: true })).toBeVisible();
  await expect(userPage.getByRole('link', { name: '다른 계정 연결' })).toHaveAttribute('href', '/github/install');

  await userPage.goto('/github?step=import');
  const importSelector = 'form[action*="/github/repositories/import"]';
  const importData = [
    ['_returnTo', '/github?step=attach'],
    ['integrationId', 'ghi_fixture'],
    ['repositoryId', 'repo_fixture'],
    ['projectId', 'prj_fixture_001'],
    ['serviceName', ''],
  ] as const;
  expect(await nativeFormData(userPage, importSelector)).toEqual(importData);
  const importRequestPromise = userPage.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/control/github/repositories/import');
  await userPage.getByRole('button', { name: '가져오기' }).click();
  const importRequest = await importRequestPromise;
  expect([...new URLSearchParams(importRequest.postData() || '').entries()]).toEqual(importData);
  await expect(userPage).toHaveURL(/\/github\?step=attach&notice=saved$/);

  const attachSelector = 'form[action*="/projects/prj_fixture_001/services/svc_fixture_web/github"]';
  const attachData = [
    ['_returnTo', '/github?step=sync'],
    ['integrationId', 'ghi_fixture'],
    ['repositoryId', 'repo_fixture'],
    ['branch', 'main'],
  ] as const;
  expect(await nativeFormData(userPage, attachSelector)).toEqual(attachData);
  const attachRequestPromise = userPage.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/control/projects/prj_fixture_001/services/svc_fixture_web/github');
  await userPage.getByRole('button', { name: '연결', exact: true }).click();
  const attachRequest = await attachRequestPromise;
  expect([...new URLSearchParams(attachRequest.postData() || '').entries()]).toEqual(attachData);
  await expect(userPage).toHaveURL(/\/github\?step=sync&notice=saved$/);

  const emptyContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await installSession(emptyContext, 'fixture-user-empty');
  const emptyPage = await emptyContext.newPage();
  await emptyPage.goto('/github?step=import');
  await expect(emptyPage.getByText('먼저 GitHub를 연결하세요.')).toBeVisible();
  await expect(emptyPage.locator('[data-t14-github] form')).toHaveCount(0);
  await expectAccessible(emptyPage);
  await emptyContext.close();

  const syncSelector = 'form[action*="/github/repositories/raibit%2Ffixture-app/sync"]';
  const syncData = [
    ['_returnTo', '/github?step=sync&installation=9001'],
  ] as const;
  expect(await nativeFormData(userPage, syncSelector)).toEqual(syncData);
  const syncRequestPromise = userPage.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/control/github/repositories/raibit%2Ffixture-app/sync');
  await userPage.getByRole('button', { name: '동기화' }).click();
  const syncRequest = await syncRequestPromise;
  expect([...new URLSearchParams(syncRequest.postData() || '').entries()]).toEqual(syncData);
  await expect(userPage).toHaveURL(/\/github\?step=sync&installation=9001&notice=saved$/);
  await expectAccessible(userPage);
});

test('@t14 GitHub install and callback routes keep safe origins and sanitize failures', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await installSession(context, 'fixture-user-populated');
  const page = await context.newPage();
  const eventLog: string[] = [];
  page.on('console', (message) => eventLog.push(`console:${message.type()}:${message.text()}`));
  page.on('pageerror', (error) => eventLog.push(`page:${error.message}`));
  page.on('requestfailed', (request) => eventLog.push(`request:${request.failure()?.errorText || 'failed'}`));

  await page.route('https://github.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<main>GitHub fixture landing</main>' }));
  await page.goto(`${DASHBOARD_ORIGIN}/github/install`);
  const installUrl = new URL(page.url());
  expect(installUrl.origin).toBe('https://github.com');
  expect(installUrl.pathname).toBe('/apps/raibit-fixture/installations/new');
  expect(installUrl.searchParams.get('state')).toBe('public-fixture-state');

  await page.goto(`${DASHBOARD_ORIGIN}/github/callback?error=${encodeURIComponent('javascript:alert(1)')}`);
  await expect(page).toHaveURL(/\/github\?step=connect&error=github_callback_failed$/);
  const callbackAlert = page.locator('main#main-content [data-slot="alert"]').filter({ hasText: '요청을 처리하지 못했습니다. 입력과 권한을 확인하세요.' });
  await expect(callbackAlert).toBeVisible();
  await expect(page.locator('body')).not.toContainText('javascript:alert(1)');
  await expect(page.locator('next-route-announcer')).not.toContainText(/javascript:alert\(1\)|fixture_route_not_found|fixture-invalid-code|fixture-state/i);

  await page.goto(`${DASHBOARD_ORIGIN}/github/callback?code=fixture-invalid-code&state=fixture-state`);
  await expect(page).toHaveURL(/\/github\?step=connect&error=fixture_route_not_found$/);
  await expect(callbackAlert).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/fixture_route_not_found|fixture-invalid-code|fixture-state/i);
  await expect(page.locator('next-route-announcer')).not.toContainText(/javascript:alert\(1\)|fixture_route_not_found|fixture-invalid-code|fixture-state/i);
  expect(eventLog.join('\n')).not.toMatch(/token|secret|fixture_route_not_found|fixture-invalid-code|fixture-state/i);
  await expectAccessible(page);
  await context.close();
});

test('@t14 admin workflows preserve exact approval, rejection, ban, and authorization behavior', async ({ browser, adminPage, userPage }) => {
  await adminPage.setViewportSize({ width: 1280, height: 800 });
  await adminPage.goto('/admin');
  await expect(adminPage.getByRole('heading', { name: '가입 신청 확인' })).toBeVisible();

  const clubApproval = 'form[action*="/admin/users/usr_pending/approve"]:has(input[value="CLUB_MEMBER"])';
  const nonClubApproval = 'form[action*="/admin/users/usr_pending/approve"]:has(input[value="NON_CLUB"])';
  expect(await nativeFormData(adminPage, clubApproval)).toEqual([['accountType', 'CLUB_MEMBER']]);
  expect(await nativeFormData(adminPage, nonClubApproval)).toEqual([['accountType', 'NON_CLUB']]);

  const rejectForm = adminPage.locator('form[action*="/admin/users/usr_pending/reject"]');
  expect(await rejectForm.evaluate((form) => form instanceof HTMLFormElement && form.checkValidity())).toBe(false);
  expect(await nativeFormData(adminPage, 'form[action*="/admin/users/usr_pending/reject"]')).toEqual([]);
  await rejectForm.locator('input[name="confirmed"]').check();
  expect(await nativeFormData(adminPage, 'form[action*="/admin/users/usr_pending/reject"]')).toEqual([['confirmed', 'true']]);

  const banForm = adminPage.locator('form[action*="/admin/users/usr_fixture_user/ban"]');
  expect(await banForm.evaluate((form) => form instanceof HTMLFormElement && form.checkValidity())).toBe(false);
  await banForm.locator('input[name="reason"]').fill('운영 정책 위반');
  expect(await nativeFormData(adminPage, 'form[action*="/admin/users/usr_fixture_user/ban"]')).toEqual([
    ['reason', '운영 정책 위반'],
    ['expiresAt', ''],
  ]);
  await expectAccessible(adminPage);

  await userPage.setViewportSize({ width: 375, height: 812 });
  await userPage.goto('/admin');
  await expect(userPage).toHaveURL(/\/console$/);
});
