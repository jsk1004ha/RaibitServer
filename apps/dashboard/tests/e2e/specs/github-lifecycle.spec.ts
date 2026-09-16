import { test, expect } from '../helpers/fixtures';
import { expectAccessible } from '../helpers/contracts';

test('@github-lifecycle renders scoped lifecycle guidance and only lets an administrator disconnect', async ({ adminPage, userPage }) => {
  // Given: the fixture has one organization-scoped GitHub integration.
  await userPage.goto('/github?step=connect');
  await expect(userPage.getByRole('heading', { name: '연결 상태', exact: true })).toBeVisible();
  await expect(userPage.getByText('현재 배포된 서비스는 계속 실행됩니다.')).toBeVisible();
  await expect(userPage.getByRole('button', { name: 'RAIBITSERVER 연결 해제' })).toHaveCount(0);

  // When: an organization administrator confirms the disconnect.
  await adminPage.goto('/github?step=connect');
  await expect(adminPage.getByRole('button', { name: 'RAIBITSERVER 연결 해제' })).toBeDisabled();
  await expect(adminPage.getByText('GitHub App은 제거되지 않습니다.')).toBeVisible();
  const requestPromise = adminPage.waitForRequest((request) => request.method() === 'POST'
    && new URL(request.url()).pathname === '/api/control/organizations/org_fixture_001/integrations/github/ghi_fixture/disconnect');
  await adminPage.getByRole('checkbox', { name: 'RAIBITSERVER 연결 해제의 영향을 확인했습니다.' }).check();
  await adminPage.getByRole('button', { name: 'RAIBITSERVER 연결 해제' }).click();
  const request = await requestPromise;

  // Then: the BFF receives only the optimistic-concurrency version and the UI explains the safe recovery path.
  expect(request.postDataJSON()).toEqual({ expectedVersion: 7 });
  await expect(adminPage.getByRole('status')).toContainText('RAIBITSERVER 연결이 해제되었습니다.');
  await expect(adminPage.getByRole('link', { name: '신뢰된 연결 흐름으로 다시 연결' })).toHaveAttribute('href', '/github/install');
  await expect(adminPage.getByRole('link', { name: 'GitHub 설치 설정 열기' })).toHaveAttribute('href', 'https://github.com/settings/installations/9001');
  await expect(adminPage.locator('body')).not.toContainText(/fixture.*secret|upstream/i);
  await expectAccessible(adminPage);
});

test('@github-lifecycle keeps pending, stale, failure, and retry feedback accessible', async ({ adminPage }) => {
  let attempts = 0;
  await adminPage.route('**/api/control/organizations/org_fixture_001/integrations/github/ghi_fixture/disconnect', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'stale_version' }) });
      return;
    }
    if (attempts === 2) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_upstream_unavailable' }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ integration: { status: 'DISCONNECTED', version: 8, credentialIssuance: 'denied' } }) });
  });
  await adminPage.goto('/github?step=connect');
  await adminPage.getByRole('checkbox', { name: 'RAIBITSERVER 연결 해제의 영향을 확인했습니다.' }).check();
  await adminPage.getByRole('button', { name: 'RAIBITSERVER 연결 해제' }).click();
  await expect(adminPage.getByRole('button', { name: '연결 해제 중' })).toBeDisabled();
  await expect(adminPage.getByRole('alert')).toContainText('연결 상태가 변경되었습니다.');
  await adminPage.getByRole('button', { name: 'RAIBITSERVER 연결 해제' }).click();
  await expect(adminPage.getByRole('alert')).toContainText('연결을 해제하지 못했습니다.');
  await adminPage.getByRole('button', { name: 'RAIBITSERVER 연결 해제' }).click();
  await expect(adminPage.getByRole('status')).toContainText('RAIBITSERVER 연결이 해제되었습니다.');
  await expectAccessible(adminPage);
});
