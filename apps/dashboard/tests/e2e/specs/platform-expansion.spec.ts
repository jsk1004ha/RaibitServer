import type { Page, Response, TestInfo } from '@playwright/test';
import { expect, test } from '../helpers/fixtures';
import { captureScreenshot, expectAccessible, FIXTURE_ORIGIN, installSession } from '../helpers/contracts';
import { PLATFORM_EXPANSION_EXECUTABLE_ROWS, PLATFORM_EXPANSION_MATRIX, PLATFORM_EXPANSION_NEGATIVE_ROWS, type PlatformExpansionRow } from '../feature-expansion-matrix';
import { createOutcomeRecorder, validatePlatformExpansionMatrix, writePlatformExpansionReport, type PlatformExpansionObservation, type PlatformExpansionSideEffects } from '../platform-expansion-report.js';

// allow: SIZE_OK — this bounded spec owns one module-scoped recorder lifecycle; splitting drivers would make report finalization order-dependent.

const evidencePath = process.env.RAIBITSERVER_PLATFORM_EXPANSION_REPORT_PATH;
const negativeIds = new Set(PLATFORM_EXPANSION_NEGATIVE_ROWS.map((row) => row.id));
const positives = PLATFORM_EXPANSION_EXECUTABLE_ROWS.filter((row) => !negativeIds.has(row.id));
const positiveRecorder = createOutcomeRecorder(positives, 'positive');
const negativeRecorder = createOutcomeRecorder(PLATFORM_EXPANSION_NEGATIVE_ROWS, 'negative');

function colorScheme(theme: PlatformExpansionRow['theme']): 'light' | 'dark' | 'no-preference' {
  return theme === 'system' ? 'no-preference' : theme;
}

async function openRow(page: Page, row: PlatformExpansionRow, waitUntil: 'load' | 'commit' = 'load'): Promise<Response> {
  await page.setViewportSize(row.viewport);
  await page.emulateMedia({ colorScheme: colorScheme(row.theme), reducedMotion: row.accessibility.includes('reduced-motion') ? 'reduce' : 'no-preference' });
  const response = await page.goto(row.route, { waitUntil });
  if (!response) throw new TypeError('platform_expansion_navigation_response_missing:' + row.id);
  if (row.zoom === 200) await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  expect(page.viewportSize()).toEqual(row.viewport);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  return response;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try { return redactSensitiveResponse(JSON.parse(text) as unknown); } catch { return { contentType: response.headers()['content-type'] ?? null, byteLength: new TextEncoder().encode(text).byteLength }; }
}

function redactSensitiveResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveResponse);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /(password|secret|token)/i.test(key) ? '[REDACTED]' : redactSensitiveResponse(entry)]));
}

async function httpObservation(response: Response, resultingState: unknown, sideEffects?: PlatformExpansionSideEffects, source: 'ui' | 'fixture' | 'combined' = 'ui'): Promise<PlatformExpansionObservation> {
  return {
    kind: 'http',
    request: { method: response.request().method(), url: response.request().url() },
    response: { status: response.status(), url: response.url(), body: await responseBody(response) },
    resultingState: { source, value: resultingState },
    ...(sideEffects ? { sideEffects } : {}),
  };
}

async function fixtureRequests(page: Page): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const response = await page.request.get(`${FIXTURE_ORIGIN}/__fixture/requests`);
  const body: unknown = await response.json();
  if (body === null || typeof body !== 'object' || !('requests' in body) || !Array.isArray(body.requests)) throw new TypeError('platform_expansion_fixture_requests_invalid');
  return body.requests.filter((entry): entry is Readonly<Record<string, unknown>> => entry !== null && typeof entry === 'object');
}

async function apiJson(page: Page, path: string): Promise<unknown> {
  const response = await page.request.get(new URL(path, 'http://console.localhost:3410').href);
  expect(response.ok()).toBe(true);
  return response.json();
}

function unchanged(before: unknown, after: unknown): PlatformExpansionSideEffects {
  expect(after).toEqual(before);
  return { unchanged: true, before, after };
}

