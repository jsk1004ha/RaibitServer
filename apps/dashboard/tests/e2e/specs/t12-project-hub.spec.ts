import { test, expect } from '../helpers/fixtures';
import { expectAccessible, expectRoute, gotoWithNetworkChangedRetry, installSession, nativeFormData, observeBrowserErrors } from '../helpers/contracts';

const projectPath = '/org/raibit/projects/prj_fixture_001';

test('@t12 project hub keeps every view addressable across refresh and history', async ({ userPage }) => {
  const assertNoErrors = observeBrowserErrors(userPage, [404]);
  for (const [view, heading] of [
    ['overview', '운영 구성'], ['services', '서비스'], ['new-service', '서비스 만들기'], ['edit-service', 'web 설정'],
    ['deployments', '배포 내역'], ['agent', 'AI 배포 관리자'], ['resources', '관리형 리소스'], ['new-resource', '리소스 추가'],
    ['environment', '환경 변수'], ['logs', '런타임 로그'], ['settings', '프로젝트 삭제'],
  ] as const) {
    const serviceQuery = view === 'edit-service' || view === 'environment' ? '&serviceId=svc_fixture_web' : '';
    await userPage.goto(`${projectPath}?view=${view}${serviceQuery}`);
    await expect(userPage.getByRole('heading', { name: heading }).first()).toBeVisible();
    await userPage.reload();
    await expectRoute(userPage, projectPath, { view });
  }
  await userPage.goto(`${projectPath}?view=services`);
  await userPage.getByRole('link', { name: '새 서비스' }).click();
  await expectRoute(userPage, projectPath, { view: 'new-service' });
  await userPage.goBack();
  await expectRoute(userPage, projectPath, { view: 'services' });
  await userPage.goForward();
  await expect(userPage.getByRole('heading', { name: '서비스 만들기' })).toBeVisible();
  assertNoErrors();
});

test('@t12 native service, resource, environment, agent, and deletion controls preserve payload safety', async ({ userPage }) => {
  await userPage.goto(`${projectPath}?view=new-service`);
  await userPage.getByLabel('서비스 이름').fill('worker');
  await expect(userPage.getByLabel('소스 유형').locator('option')).toHaveText(['GitHub', '빌드된 이미지', '로컬 Dockerfile']);
  await expect.poll(() => nativeFormData(userPage, 'form[action*="/services"]')).toEqual([
    ['_returnTo', `${projectPath}?view=services`], ['name', 'worker'], ['type', 'web'], ['sourceType', 'github'],
    ['repoUrl', ''], ['branch', ''], ['buildContext', ''], ['dockerfilePath', ''], ['imageUrl', ''],
  ]);

  await userPage.goto(`${projectPath}?view=services`);
  const service = userPage.locator('[data-service-id="svc_fixture_web"]');
  const productionDeploy = service.locator('form[action*="/deployments"]:has(input[value="production"])');
  const previewDeploy = service.locator('form[action*="/deployments"]:has(input[value="preview"])');
  await expect(productionDeploy).toHaveCount(1);
  await expect(previewDeploy).toHaveCount(1);
  expect(await nativeFormData(userPage, '[data-service-id="svc_fixture_web"] form[action*="/deployments"]:has(input[value="production"])')).toEqual([
    ['_returnTo', `${projectPath}?view=deployments`], ['deploymentType', 'production'],
  ]);
  expect(await nativeFormData(userPage, '[data-service-id="svc_fixture_web"] form[action*="/deployments"]:has(input[value="preview"])')).toEqual([
    ['_returnTo', `${projectPath}?view=deployments`], ['deploymentType', 'preview'],
  ]);

  await userPage.goto(`${projectPath}?view=edit-service&serviceId=svc_fixture_web`);
  await expect(userPage.getByLabel('소스 유형').locator('option')).toHaveText(['GitHub', 'GitLab', 'ZIP', '빌드된 이미지', '로컬 Dockerfile']);
  await expect(userPage.getByLabel('포트')).toHaveAttribute('min', '1');
  await expect(userPage.getByLabel('포트')).toHaveAttribute('max', '65535');
  expect(await nativeFormData(userPage, 'form[action*="/services/svc_fixture_web"]')).toEqual([
    ['_method', 'PATCH'], ['_returnTo', `${projectPath}?view=services`], ['name', 'web'], ['type', 'web'],
    ['sourceType', 'github'], ['buildMode', 'auto'], ['repoUrl', 'https://github.com/raibit/fixture-app'], ['branch', 'main'],
    ['rootDirectory', ''], ['buildContext', ''], ['dockerfilePath', 'Dockerfile'], ['imageUrl', ''], ['installCommand', ''],
    ['buildCommand', ''], ['startCommand', ''], ['outputDirectory', ''], ['port', '3000'],
  ]);

  await userPage.goto(`${projectPath}?view=new-resource`);
  await userPage.getByLabel('리소스 이름').fill('cache');
  expect(await nativeFormData(userPage, 'form[action*="/resources"]')).toEqual([
    ['_returnTo', `${projectPath}?view=resources`], ['name', 'cache'], ['engine', 'postgresql'],
  ]);

  await userPage.goto(`${projectPath}?view=environment&serviceId=svc_fixture_web`);
  await expect(userPage.getByLabel('값', { exact: true })).toHaveValue('');
  await expect(userPage.getByLabel('.env 내용')).toHaveValue('');
  expect(userPage.url()).not.toContain('API_TOKEN');
  await userPage.getByLabel('키').fill('API_TOKEN');
  await userPage.getByLabel('값', { exact: true }).fill('fixture-secret-value');
  expect(await nativeFormData(userPage, 'form[action$="/env"]')).toEqual([
    ['_returnTo', `${projectPath}?view=environment&serviceId=svc_fixture_web`], ['key', 'API_TOKEN'], ['value', 'fixture-secret-value'],
  ]);
  await userPage.getByLabel('.env 내용').fill('NODE_ENV=production');
  expect(await nativeFormData(userPage, 'form[action$="/env-file"]')).toEqual([
    ['_returnTo', `${projectPath}?view=environment&serviceId=svc_fixture_web`], ['content', 'NODE_ENV=production'],
  ]);

  await userPage.goto(`${projectPath}?view=agent`);
  await expect(userPage.getByRole('button', { name: '보안 문제를 먼저 해결하세요' })).toBeDisabled();
  expect(await nativeFormData(userPage, 'form[action*="/deployment-agent/apply"]')).toEqual([
    ['_returnTo', `${projectPath}?view=deployments`], ['deploymentType', 'production'],
  ]);

  await userPage.goto(`${projectPath}?view=settings`);
  await userPage.getByLabel(/확인을 위해/).fill('잘못된 프로젝트 이름');
  await userPage.getByRole('button', { name: '프로젝트 삭제' }).click();
  await expectRoute(userPage, projectPath, { view: 'settings' });
  expect(await userPage.getByLabel(/확인을 위해/).evaluate((input) => input instanceof HTMLInputElement && input.validity.patternMismatch)).toBe(true);
  expect(await nativeFormData(userPage, 'form[action$="/projects/prj_fixture_001"]')).toEqual([
    ['_method', 'DELETE'], ['_returnTo', '/org/raibit/projects'], ['_confirmProject', '잘못된 프로젝트 이름'],
  ]);
  await expectAccessible(userPage);
});

