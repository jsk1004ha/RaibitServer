import { expect, test } from '../helpers/fixtures';
import { expectAccessible } from '../helpers/contracts';

const projectPath = '/org/raibit/projects/prj_fixture_001?view=domains';

test.beforeEach(async ({ userPage }) => {
  await userPage.request.post('http://127.0.0.1:3411/__fixture/reset');
});

test('@custom-domains keeps the generated URL first and opens only READY custom domains', async ({ adminPage }) => {
  await adminPage.goto(projectPath);

  await expect(adminPage.getByRole('heading', { name: '생성된 서비스 URL' })).toBeVisible();
  await expect(adminPage.getByRole('link', { name: '생성된 서비스 URL 새 창에서 열기' })).toBeVisible();
  await expect(adminPage.getByText('app.fixture.example')).toBeVisible();
  await expect(adminPage.getByRole('link', { name: 'app.fixture.example 새 창에서 열기' })).toBeVisible();
  await expect(adminPage.getByText('failed.fixture.example')).toBeVisible();
  await expect(adminPage.getByText('준비됨 상태와 TLS 준비 전에는 사용자 URL을 열지 않습니다.')).toBeVisible();
  await expectAccessible(adminPage);
});

test('@custom-domains shows the TXT value once after creation and does not put it in the domain list', async ({ adminPage }) => {
  await adminPage.goto(projectPath);
  await adminPage.getByRole('button', { name: '사용자 도메인 추가' }).click();
  await adminPage.getByLabel('호스트 이름').fill('docs.fixture.example');
  await adminPage.getByRole('button', { name: 'TXT 검증 값 만들기' }).click();

  await expect(adminPage.getByRole('status')).toContainText('_raibit-challenge.docs.fixture.example');
  await expect(adminPage.getByRole('status')).toContainText('raibit-verification=');
  await adminPage.getByRole('button', { name: 'TXT 값을 확인했습니다' }).click();
  await expect(adminPage.getByText('이번에만 표시하는 DNS TXT 값')).toHaveCount(0);
});

test('@custom-domains-negative makes rotation and deletion scope explicit without claiming synchronous cleanup', async ({ adminPage }) => {
  await adminPage.goto(projectPath);
  const card = adminPage.getByText('app.fixture.example').locator('..').locator('..');
  await card.getByRole('button', { name: 'TXT 값 교체' }).click();
  await expect(adminPage.getByText('202 응답은 요청 접수일 뿐 정리 완료가 아닙니다.')).toBeVisible();
  await adminPage.getByLabel('기존 사용자 URL의 일시적인 연결 해제를 이해했습니다.').check();
  await adminPage.getByRole('button', { name: 'TXT 값 교체' }).last().click();
  await expect(adminPage.getByText('이번에만 표시하는 DNS TXT 값')).toBeVisible();

  await adminPage.getByRole('button', { name: '삭제 요청' }).first().click();
  await expect(adminPage.getByText('생성된 서비스 URL과 다른 사용자 도메인은 삭제하지 않습니다.')).toBeVisible();
});
