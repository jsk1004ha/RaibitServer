import { expect, test } from '../helpers/fixtures';
import { expectAccessible, nativeFormData } from '../helpers/contracts';

test('@t40 GitHub catalog keeps filter and opaque cursor pagination in the URL, then imports a page-three repository', async ({ userPage }) => {
  await userPage.goto('/github?step=import&installation=9001');
  await expect(userPage.getByRole('heading', { name: '저장소 카탈로그' })).toBeVisible();
  await userPage.getByRole('link', { name: '다음 50개' }).click();
  await expect(userPage).toHaveURL(/cursor=fixture-catalog-page-2$/);
  await userPage.getByRole('link', { name: '다음 50개' }).click();
  await expect(userPage).toHaveURL(/cursor=fixture-catalog-page-3$/);
  await expect(userPage.locator('#github-import-repository option').first()).toHaveAttribute('value', 'repo_fixture_101');

  const formData = await nativeFormData(userPage, 'form#import-repository');
  expect(formData).toContainEqual(['repositoryId', 'repo_fixture_101']);
  const request = userPage.waitForRequest((candidate) => candidate.method() === 'POST' && new URL(candidate.url()).pathname === '/api/control/github/repositories/import');
  await userPage.getByRole('button', { name: '가져오기' }).click();
  await request;
  await expectAccessible(userPage);
});

test('@t40 GitHub catalog filter clears pagination and refresh control respects roles', async ({ adminPage, userPage }) => {
  await userPage.goto('/github?step=import&installation=9001&cursor=fixture-catalog-page-2');
  await userPage.getByLabel('저장소 필터').fill('fixture-repository-101');
  await userPage.getByRole('button', { name: '필터 적용' }).click();
  await expect(userPage).toHaveURL(/step=import&installation=9001&q=fixture-repository-101$/);
  await expect(userPage.getByRole('button', { name: '저장소 새로고침' })).toBeDisabled();

  await adminPage.goto('/github?step=import&installation=9001');
  await expect(adminPage.getByRole('button', { name: '저장소 새로고침' })).toBeEnabled();
  await expectAccessible(adminPage);
});
