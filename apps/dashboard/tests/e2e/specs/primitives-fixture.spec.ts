import { expect, test } from '../helpers/fixtures';
import { expectAccessible, nativeFormData, observeBrowserErrors } from '../helpers/contracts';

const fixtureEnabled = process.env.RAIBITSERVER_E2E_FIXTURES === '1';

test('the primitive fixture is denied by default in a production server', async ({ userPage: page }) => {
  test.skip(fixtureEnabled, 'requires a server without RAIBITSERVER_E2E_FIXTURES=1');

  await page.goto('/primitives-fixture');

  await expect(page.getByRole('heading', { name: '요청한 화면을 찾을 수 없습니다' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '긴 한국어 서비스 이름도 자연스럽고 안정적으로 읽히는 운영 인터페이스' })).toHaveCount(0);
});

test('the primitive fixture exercises form and overlay primitives only when explicitly enabled for E2E', async ({ userPage: page }) => {
  test.skip(!fixtureEnabled, 'requires RAIBITSERVER_E2E_FIXTURES=1');
  const assertNoErrors = observeBrowserErrors(page);

  await page.goto('/primitives-fixture');

  await expect(page.getByRole('heading', { name: '긴 한국어 서비스 이름도 자연스럽고 안정적으로 읽히는 운영 인터페이스' })).toBeVisible();
  expect(await nativeFormData(page, '#primitive-form')).toEqual([
    ['projectName', 'raibit-console'],
    ['description', '안전한 배포 환경'],
    ['region', 'icn'],
    ['invalidName', ''],
    ['notifications', 'enabled'],
  ]);

  const dialogTrigger = page.getByRole('button', { name: '대화상자 열기' });
  await dialogTrigger.click();
  const dialog = page.getByRole('dialog', { name: '배포 설정 확인' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(dialogTrigger).toBeFocused();

  const sheetTrigger = page.getByRole('button', { name: '시트 열기' });
  await sheetTrigger.click();
  const sheet = page.getByRole('dialog', { name: '프로젝트 세부 정보' });
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(sheet.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(sheetTrigger).toBeFocused();

  const commandTrigger = page.getByRole('button', { name: '명령 팔레트' });
  await commandTrigger.click();
  const command = page.getByRole('dialog', { name: '프로젝트 명령' });
  await expect(command).toBeVisible();
  await page.getByPlaceholder('명령 검색').fill('배포');
  await expect(command.getByText('배포 시작')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(command).toBeHidden();
  await expect(commandTrigger).toBeFocused();

  const menuTrigger = page.getByRole('button', { name: '작업 메뉴' });
  await menuTrigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '설정 열기' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(menuTrigger).toBeFocused();

  const tooltipTrigger = page.getByRole('button', { name: '도움말' });
  await tooltipTrigger.hover();
  const tooltip = page.locator('[data-slot="tooltip-content"]');
  await expect(tooltip).toHaveText('최근 배포 상태를 새로 확인합니다.');
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();

  await expectAccessible(page);
  assertNoErrors();
});