test('@t12 populated, partial, and real empty fixture states remain deterministic', async ({ browser }) => {
  for (const [token, path, expected] of [
    ['fixture-user-populated', `${projectPath}?view=services`, '서비스'],
    ['fixture-user-partial', `${projectPath}?view=overview`, '운영 구성'],
    ['fixture-user-empty', '/org/raibit/projects', '이 조직에는 아직 프로젝트가 없습니다.'],
  ] as const) {
    const context = await browser.newContext();
    try {
      await installSession(context, token);
      const page = await context.newPage();
      await gotoWithNetworkChangedRetry(page, path);
      await expect(page.getByText(expected, { exact: true }).first()).toBeVisible();
    } finally {
      await context.close();
    }
  }
});

test('@t12 project hub survives long logs and narrow responsive tables without document overflow', async ({ userPage }) => {
  await userPage.setViewportSize({ width: 375, height: 812 });
  for (const view of ['overview', 'services', 'new-service', 'edit-service', 'deployments', 'agent', 'resources', 'new-resource', 'environment', 'logs', 'settings'] as const) {
    const serviceQuery = view === 'edit-service' || view === 'environment' ? '&serviceId=svc_fixture_web' : '';
    await userPage.goto(`${projectPath}?view=${view}${serviceQuery}`);
    const projectNavigation = userPage.locator('[data-project-nav-viewport]');
    await expect(projectNavigation).toBeVisible();
    expect(await projectNavigation.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await projectNavigation.locator(':scope > nav').evaluate((element) => getComputedStyle(element).position)).toBe('relative');
    await expect(projectNavigation.locator('[aria-current="page"]')).toBeInViewport();
    expect(await userPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${view} must not widen the document`).toBe(true);
  }
  await expect(userPage.getByRole('heading', { name: '프로젝트 삭제' })).toBeVisible();
  await userPage.goto(`${projectPath}?view=logs`);
  const runtimeLog = userPage.getByRole('log', { name: '런타임 로그' });
  await expect(runtimeLog).toContainText('배포 로그가 길어져도');
  await runtimeLog.focus();
  await expect(runtimeLog).toBeFocused();
  await userPage.goto(`${projectPath}?view=services`);
  await expect(userPage.getByText('svc_fixture_web')).toBeVisible();
});
