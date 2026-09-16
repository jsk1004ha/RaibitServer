import { expect, test } from '../helpers/fixtures';
import { expectAccessible } from '../helpers/contracts';

const servicePath = '/org/raibit/projects/prj_fixture_001?view=edit-service&serviceId=svc_fixture_web';

test('@service-settings previews and conditionally saves mutable service settings', async ({ userPage }) => {
  await userPage.goto(servicePath);
  await expect(userPage.getByRole('heading', { name: 'web 설정' })).toBeVisible();
  await expect(userPage.getByText('첫 배포 이후 식별 정보 잠김')).toBeVisible();
  await expect(userPage.getByLabel('서비스 이름')).toBeDisabled();
  await expect(userPage.getByLabel('공통 상태 경로')).toHaveValue('/healthz');
  await userPage.getByLabel('Dockerfile 경로').fill('docker/Dockerfile');
  await userPage.getByRole('button', { name: '빌드 계획 미리보기' }).click();
  await expect(userPage.getByRole('heading', { name: '저장 전 빌드 계획' })).toBeVisible();
  await userPage.getByRole('button', { name: '설정 저장' }).click();
  await expect(userPage.getByText('설정이 저장되었습니다. 이 작업은 배포를 만들지 않습니다.')).toBeVisible();
  await expectAccessible(userPage);
});

test('@service-settings blocks invalid health and resource quantities before preview', async ({ userPage }) => {
  await userPage.goto(servicePath);
  await expect(userPage.getByLabel('공통 상태 경로')).toHaveValue('/healthz');
  await userPage.getByLabel('공통 상태 경로').fill('../health');
  await userPage.getByLabel('CPU 요청').fill('many');
  await expect(userPage.getByText('슬래시로 시작하고 공백, query, fragment, 상위 경로 없이 입력하세요.')).toBeVisible();
  await expect(userPage.getByText('CPU는 100m 또는 0.5 형식으로 입력하세요.')).toBeVisible();
  await expect(userPage.getByRole('button', { name: '빌드 계획 미리보기' })).toBeDisabled();
  await expectAccessible(userPage);
});

test('@service-settings preserves the old service through explicit replacement', async ({ userPage }) => {
  await userPage.goto(servicePath);
  await userPage.getByRole('button', { name: '새 서비스 교체 만들기' }).click();
  await expect(userPage.getByRole('dialog', { name: '새 서비스 교체 만들기' })).toBeVisible();
  await userPage.getByRole('button', { name: '기존 서비스 보존 후 만들기' }).click();
  await expect(userPage.getByText('새 서비스 교체를 만들었습니다. 기존 서비스와 배포 스냅샷은 보존됩니다.')).toBeVisible();
  await expectAccessible(userPage);
});
