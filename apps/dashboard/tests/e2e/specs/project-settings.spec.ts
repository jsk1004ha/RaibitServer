import { test, expect } from '../helpers/fixtures';
import { expectAccessible } from '../helpers/contracts';

const projectPath = '/org/raibit/projects/prj_fixture_001?view=settings';

test('@project-settings renders mutable details separately from scheduled deletion', async ({ userPage }) => {
  // Given a member can open the project settings screen.
  await userPage.goto(projectPath);

  // When the settings view loads.
  // Then mutable details and the destructive flow have distinct, labelled surfaces.
  await expect(userPage.getByRole('heading', { name: '프로젝트 일반 설정' })).toBeVisible();
  await expect(userPage.getByLabel('프로젝트 이름')).toHaveValue('결정적 운영 프로젝트');
  await expect(userPage.getByLabel('설명')).toBeVisible();
  await expect(userPage.getByRole('heading', { name: '프로젝트 삭제' })).toBeVisible();
  await expect(userPage.getByText('서비스 2개 · 리소스 1개 · 미리보기 1개')).toBeVisible();
});

test.beforeEach(async ({ userPage }) => {
  await userPage.request.post('http://127.0.0.1:3411/__fixture/reset');
});

test('@project-settings saves only dirty mutable fields with the rendered version', async ({ userPage }) => {
  await userPage.goto(projectPath);
  await expect(userPage.getByRole('button', { name: '변경 사항 저장' })).toBeDisabled();

  const response = userPage.waitForResponse((candidate) => candidate.url().includes('/api/control/projects/prj_fixture_001/settings') && candidate.request().method() === 'PATCH');
  await userPage.getByLabel('프로젝트 이름').fill('변경된 운영 프로젝트');
  await userPage.getByRole('button', { name: '변경 사항 저장' }).click();

  const request = await response;
  await expect(userPage.getByText(/에 저장됨/)).toBeVisible();
  await expect(userPage.getByLabel('프로젝트 이름')).toHaveValue('변경된 운영 프로젝트');
  expect(await request.request().postDataJSON()).toEqual({ expectedUpdatedAt: '2026-08-31T03:00:00.000Z', name: '변경된 운영 프로젝트' });
  await expectAccessible(userPage);
});

test('@project-settings-negative warns before it discards stale local changes and denies member deletion', async ({ userPage }) => {
  await userPage.goto(projectPath);
  await userPage.getByLabel('프로젝트 이름').fill('내 로컬 변경');
  const concurrent = await userPage.evaluate(async () => {
    const response = await fetch('/api/control/projects/prj_fixture_001/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedUpdatedAt: '2026-08-31T03:00:00.000Z', description: '다른 사용자의 변경' }),
    });
    return response.status;
  });
  expect(concurrent).toBe(200);

  await userPage.getByRole('button', { name: '변경 사항 저장' }).click();
  await expect(userPage.getByRole('alert')).toContainText('저장된 설정이 최신이 아닙니다.');
  await expect(userPage.getByRole('button', { name: '최신 설정 불러오기' })).toBeVisible();

  await userPage.getByRole('button', { name: '삭제 요청' }).click();
  await userPage.getByLabel('영향과 복구 절차를 확인했습니다.').check();
  await userPage.getByRole('button', { name: '삭제 요청 등록' }).click();
  await expect(userPage.getByRole('alert')).toContainText('이 작업을 수행할 권한이 없습니다.');
});

test('@project-settings schedules deletion for an administrator without claiming synchronous deletion', async ({ adminPage }) => {
  await adminPage.request.post('http://127.0.0.1:3411/__fixture/reset');
  await adminPage.goto(projectPath);
  await adminPage.getByRole('button', { name: '삭제 요청' }).click();
  await adminPage.getByLabel('영향과 복구 절차를 확인했습니다.').check();
  await adminPage.getByRole('button', { name: '삭제 요청 등록' }).click();
  await expect(adminPage.getByRole('alert')).toContainText('삭제 요청이 대기열에 등록되었습니다.');
  await expect(adminPage.getByText('즉시 삭제되지 않습니다.')).toBeVisible();
});
