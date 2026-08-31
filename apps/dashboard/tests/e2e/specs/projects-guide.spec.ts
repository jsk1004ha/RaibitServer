import { test, expect } from '../helpers/fixtures';
import { expectAccessible, expectRoute, installSession, nativeFormData, observeBrowserErrors } from '../helpers/contracts';

const expectedPayload = [
  ['_returnTo', '/org/raibit/projects'], ['name', '교내 운영 서비스'], ['slug', 'school-ops'],
  ['sourceType', 'github'], ['repoUrl', 'https://github.com/raibit/school-ops'], ['branch', 'main'],
  ['serviceName', 'web'], ['type', 'web'], ['image', ''], ['dockerfilePath', 'Dockerfile'], ['buildContext', '.'],
  ['database', 'postgresql'], ['cache', 'redis'],
];

test('@t11 four-step project wizard guards progression, focus and exact native FormData', async ({ userPage }) => {
  const assertNoErrors = observeBrowserErrors(userPage);
  await userPage.setViewportSize({ width: 375, height: 812 });
  await userPage.goto('/org/raibit/projects/new');
  const next = userPage.locator('[data-wizard-next]');
  await next.click();
  await expect(userPage.getByRole('heading', { name: '프로젝트 기본 정보' })).toBeVisible();
  await expect(userPage.getByLabel('프로젝트 이름')).toBeFocused();
  await userPage.getByLabel('프로젝트 이름').fill('교내 운영 서비스');
  await userPage.getByLabel('슬러그').fill('school-ops');
  await next.click();
  await expect(userPage.getByRole('heading', { name: '저장소 연결' })).toBeFocused();
  await userPage.getByLabel('저장소 URL').fill('https://github.com/raibit/school-ops');
  await next.click();
  await expect(userPage.getByRole('heading', { name: '첫 서비스' })).toBeFocused();
  await userPage.getByLabel('Dockerfile 경로').fill('Dockerfile');
  await next.click();
  await expect(userPage.getByRole('heading', { name: '관리형 리소스' })).toBeFocused();
  await userPage.getByLabel('데이터베이스').selectOption('postgresql');
  await userPage.getByLabel('캐시').selectOption('redis');
  expect(await nativeFormData(userPage, '[data-project-create-form]')).toEqual(expectedPayload);
  await expect(userPage.locator('[name="organizationId"]')).toHaveCount(0);
  await expectAccessible(userPage);
  assertNoErrors();
});

test('@t11 project and guide states remain stable across widths and browser history', async ({ browser, userPage }) => {
  for (const width of [375, 1280]) {
    await userPage.setViewportSize({ width, height: 900 });
    await userPage.goto('/org/raibit/projects');
    await expect(userPage.getByText('결정적 운영 프로젝트')).toBeVisible();
    await expect(userPage.locator('body')).not.toHaveCSS('overflow-x', 'scroll');
  }
  await userPage.goto('/guide?topic=projects');
  await expect(userPage.getByRole('heading', { name: '사용 안내' })).toBeVisible();
  await userPage.getByRole('link', { name: /자동 인식/ }).click();
  await expect(userPage).toHaveURL('http://console.localhost:3410/guide?topic=source');
  await expect(userPage.getByRole('heading', { name: '소스 자동 인식' })).toBeVisible();
  await userPage.goBack();
  await expect(userPage).toHaveURL('http://console.localhost:3410/guide?topic=projects');
  await expect(userPage.getByRole('heading', { name: '프로젝트 시작' })).toBeVisible();
  await userPage.goForward();
  await expect(userPage).toHaveURL('http://console.localhost:3410/guide?topic=source');
  await expect(userPage.getByRole('heading', { name: '소스 자동 인식' })).toBeVisible();

  for (const [token, expected] of [['fixture-user-empty', '이 조직에는 아직 프로젝트가 없습니다.'], ['fixture-user-partial', '일부 정보를 불러오지 못했습니다.'], ['fixture-user-long', '배포 로그가 길어져도']] as const) {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    await installSession(context, token);
    const page = await context.newPage();
    await page.goto(token.includes('empty') ? '/org/raibit/projects' : '/console');
    await expect(page.locator('body')).toContainText(expected);
    if (token === 'fixture-user-partial') await expect(page.locator('body')).not.toContainText('fixture_internal_secret_must_not_escape');
    await context.close();
  }
  const expired = await browser.newContext();
  await installSession(expired, 'fixture-expired');
  const expiredPage = await expired.newPage();
  await expiredPage.goto('/guide');
  await expectRoute(expiredPage, '/login', { error: 'session_expired' });
  await expired.close();
});
