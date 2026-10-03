import { expect, test } from '../helpers/fixtures';
import { FIXTURE_ORIGIN, captureScreenshot, expectAccessible } from '../helpers/contracts';

const fixtureEnabled = process.env.RAIBITSERVER_E2E_FIXTURES === '1';
const path = '/org/raibit/projects/prj_fixture_001?view=templates';
const installationsPath = '/api/control/projects/prj_fixture_001/template-installations';
const catalogTitles = ['Discord 봇', 'FastAPI', 'Next.js + PostgreSQL'];

test.describe('@template-installations', () => {
  test.skip(!fixtureEnabled, 'requires RAIBITSERVER_E2E_FIXTURES=1');

  test.beforeEach(async ({ request }) => {
    expect((await request.post(`${FIXTURE_ORIGIN}/__fixture/reset`)).ok()).toBe(true);
  });

  test('server-rendered controls wait for hydration before accepting an environment choice', async ({ adminPage }) => {
    let releaseScripts!: () => void;
    const scriptsReady = new Promise<void>((resolve) => { releaseScripts = resolve; });
    await adminPage.route('**/_next/static/**', async (route) => {
      if (route.request().resourceType() === 'script') await scriptsReady;
      await route.continue();
    });
    const environment = adminPage.getByLabel('설치 환경');
    try {
      await adminPage.goto(path, { waitUntil: 'commit' });
      await expect(environment).toBeVisible();
      await expect(environment).toBeDisabled();
      const starters = adminPage.getByRole('button', { name: /^설치 준비/ });
      await expect(starters).toHaveCount(3);
      for (const starter of await starters.all()) await expect(starter).toBeDisabled();
      await expect(adminPage.getByRole('button', { name: '설치 상태 새로고침' })).toBeDisabled();
    } finally {
      releaseScripts();
    }
    await environment.selectOption('env_fixture_dev');
    await adminPage.getByTestId('template-card-fastapi').getByRole('button', { name: '설치 준비' }).click();
    const response = adminPage.waitForResponse((entry) => new URL(entry.url()).pathname === `${installationsPath}/preflight` && entry.request().method() === 'POST');
    await adminPage.getByRole('button', { name: '구성 확인', exact: true }).click();
    expect(new URL((await response).url()).searchParams.get('environmentId')).toBe('env_fixture_dev');
    await expect(environment).toHaveValue('env_fixture_dev');
  });

  test('all three starter cards are labelled, accessible, and fit mobile and desktop', async ({ adminPage }, testInfo) => {
    for (const viewport of [{ width: 375, height: 812 }, { width: 1280, height: 800 }]) {
      await adminPage.setViewportSize(viewport);
      await adminPage.goto(path);
      for (const title of catalogTitles) await expect(adminPage.getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect(adminPage.getByRole('button', { name: /^설치 준비/ })).toHaveCount(3);
      await expect(adminPage.getByLabel('설치 환경')).toHaveValue('env_fixture_prod');
      await adminPage.getByTestId('template-card-next-postgres').getByRole('button', { name: '설치 준비' }).click();
      await expect(adminPage.getByRole('heading', { name: 'Next.js + PostgreSQL 설치', exact: true })).toBeVisible();
      expect(await adminPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await expectAccessible(adminPage);
      await captureScreenshot(adminPage, testInfo, `templates-${viewport.width < 600 ? 'mobile' : 'desktop'}`);
    }
  });

  test('secret inputs stay in POST bodies, clear after acceptance, and persisted failures can retry after reload', async ({ adminPage, request }) => {
    const consoleMessages: string[] = [];
    adminPage.on('console', (entry) => consoleMessages.push(entry.text()));
    await request.post(`${FIXTURE_ORIGIN}/__fixture/templates`, { data: { installStatus: 'failed' } });
    await adminPage.goto(path);
    await adminPage.getByLabel('설치 환경').selectOption('env_fixture_dev');
    await adminPage.getByTestId('template-card-discord-bot').getByRole('button', { name: '설치 준비' }).click();
    const secret = 'fixture-discord-secret-post-body-only';
    const password = adminPage.getByLabel('DISCORD_TOKEN', { exact: true });
    await expect(password).toHaveAttribute('type', 'password');
    await password.fill(secret);
    const previewResponse = adminPage.waitForResponse((response) => new URL(response.url()).pathname === `${installationsPath}/preflight` && response.request().method() === 'POST');
    await adminPage.getByRole('button', { name: '구성 확인', exact: true }).click();
    const preview = await previewResponse;
    expect(preview.status()).toBe(200);
    const previewBody = preview.request().postDataJSON();
    expect(previewBody).toMatchObject({ requiredProtocolVersion: 2, catalogId: 'discord-bot', catalogVersion: 'v1', inputs: { DISCORD_TOKEN: secret } });
    expect(previewBody.catalogDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(previewBody.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(new URL(preview.url()).searchParams.get('environmentId')).toBe('env_fixture_dev');
    expect(await preview.text()).not.toContain(secret);
    expect(await adminPage.locator('body').innerText()).not.toContain(secret);
    expect(await adminPage.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(secret);
    expect(adminPage.url()).not.toContain(secret);

    const installResponse = adminPage.waitForResponse((response) => new URL(response.url()).pathname === installationsPath && response.request().method() === 'POST');
    await adminPage.getByRole('button', { name: '설치 및 배포', exact: true }).click();
    const installed = await installResponse;
    expect(installed.status()).toBe(202);
    expect(installed.request().postDataJSON()).toEqual(previewBody);
    expect(new URL(installed.url()).searchParams.get('environmentId')).toBe('env_fixture_dev');
    expect(await installed.text()).not.toContain(secret);
    await expect(password).toHaveValue('');
    expect(await adminPage.content()).not.toContain(secret);
    const recorded = await (await request.get(`${FIXTURE_ORIGIN}/__fixture/requests`)).json();
    expect(JSON.stringify(recorded)).not.toContain(secret);
    const submitted = recorded.requests.filter((entry: { path: string; method: string }) => entry.path === '/api/projects/prj_fixture_001/template-installations' && entry.method === 'POST').at(-1);
    expect(submitted.body.inputs).toEqual({ DISCORD_TOKEN: '[MASKED]' });

    await adminPage.reload();
    await adminPage.getByLabel('설치 환경').selectOption('env_fixture_dev');
    await expect(adminPage.getByRole('heading', { name: '설치 내역', exact: true })).toBeVisible();
    const installation = adminPage.getByTestId('template-installation-tpl_fixture_1');
    await expect(installation).toBeVisible();
    await expect(installation.getByRole('link', { name: /^배포 상세/ })).toHaveAttribute('href', /dep_fixture_failed\?environmentId=env_fixture_dev$/);
    const retryResponse = adminPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/control/template-installations/tpl_fixture_1/retry' && response.request().method() === 'POST');
    await installation.getByRole('button', { name: '다시 시도', exact: true }).click();
    const retried = await retryResponse;
    expect(retried.status()).toBe(202);
    expect(new URL(retried.url()).searchParams.get('environmentId')).toBe('env_fixture_dev');
    expect(retried.request().postDataJSON()).toEqual({ requiredProtocolVersion: 2, expectedVersion: 1, requestIdempotencyKey: expect.any(String) });
    expect(await retried.json()).toMatchObject({ progress: { status: 'building' } });
    await expect(installation.getByRole('button', { name: '다시 시도', exact: true })).toHaveCount(0);
    const refreshed = adminPage.waitForResponse((response) => new URL(response.url()).pathname === installationsPath && response.request().method() === 'GET');
    await adminPage.getByRole('button', { name: '설치 상태 새로고침', exact: true }).click();
    expect((await refreshed).ok()).toBe(true);
    expect(await adminPage.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(secret);
    expect(consoleMessages.join('\n')).not.toContain(secret);
  });

  test('preflight conflicts prevent installation and disabled activation prevents starting any starter', async ({ adminPage, request }) => {
    await request.post(`${FIXTURE_ORIGIN}/__fixture/templates`, { data: { preflightConflict: true } });
    await adminPage.goto(path);
    await adminPage.getByTestId('template-card-fastapi').getByRole('button', { name: '설치 준비' }).click();
    const installs: string[] = [];
    adminPage.on('request', (entry) => { if (new URL(entry.url()).pathname === installationsPath && entry.method() === 'POST') installs.push(entry.url()); });
    const previewResponse = adminPage.waitForResponse((response) => new URL(response.url()).pathname === `${installationsPath}/preflight` && response.request().method() === 'POST');
    await adminPage.getByRole('button', { name: '구성 확인', exact: true }).click();
    const conflict = await previewResponse;
    expect(conflict.status()).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'TEMPLATE_SLUG_CONFLICT' });
    await expect(adminPage.getByRole('alert').filter({ hasText: '같은 환경에 동일한 이름' })).toBeVisible();
    await expect(adminPage.getByRole('button', { name: '설치 및 배포', exact: true })).toHaveCount(0);
    expect(installs).toEqual([]);

    await request.post(`${FIXTURE_ORIGIN}/__fixture/templates`, { data: { enabled: false, preflightConflict: false } });
    await adminPage.reload();
    const starters = adminPage.getByRole('button', { name: /^설치 준비/ });
    await expect(starters).toHaveCount(3);
    for (const starter of await starters.all()) await expect(starter).toBeDisabled();
    await expectAccessible(adminPage);
  });

  test('transport uncertainty reuses the submission key while an edited secret receives a fresh key', async ({ adminPage }) => {
    const bodies: Array<{ requestIdempotencyKey: string; inputs: { DISCORD_TOKEN: string } }> = [];
    await adminPage.route(`**${installationsPath}?*`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      bodies.push(route.request().postDataJSON());
      if (bodies.length <= 2) {
        const target = new URL(route.request().url());
        const host = target.host;
        target.hostname = '127.0.0.1';
        expect((await route.fetch({ url: target.href, headers: { ...await route.request().allHeaders(), host } })).status()).toBe(202);
      }
      return route.abort('failed');
    });
    await adminPage.goto(path);
    await adminPage.getByTestId('template-card-discord-bot').getByRole('button', { name: '설치 준비' }).click();
    await adminPage.getByLabel('DISCORD_TOKEN', { exact: true }).fill('fixture-discord-original');
    await adminPage.getByRole('button', { name: '구성 확인', exact: true }).click();
    const install = adminPage.getByRole('button', { name: '설치 및 배포', exact: true });
    await expect(install).toBeEnabled();
    await install.click();
    await expect(adminPage.getByRole('alert').filter({ hasText: '요청 결과를 확인하지 못했습니다.' })).toBeVisible();
    await expect(install).toBeEnabled();
    await install.click();
    await expect.poll(() => bodies.length).toBe(2);
    await expect(install).toBeEnabled();
    expect(bodies[0].requestIdempotencyKey).toBe(bodies[1].requestIdempotencyKey);
    expect(bodies[0]).toEqual(bodies[1]);
    const persisted = await adminPage.evaluate(async (url) => {
      const response = await fetch(url);
      return { status: response.status, body: await response.json() };
    }, `${installationsPath}?environmentId=env_fixture_prod`);
    expect(persisted.status).toBe(200);
    expect(persisted.body.installations).toHaveLength(1);

    await adminPage.getByLabel('DISCORD_TOKEN', { exact: true }).fill('fixture-discord-edited');
    await expect(install).toHaveCount(0);
    await adminPage.getByRole('button', { name: '구성 확인', exact: true }).click();
    await expect(install).toBeEnabled();
    await install.click();
    await expect.poll(() => bodies.length).toBe(3);
    expect(bodies[2].requestIdempotencyKey).not.toBe(bodies[1].requestIdempotencyKey);
    expect(bodies[2].inputs.DISCORD_TOKEN).toBe('fixture-discord-edited');
    await expect(install).toBeEnabled();
  });
});
