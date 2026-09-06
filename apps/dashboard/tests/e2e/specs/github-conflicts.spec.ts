import { expect, test } from '../helpers/fixtures';
import { expectAccessible } from '../helpers/contracts';

test('@github-conflicts import preserves an idempotency key across retry and asks for an explicit new slug', async ({ adminPage }) => {
  await adminPage.goto('/github?step=import&installation=9001');
  await adminPage.locator('#github-import-service-slug').fill('taken');
  const requests: Array<Record<string, unknown>> = [];
  adminPage.on('request', (request) => {
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/control/github/repositories/import') return;
    const data = JSON.parse(request.postData() || '{}');
    if (data && typeof data === 'object' && !Array.isArray(data)) requests.push(data);
  });
  await adminPage.getByRole('button', { name: '가져오기' }).click();
  await expect(adminPage.locator('[data-github-recovery]')).toContainText('서비스 슬러그가 이미 사용 중입니다.');
  await adminPage.getByRole('button', { name: '새 서비스 슬러그 선택' }).click();
  await expect(adminPage.locator('#github-import-service-slug')).toBeFocused();
  await adminPage.getByRole('button', { name: '가져오기' }).click();
  expect(requests).toHaveLength(2);
  expect(requests[0].idempotencyKey).toBe(requests[1].idempotencyKey);
  expectAccessible(adminPage);
});

test('@github-conflicts attach and opaque collisions offer only their typed recovery action', async ({ adminPage }) => {
  await adminPage.goto('/github?step=attach&installation=9001');
  await adminPage.locator('#github-attach-branch').fill('changed');
  await adminPage.getByRole('button', { name: '연결', exact: true }).click();
  await expect(adminPage.locator('[data-github-recovery]')).toContainText('GitHub 기본 브랜치가 변경되었습니다.');
  await adminPage.getByRole('button', { name: '브랜치 직접 선택' }).click();
  await expect(adminPage.locator('#github-attach-branch')).toBeFocused();
  await expectAccessible(adminPage);
});