async function record(page: Page, row: PlatformExpansionRow, testInfo: TestInfo, observation: PlatformExpansionObservation, recorder: ReturnType<typeof createOutcomeRecorder>): Promise<void> {
  await expectAccessible(page);
  const screenshot = row.representativeVisual ? await captureScreenshot(page, testInfo, 'task49-' + row.id) : undefined;
  recorder.record(row.id, { status: 'passed', observation, a11y: { violations: 0 }, representativeVisual: row.representativeVisual, screenshot });
}

async function runRow(row: PlatformExpansionRow, page: Page, testInfo: TestInfo, recorder: ReturnType<typeof createOutcomeRecorder>): Promise<void> {
  if (row.driver === 'auth-login') {
    await openRow(page, row);
    await page.getByLabel('이메일').fill('user@fixture.test');
    await page.getByLabel('비밀번호').fill('fixture-user-pass');
    const [response] = await Promise.all([
      page.waitForResponse((candidate) => candidate.url().includes('/api/control/auth/login') && candidate.request().method() === 'POST'),
      page.getByLabel('비밀번호').press('Enter'),
    ]);
    expect(response.status()).toBe(303);
    await expect(page).toHaveURL(/\/org\/raibit\/projects\?notice=saved$/);
    const location = response.headers().location;
    if (!location) throw new TypeError('platform_expansion_login_redirect_missing');
    const redirect = new URL(location, page.url());
    expect(redirect.origin).toBe(new URL(page.url()).origin);
    expect(`${redirect.pathname}${redirect.search}`).toBe('/org/raibit/projects?notice=saved');
    const observation: PlatformExpansionObservation = {
      kind: 'http', request: { method: response.request().method(), url: response.request().url() }, response: { status: response.status(), url: response.url(), body: { body: null, location: `${redirect.pathname}${redirect.search}` } },
      resultingState: { source: 'ui', value: { pathname: new URL(page.url()).pathname, notice: new URL(page.url()).searchParams.get('notice') } },
    };
    return record(page, row, testInfo, observation, recorder);
  }
  if (row.driver === 'loading-boundary') {
    await installSession(page.context(), 'fixture-user-populated');
    const response = await openRow(page, row, 'commit');
    const main = page.locator('main#main-content');
    await expect(main).toHaveAttribute('aria-busy', 'true');
    return record(page, row, testInfo, {
      kind: 'http',
      request: { method: response.request().method(), url: response.request().url() },
      response: { status: response.status(), url: response.url(), body: { headers: { contentType: response.headers()['content-type'] ?? null }, body: null } },
      resultingState: { source: 'ui', value: { ariaBusy: await main.getAttribute('aria-busy') } },
    }, recorder);
  }
  if (row.driver === 'empty-projects') {
    await installSession(page.context(), 'fixture-user-empty');
    const response = await openRow(page, row);
    await expect(page.getByRole('heading')).toBeVisible();
    return record(page, row, testInfo, await httpObservation(response, { heading: await page.getByRole('heading').first().innerText(), projectLinks: await page.getByRole('link').filter({ hasText: '프로젝트' }).count() }), recorder);
  }
  if (row.driver === 'github-disconnect' || row.driver === 'github-conflict' || row.driver === 'github-retryable') {
    const status = row.driver === 'github-conflict' ? 409 : row.driver === 'github-retryable' ? 503 : 200;
    if (status !== 200) await page.route('**/api/control/organizations/org_fixture_001/integrations/github/ghi_fixture/disconnect', (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: status === 409 ? 'stale_version' : 'unavailable' }) }));
    await openRow(page, row);
    const before = status === 200 ? null : await apiJson(page, '/api/control/integrations/github');
    await page.getByRole('checkbox', { name: 'RAIBITSERVER 연결 해제의 영향을 확인했습니다.' }).check();
    const responsePromise = page.waitForResponse((candidate) => candidate.url().includes('/disconnect') && candidate.request().method() === 'POST');
    await page.getByRole('button', { name: 'RAIBITSERVER 연결 해제' }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(status);
    if (status === 200) await expect(page.getByRole('status')).toContainText('RAIBITSERVER 연결이 해제되었습니다.');
    else {
      const alert = page.getByRole('alert').filter({ hasText: status === 409 ? '연결 상태가 변경되었습니다.' : '연결을 해제하지 못했습니다.' });
      await expect(alert).toBeVisible();
      await expect(page.getByRole('status')).not.toContainText('RAIBITSERVER 연결이 해제되었습니다.');
    }
    const after = status === 200 ? null : await apiJson(page, '/api/control/integrations/github');
    const sideEffects = status === 200 ? undefined : unchanged(before, after);
    return record(page, row, testInfo, await httpObservation(response, { alert: await page.getByRole('alert').allInnerTexts(), status: await page.getByRole('status').allInnerTexts() }, sideEffects), recorder);
  }
  if (row.driver === 'project-save' || row.driver === 'project-stale') {
    await openRow(page, row);
    await page.getByLabel('프로젝트 이름').fill(row.driver === 'project-save' ? 'Task49 변경 프로젝트' : '내 로컬 변경');
    if (row.driver === 'project-stale') expect(await page.evaluate(async () => (await fetch('/api/control/projects/prj_fixture_001/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedUpdatedAt: '2026-08-31T03:00:00.000Z', description: '동시 변경' }) })).status)).toBe(200);
    const before = row.driver === 'project-stale' ? await apiJson(page, '/api/control/projects/prj_fixture_001/settings') : null;
    const responsePromise = page.waitForResponse((candidate) => candidate.url().includes('/projects/prj_fixture_001/settings') && candidate.request().method() === 'PATCH');
    await page.getByRole('button', { name: '변경 사항 저장' }).click();
    const status = row.driver === 'project-save' ? 200 : 409;
    const response = await responsePromise;
    expect(response.status()).toBe(status);
    if (status === 200) await expect(page.getByText(/에 저장됨/)).toBeVisible();
    else {
      await expect(page.getByRole('button', { name: '최신 설정 불러오기' })).toBeVisible();
      await expect(page.getByLabel('프로젝트 이름')).toHaveValue('내 로컬 변경');
    }
    const after = await apiJson(page, '/api/control/projects/prj_fixture_001/settings');
    if (row.driver === 'project-save') expect(after).toMatchObject({ project: { name: 'Task49 변경 프로젝트' } });
    const sideEffects = row.driver === 'project-stale' ? unchanged(before, after) : undefined;
    return record(page, row, testInfo, await httpObservation(response, { persisted: after, draft: await page.getByLabel('프로젝트 이름').inputValue() }, sideEffects, 'combined'), recorder);
  }
  if (row.driver === 'project-delete-denied') {
    await openRow(page, row);
    const before = await apiJson(page, '/api/control/projects/prj_fixture_001/settings');
    await page.getByRole('button', { name: '삭제 요청' }).click();
    await page.getByRole('checkbox', { name: '영향과 복구 절차를 확인했습니다.' }).check();
    const responsePromise = page.waitForResponse((candidate) => candidate.url().includes('/settings/deletion') && candidate.request().method() === 'POST');
    await page.getByRole('button', { name: '삭제 요청 등록' }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(403);
    const alert = page.getByRole('alert').filter({ hasText: '이 작업을 수행할 권한이 없습니다.' });
    await expect(alert).toContainText('권한');
    await expect(page.getByText('삭제 요청이 대기열에 등록되었습니다.')).toHaveCount(0);
    const after = await apiJson(page, '/api/control/projects/prj_fixture_001/settings');
    return record(page, row, testInfo, await httpObservation(response, { alert: await alert.innerText(), deletionConfirmationCount: 0 }, unchanged(before, after)), recorder);
  }
  if (row.driver === 'service-preview') {
    await openRow(page, row);
    const before = (await fixtureRequests(page)).filter((request) => String(request.path).includes('/settings/preview'));
    await page.getByLabel('공통 상태 경로').fill('../health');
    await page.getByLabel('CPU 요청').fill('many');
    await expect(page.getByRole('button', { name: '빌드 계획 미리보기' })).toBeDisabled();
    const after = (await fixtureRequests(page)).filter((request) => String(request.path).includes('/settings/preview'));
    return record(page, row, testInfo, { kind: 'client', action: 'invalid-form-submit-blocked', networkRequests: 0, resultingState: { source: 'ui', value: { submitDisabled: true } }, sideEffects: unchanged(before, after) }, recorder);
  }
  if (row.driver === 'deployment-retry') {
    await openRow(page, row);
    await page.getByRole('button', { name: '재시도', exact: true }).click();
    const responsePromise = page.waitForResponse((candidate) => candidate.url().includes('/deployments/dep_fixture_failed/retry') && candidate.request().method() === 'POST');
    await page.getByRole('button', { name: '재시도 요청', exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(202);
    await expect(page.getByText('새 배포:')).toContainText('dep_fixture_retry_successor');
    return record(page, row, testInfo, await httpObservation(response, { successor: await page.getByText('새 배포:').innerText() }), recorder);
  }
  if (row.driver === 'stream-switch' || row.driver === 'stream-degraded') {
    const mutationRequestsBefore = (await fixtureRequests(page)).filter((request) => request.method !== 'GET');
    const switchedStreamResponse = row.driver === 'stream-switch'
      ? page.waitForResponse((response) => response.url().includes('/services/svc_fixture_web/logs/stream') && response.request().method() === 'GET')
      : null;
    let failedRequest: Promise<Readonly<{ method: string; url: string; error: string }>> | null = null;
    if (row.driver === 'stream-degraded') {
      failedRequest = page.waitForEvent('requestfailed', (request) => request.url().includes('/services/svc_fixture_worker/logs/stream')).then((request) => ({ method: request.method(), url: request.url(), error: request.failure()?.errorText ?? 'request_failed' }));
      await page.route('**/api/control/services/svc_fixture_worker/logs/stream', (route) => route.abort());
    }
    await openRow(page, row);
    if (row.driver === 'stream-degraded') {
      await expect(page.locator('[data-runtime-log-status="fallback"]')).toBeVisible({ timeout: 20_000 });
      if (!failedRequest) throw new TypeError('platform_expansion_failed_request_missing');
      const failure = await failedRequest;
      const mutationRequestsAfter = (await fixtureRequests(page)).filter((request) => request.method !== 'GET');
      return record(page, row, testInfo, { kind: 'network-error', request: { method: failure.method, url: failure.url }, error: failure.error, resultingState: { source: 'ui', value: { runtimeLogStatus: await page.locator('[data-runtime-log-status="fallback"]').getAttribute('data-runtime-log-status') } }, sideEffects: unchanged(mutationRequestsBefore, mutationRequestsAfter) }, recorder);
    }
    await page.getByLabel('로그 서비스').selectOption('svc_fixture_web');
    if (!switchedStreamResponse) throw new TypeError('platform_expansion_stream_response_missing');
    const response = await switchedStreamResponse;
    await expect(page.getByRole('log', { name: '런타임 로그' })).toContainText('web-only-initial-log');
    await expect.poll(async () => (await page.request.get('http://127.0.0.1:3411/__fixture/requests')).json()).toMatchObject({ requests: expect.arrayContaining([expect.objectContaining({ path: '/api/services/svc_fixture_worker/logs/stream', streamClosed: true })]) });
    const streamRequests = (await fixtureRequests(page)).filter((request) => request.path === '/api/services/svc_fixture_worker/logs/stream');
    const latest = streamRequests.at(-1);
    if (!latest || latest.method !== 'GET') throw new TypeError('platform_expansion_stream_observation_missing');
    const renderedLog = await page.getByRole('log', { name: '런타임 로그' }).innerText();
    return record(page, row, testInfo, {
      kind: 'http', request: { method: response.request().method(), url: response.request().url() },
      response: { status: response.status(), url: response.url(), body: { contentType: response.headers()['content-type'] ?? null, renderedEventData: renderedLog } },
      resultingState: { source: 'ui', value: { selectedService: await page.getByLabel('로그 서비스').inputValue(), log: renderedLog, priorStreamClosed: latest.streamClosed === true } },
    }, recorder);
  }
  if (row.driver === 'resource-restore') {
    await openRow(page, row);
    await page.getByTestId('backup-row-bak_fixture_ready').getByRole('button', { name: '복구 준비' }).click();
    await page.getByLabel('새 리소스 이름').fill('task49-restored');
    const [response] = await Promise.all([
      page.waitForResponse((candidate) => candidate.url().includes('/backups/bak_fixture_ready/restores') && candidate.request().method() === 'POST'),
      page.getByRole('button', { name: '복구 요청', exact: true }).click(),
    ]);
    expect(response.status()).toBe(202);
    const acceptedRestore = await responseBody(response);
    if (acceptedRestore === null || typeof acceptedRestore !== 'object' || !('id' in acceptedRestore) || typeof acceptedRestore.id !== 'string' || !('targetResourceId' in acceptedRestore) || typeof acceptedRestore.targetResourceId !== 'string') throw new TypeError('platform_expansion_restore_response_invalid');
    await expect(page.getByRole('status')).toContainText(acceptedRestore.targetResourceId);
    const stateResponse = await page.request.get(`${FIXTURE_ORIGIN}/__fixture/state`);
    expect(stateResponse.ok()).toBe(true);
    const persistedRestore: unknown = await stateResponse.json();
    expect(persistedRestore).toMatchObject({ resourceRestores: [{ id: acceptedRestore.id, targetResourceId: acceptedRestore.targetResourceId, requestedName: 'task49-restored', status: 'QUEUED' }] });
    return record(page, row, testInfo, await httpObservation(response, { persistedRestore, statusText: await page.getByRole('status').innerText() }, undefined, 'combined'), recorder);
  }
  if (row.driver === 'custom-domain-create') {
    await openRow(page, row);
    await expect(page.getByRole('link', { name: '생성된 서비스 URL 새 창에서 열기' })).toBeVisible();
    await page.getByRole('button', { name: '사용자 도메인 추가' }).click();
    await page.getByLabel('호스트 이름').fill('task49.fixture.example');
    const responsePromise = page.waitForResponse((candidate) => candidate.url().includes('/projects/prj_fixture_001/domains') && candidate.request().method() === 'POST');
    await page.getByRole('button', { name: 'TXT 검증 값 만들기' }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    await page.getByRole('button', { name: 'TXT 값을 확인했습니다' }).click();
    await expect(page.getByText('이번에만 표시하는 DNS TXT 값')).toHaveCount(0);
    const persisted = await apiJson(page, '/api/control/projects/prj_fixture_001/domains');
    expect(persisted).toMatchObject({ domains: expect.arrayContaining([expect.objectContaining({ hostname: 'task49.fixture.example' })]) });
    return record(page, row, testInfo, await httpObservation(response, { persisted, oneTimeProofVisible: false }, undefined, 'combined'), recorder);
  }
  throw new TypeError('platform_expansion_unknown_driver:' + row.id);
}

function pageFor(row: PlatformExpansionRow, pages: Readonly<{ page: Page; userPage: Page; adminPage: Page }>): Page {
  if (row.actor === 'anonymous') return pages.page;
  if (row.actor === 'user') return pages.userPage;
  if (row.actor === 'admin') return pages.adminPage;
  throw new TypeError('platform_expansion_unknown_actor:' + row.id);
}

function register(rows: readonly PlatformExpansionRow[], recorder: ReturnType<typeof createOutcomeRecorder>): void {
  for (const row of rows) test('@platform-expansion ' + row.id, async ({ page, userPage, adminPage }, testInfo) => {
    const selectedPage = pageFor(row, { page, userPage, adminPage });
    expect((await selectedPage.request.post(`${FIXTURE_ORIGIN}/__fixture/reset`)).ok()).toBe(true);
    await runRow(row, selectedPage, testInfo, recorder);
  });
}

test.describe('@platform-expansion', () => {
  test.beforeAll(() => { validatePlatformExpansionMatrix(PLATFORM_EXPANSION_MATRIX); });
  register(positives, positiveRecorder);
  test.afterAll(async () => {
    if (!evidencePath) throw new TypeError('RAIBITSERVER_PLATFORM_EXPANSION_REPORT_PATH is required');
    await writePlatformExpansionReport(positiveRecorder.finish(), evidencePath);
  });
});
test.describe('@platform-expansion-negative', () => {
  register(PLATFORM_EXPANSION_NEGATIVE_ROWS, negativeRecorder);
  test.afterAll(async () => {
    if (!evidencePath) throw new TypeError('RAIBITSERVER_PLATFORM_EXPANSION_REPORT_PATH is required');
    await writePlatformExpansionReport(negativeRecorder.finish(), evidencePath);
  });
});
