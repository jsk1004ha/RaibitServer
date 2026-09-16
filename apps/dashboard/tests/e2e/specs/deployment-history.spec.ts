import { expect, test } from '../helpers/fixtures';
import { FIXTURE_ORIGIN, expectAccessible, expectRoute, observeBrowserErrors } from '../helpers/contracts';

const projectPath = '/org/raibit/projects/prj_fixture_001';
const historyPath = `${projectPath}?view=deployments&serviceId=svc_fixture_web&environment=production&status=FAILED&trigger=push&from=2026-08-31T00%3A00%3A00Z&to=2026-09-01T00%3A00%3A00Z`;

test.describe('@deployment-history', () => {
  test.beforeEach(async ({ request }) => {
    const reset = await request.post(`${FIXTURE_ORIGIN}/__fixture/reset`);
    expect(reset.ok()).toBe(true);
  });

  test('keeps addressable filters while showing immutable source, lineage, health, and a server-approved recovery action', async ({ adminPage }) => {
    const assertNoErrors = observeBrowserErrors(adminPage);
    await adminPage.setViewportSize({ width: 375, height: 812 });
    await adminPage.goto(historyPath);
    await expectRoute(adminPage, projectPath, {
      view: 'deployments', serviceId: 'svc_fixture_web', environment: 'production', status: 'FAILED', trigger: 'push', from: '2026-08-31T00:00:00Z', to: '2026-09-01T00:00:00Z',
    });
    await expect(adminPage.getByText('0123456789abcdef0123456789abcdef01234567')).toBeVisible();
    await expect(adminPage.getByText('sha256:fixture0001')).toBeVisible();
    await expect(adminPage.getByText('재시도 원본')).toBeVisible();
    await expect(adminPage.getByText('공개 헬스')).toBeVisible();
    await adminPage.getByRole('button', { name: '재시도', exact: true }).click();
    await expect(adminPage.getByRole('heading', { name: '재시도 요청 확인' })).toBeVisible();
    const requestPromise = adminPage.waitForRequest((request) => request.method() === 'POST' && request.url().includes('/api/control/deployments/dep_fixture_failed/retry'));
    await adminPage.getByRole('button', { name: '재시도 요청', exact: true }).click();
    const request = await requestPromise;
    const body = request.postDataJSON();
    expect(typeof body.requestIdempotencyKey).toBe('string');
    expect(body.snapshotVersion).toBe(3);
    const feedback = adminPage.getByText('새 배포:');
    await expect(feedback).toContainText('dep_fixture_retry_successor');
    await expect(feedback.locator('a')).toHaveAttribute('href', '/org/raibit/projects/prj_fixture_001?view=deployments&serviceId=svc_fixture_web&environment=production&status=FAILED&trigger=push&from=2026-08-31T00%3A00%3A00Z&to=2026-09-01T00%3A00%3A00Z');
    await expectAccessible(adminPage);
    assertNoErrors();
  });

  test('@deployment-history-negative does not offer a client-inferred action to a viewer', async ({ userPage }) => {
    await userPage.goto(historyPath);
    await expect(userPage.getByText('이 배포에 대한 실행 권한이 없습니다.')).toBeVisible();
    await expect(userPage.getByRole('button', { name: /재시도|재배포|취소|롤백/ })).toHaveCount(0);
    await expectAccessible(userPage);
  });
});
