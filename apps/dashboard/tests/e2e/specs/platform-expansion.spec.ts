import { expect, test } from '../helpers/fixtures';
import { expectAccessible, observeBrowserErrors } from '../helpers/contracts';
import { PLATFORM_EXPANSION_EXECUTABLE_ROWS, PLATFORM_EXPANSION_MATRIX } from '../feature-expansion-matrix';
import { validatePlatformExpansionMatrix } from '../platform-expansion-report.js';

const fixtureEnabled = process.env.RAIBITSERVER_E2E_FIXTURES === '1';
const projectPath = '/org/raibit/projects/prj_fixture_001';

test.describe('@platform-expansion', () => {
  test.skip(!fixtureEnabled, 'requires RAIBITSERVER_E2E_FIXTURES=1');

  test.beforeAll(() => {
    const report = validatePlatformExpansionMatrix(PLATFORM_EXPANSION_MATRIX);
    expect(report.expectedScenarioCount).toBe(PLATFORM_EXPANSION_EXECUTABLE_ROWS.length);
    expect(report.browserExecution).toBe('NOT_RUN');
  });

  test('auth keyboard login observes the completed route', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.goto('/login?next=%2Forg%2Fraibit%2Fprojects');
    await page.evaluate(() => { document.documentElement.style.zoom = '200%'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByLabel('이메일').fill('user@fixture.test');
    await page.getByLabel('비밀번호').fill('fixture-user-pass');
    await page.getByLabel('비밀번호').press('Enter');
    await expect(page).toHaveURL(/\/org\/raibit\/projects\?notice=saved$/);
    await expectAccessible(page);
  });

  test('GitHub disconnect retries a typed conflict and observes the disconnected state', async ({ adminPage }) => {
    await adminPage.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await adminPage.goto('/github?step=connect');
    await adminPage.getByRole('checkbox', { name: 'RAIBITSERVER 연결 해제의 영향을 확인했습니다.' }).check();
    const response = adminPage.waitForResponse((candidate) => candidate.url().includes('/api/control/organizations/org_fixture_001/integrations/github/ghi_fixture/disconnect') && candidate.request().method() === 'POST');
    await adminPage.getByRole('button', { name: 'RAIBITSERVER 연결 해제' }).click();
    expect((await response).status()).toBe(200);
    await expect(adminPage.getByRole('status')).toContainText('RAIBITSERVER 연결이 해제되었습니다.');
    await expectAccessible(adminPage);
  });

  test('project settings saves a rendered-version patch and exposes its resulting value', async ({ userPage }) => {
    await userPage.goto(`${projectPath}?view=settings`);
    await userPage.getByLabel('프로젝트 이름').fill('Task49 변경 프로젝트');
    const response = userPage.waitForResponse((candidate) => candidate.url().includes('/api/control/projects/prj_fixture_001/settings') && candidate.request().method() === 'PATCH');
    await userPage.getByRole('button', { name: '변경 사항 저장' }).click();
    expect((await response).status()).toBe(200);
    await expect(userPage.getByLabel('프로젝트 이름')).toHaveValue('Task49 변경 프로젝트');
    await expect(userPage.getByText(/에 저장됨/)).toBeVisible();
    await expectAccessible(userPage);
  });

  test('service settings previews validated input without creating a deployment', async ({ userPage }) => {
    await userPage.goto(`${projectPath}?view=edit-service&serviceId=svc_fixture_web`);
    await userPage.getByLabel('Dockerfile 경로').fill('docker/Dockerfile');
    await userPage.getByRole('button', { name: '빌드 계획 미리보기' }).click();
    await expect(userPage.getByRole('heading', { name: '저장 전 빌드 계획' })).toBeVisible();
    await userPage.getByRole('button', { name: '설정 저장' }).click();
    await expect(userPage.getByText('설정이 저장되었습니다. 이 작업은 배포를 만들지 않습니다.')).toBeVisible();
    await expectAccessible(userPage);
  });

  test('deployment retry observes a server-created successor rather than request success alone', async ({ adminPage }) => {
    await adminPage.goto(`${projectPath}?view=deployments&serviceId=svc_fixture_web&environment=production&status=FAILED`);
    await adminPage.getByRole('button', { name: '재시도', exact: true }).click();
    const response = adminPage.waitForResponse((candidate) => candidate.url().includes('/api/control/deployments/dep_fixture_failed/retry') && candidate.request().method() === 'POST');
    await adminPage.getByRole('button', { name: '재시도 요청', exact: true }).click();
    expect((await response).status()).toBe(202);
    await expect(adminPage.getByText('새 배포:')).toContainText('dep_fixture_retry_successor');
    await expectAccessible(adminPage);
  });

  test('runtime streams replace the selected-service data and close the old stream', async ({ userPage }) => {
    await userPage.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await userPage.goto(`${projectPath}?view=logs&serviceId=svc_fixture_worker&retained=1`);
    await expect(userPage.getByRole('log', { name: '런타임 로그' })).toContainText('worker-only-initial-log');
    await userPage.getByLabel('로그 서비스').selectOption('svc_fixture_web');
    await expect(userPage.getByRole('log', { name: '런타임 로그' })).toContainText('web-only-initial-log');
    await expect(userPage.locator('[data-runtime-log-status="live"]')).toBeVisible();
    await expectAccessible(userPage);
  });

  test('resource backup and restore actions observe their selected resource outcomes', async ({ userPage }) => {
    await userPage.goto(`${projectPath}/resources/res_fixture_pg/console?view=backups`);
    const backup = userPage.waitForResponse((candidate) => candidate.url().includes('/api/control/resources/res_fixture_pg/backups') && candidate.request().method() === 'POST');
    await userPage.getByRole('button', { name: '백업 만들기' }).click();
    const backupResponse = await backup;
    expect(backupResponse.status()).toBe(202);
    expect(backupResponse.request().postDataJSON()).toMatchObject({ formatVersion: 1 });
    const readyRow = userPage.getByTestId('backup-row-bak_fixture_ready');
    await readyRow.getByRole('button', { name: '복구 준비' }).click();
    await userPage.getByLabel('새 리소스 이름').fill('task49-restored');
    const restore = userPage.waitForResponse((candidate) => candidate.url().includes('/api/control/backups/bak_fixture_ready/restores') && candidate.request().method() === 'POST');
    await userPage.getByRole('button', { name: '복구 요청', exact: true }).click();
    const restoreResponse = await restore;
    expect(restoreResponse.status()).toBe(202);
    expect(restoreResponse.request().postDataJSON()).toMatchObject({ formatVersion: 1, name: 'task49-restored' });
    await expect(userPage.getByText(/복구 요청/)).toBeVisible();
    await expectAccessible(userPage);
  });

  test('custom-domain TXT proof is one-time and does not replace the generated route', async ({ adminPage }) => {
    const assertNoErrors = observeBrowserErrors(adminPage);
    await adminPage.goto(`${projectPath}?view=domains`);
    await expect(adminPage.getByRole('link', { name: '생성된 서비스 URL 새 창에서 열기' })).toBeVisible();
    await adminPage.getByRole('button', { name: '사용자 도메인 추가' }).click();
    await adminPage.getByLabel('호스트 이름').fill('task49.fixture.example');
    const response = adminPage.waitForResponse((candidate) => candidate.url().includes('/api/control/projects/prj_fixture_001/domains') && candidate.request().method() === 'POST');
    await adminPage.getByRole('button', { name: 'TXT 검증 값 만들기' }).click();
    expect((await response).status()).toBe(201);
    await expect(adminPage.getByRole('status')).toContainText('_raibit-challenge.task49.fixture.example');
    await adminPage.getByRole('button', { name: 'TXT 값을 확인했습니다' }).click();
    await expect(adminPage.getByText('이번에만 표시하는 DNS TXT 값')).toHaveCount(0);
    assertNoErrors();
  });
});
