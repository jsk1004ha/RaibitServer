import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';

test('dashboard project detail is API-backed instead of hardcoded prototype arrays', async () => {
  const [detail, hub, services, operations] = await Promise.all([
    fs.readFile(new URL('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/components/project-hub/project-hub.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/components/project-hub/services.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/components/project-hub/operations.tsx', import.meta.url), 'utf8'),
  ]);
  const projectFeatures = `${detail}\n${hub}\n${services}\n${operations}`;
  assert.doesNotMatch(detail, /const\s+services\s*=\s*\[/);
  assert.doesNotMatch(detail, /const\s+resources\s*=\s*\[/);
  for (const marker of ['loadProjectConsole', 'projectMainLink', 'ProjectHub', '/deployments', '/console', 'sourceType', 'imageUrl', 'dockerfilePath', '서비스 만들기', '리소스 추가', '운영 배포', '미리보기', '런타임 로그']) {
    assert.ok(projectFeatures.includes(marker), `${marker} missing from project console feature set`);
  }
  assert.match(detail, /organizationSlug:\s*state\.project\.organizationSlug\s*\|\|\s*state\.project\.organization\?\.slug/);
  assert.doesNotMatch(detail, /organizationSlug:[^\n]*\|\|\s*orgSlug/);
  assert.match(detail, /const organizationLabel = state\.project\.organization\?\.name \|\| state\.project\.organizationSlug \|\| '내 조직'/);
  assert.ok(detail.includes('orgRouteValue={orgSlug}'));
  assert.ok(detail.includes('orgValue={organizationLabel}'));
});

test('dashboard exposes public, authenticated, admin, GitHub, deployment, and resource routes', async () => {
  const [login, controlRoute, requestSecurity, admin, github, githubInstall, githubCallback, guide, deployment, deploymentRecovery, resource, contributors, proxy, shell] = await Promise.all([
    fs.readFile(new URL('../apps/dashboard/app/login/page.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/app/api/control/[...path]/route.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/lib/request-security.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/app/admin/page.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/app/github/page.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/app/github/install/route.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/app/github/callback/route.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/app/guide/page.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/components/project-hub/deployment-recovery-action.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/app/contributors/page.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/proxy.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/components/console-ui.tsx', import.meta.url), 'utf8'),
  ]);
  for (const marker of ['/auth/login', '/auth/signup', '/auth/email/verify', '/auth/email/resend']) {
    assert.ok(login.includes(marker), `${marker} missing from login screen`);
  }
  for (const marker of ['PUBLIC_POST_PATHS', '/auth/login', '/auth/signup', '/auth/email/verify', '/auth/email/resend', 'SESSION_COOKIE_NAME', 'projectCreatePayloadFromForm', 'formMutationMethod']) {
    assert.ok(controlRoute.includes(marker), `${marker} missing from same-origin control route`);
  }
  assert.ok(requestSecurity.includes("SESSION_COOKIE_NAME = 'raibitserver_session'"));
  assert.match(proxy, /isProtectedPage[\s\S]*?\/console[\s\S]*?\/admin[\s\S]*?\/github[\s\S]*?\/guide[\s\S]*?\/org/);
  assert.match(proxy, /request\.cookies\.get\(SESSION_COOKIE_NAME\)/);
  assert.match(shell, /getJson\('\/auth\/me'/);
  assert.match(shell, /String\(user\?\.role \|\| subject\?\.userRole \|\| ''\)\.toUpperCase\(\) === 'ADMIN'/);
  assert.doesNotMatch(`${login}\n${controlRoute}\n${shell}`, /\/api\/(?:session|control-plane)/);

  for (const marker of ['/admin/users/', '가입 신청 확인', '클럽 회원 승인', '일반 사용자 승인', '거절 확인']) {
    assert.ok(admin.includes(marker), `${marker} missing from admin screen`);
  }
  for (const marker of ['/github/install', '/github/repositories/import', '/projects/${firstService.projectId}/services/${firstService.id}/github', '/github/repositories/${encodeURIComponent(selectedRepository.fullName)}/sync', '저장소 선택', '연결할 서비스와 저장소가 필요합니다.', '동기화할 저장소가 없습니다.']) {
    assert.ok(github.includes(marker), `${marker} missing from GitHub screen`);
  }
  for (const [name, route] of [['install', githubInstall], ['callback', githubCallback]]) {
    for (const marker of ['consoleOriginHref', 'dashboardRequestUrl', 'RAIBITSERVER_CONSOLE_URL', "request.headers.get('host')", "request.headers.get('x-forwarded-proto')"]) {
      assert.ok(route.includes(marker), `${name} GitHub route must derive redirects from the public console origin: ${marker}`);
    }
    assert.doesNotMatch(route, /new URL\('\/github', request\.url\)/, `${name} GitHub route must not expose the internal Next.js bind origin`);
  }
  for (const marker of ['GITHUB_INSTALL_STATE_COOKIE_NAME', 'githubInstallStateCookieOptions', "installUrl.searchParams.get('state')", 'response.cookies.set']) {
    assert.ok(githubInstall.includes(marker), `GitHub install route must persist setup state: ${marker}`);
  }
  for (const marker of ['GITHUB_INSTALL_STATE_COOKIE_NAME', 'githubInstallStateCookieOptions', 'request.cookies.get', 'installState', 'maxAge: 0']) {
    assert.ok(githubCallback.includes(marker), `GitHub callback must recover and clear setup state: ${marker}`);
  }
  assert.ok(guide.includes('사용 안내'));
  for (const marker of ['imageDigest', 'errorCode', '배포 상세', '이미지 정보', '빌드 로그', '배포 이벤트']) {
    assert.ok(deployment.includes(marker), `${marker} missing from deployment screen`);
  }
  assert.match(deployment, /<DeploymentRecoveryAction action=\{history\.eligibleAction\}/);
  assert.match(deploymentRecovery, /action=\{`\/api\/control\$\{action\.href\}`\}/);
  assert.match(deploymentRecovery, /action\.type === 'rollback' \? <input name="confirmed" type="hidden" value="true"/);
  assert.doesNotMatch(deployment, /\/deployments\/\$\{deploymentId\}\/status/, 'tenant dashboard must not expose worker-owned deployment status mutation');
  assert.match(deployment, /history\?\.permissions\.execute && history\.eligibleAction/);
  const provisioning = await fs.readFile(new URL('../apps/dashboard/components/resource-provision-actions.tsx', import.meta.url), 'utf8');
  assert.ok(provisioning.includes('계획 미리보기'));
  assert.ok(provisioning.includes('실제 실행 요청'));
  for (const marker of ['/console/query', '/console/command', '/provision', '/attach', 'confirmed', '리소스 콘솔', '데이터 구조', '쿼리', '백업', '연결', '공급자 명령 실행', 'ResourceProvisionActions', '서비스에 연결']) {
    assert.ok(resource.includes(marker), `${marker} missing from resource screen`);
  }
  for (const marker of ['2309', '김준서', 'teacher', '최희진']) assert.ok(contributors.includes(marker));
});

test('dashboard avoids default workspace links and defers detail-only console data', async () => {
  const consolePage = await fs.readFile(new URL('../apps/dashboard/app/console/page.tsx', import.meta.url), 'utf8');
  const api = await fs.readFile(new URL('../apps/dashboard/lib/api.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(consolePage, /href="\/org\/default\/projects\/new"/);
  assert.ok(consolePage.includes('createOrgSlug'));
  for (const eagerMarker of ['buildLogResults', 'deploymentEventResults', 'runtimeLogResults', 'resourceConsoles']) {
    assert.ok(!api.includes(eagerMarker), `${eagerMarker} should be loaded only by its focused detail screen`);
  }
});

test('prototype API accepts dashboard HTML form posts for create and deploy actions', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const org = controlPlane.store.createOrganization({ name: 'Form Org', slug: 'form-org' });
  const project = controlPlane.store.createProject({ organizationId: org.id, name: 'Form Project', slug: 'form-project' });
  const handler = createApiHandler(controlPlane, { auth: { mode: 'disabled', allowDisabled: true, defaultRole: 'owner' } });
  const serviceReq = formRequest(`/projects/${project.id}/services`, { name: 'web', type: 'web', repoUrl: 'https://github.com/alice/web.git' });
  const serviceRes = captureResponse();
  await handler(serviceReq, serviceRes);
  assert.equal(serviceRes.statusCode, 201);
  const service = JSON.parse(serviceRes.body);
  assert.equal(service.name, 'web');

  const deploymentReq = formRequest(`/projects/${project.id}/services/${service.id}/deployments`, { deploymentType: 'preview' });
  const deploymentRes = captureResponse();
  await handler(deploymentReq, deploymentRes);
  assert.equal(deploymentRes.statusCode, 202);
  const deployment = JSON.parse(deploymentRes.body);
  assert.equal(deployment.deploymentType, 'preview');
});

function formRequest(path, values) {
  const body = new URLSearchParams(values).toString();
  return {
    url: path,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  };
}

function captureResponse() {
  return {
    statusCode: 0,
    body: '',
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; },
    end(payload) { this.body = payload; },
  };
}
