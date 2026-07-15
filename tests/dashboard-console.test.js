import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';

test('dashboard project detail is API-backed instead of hardcoded prototype arrays', async () => {
  const detail = await fs.readFile(new URL('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(detail, /const\s+services\s*=\s*\[/);
  assert.doesNotMatch(detail, /const\s+resources\s*=\s*\[/);
  for (const marker of ['loadProjectConsole', '/deployments', '/console/schema', '/console/query', 'sourceType', 'imageUrl', 'dockerfilePath', '서비스 만들기', '리소스 추가', '운영 환경에 배포', '미리보기 배포', '빌드 로그', '런타임 로그']) {
    assert.ok(detail.includes(marker), `${marker} missing from project console page`);
  }
});

test('dashboard exposes auth, admin, GitHub, deployment log, and resource console pages wired to API routes', async () => {
  const files = await Promise.all([
    fs.readFile(new URL('../apps/dashboard/app/login/page.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/app/admin/page.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/app/github/page.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx', import.meta.url), 'utf8'),
  ]);
  const combined = files.join('\n');
  for (const marker of ['/auth/login', '/auth/signup', '/auth/email/verify', '/auth/email/resend', '/auth/github/login', '/auth/github/callback', '/admin/users/', '/github/repositories/import', '/github/repositories/:repositoryId/sync', '/projects/:projectId/services/:serviceId/github', '/integrations/github', '웹훅 / 미리보기 계약', '/deployments/', '/cancel', '/rollback', 'imageDigest', 'errorCode', '/console/query', '/console/command', '/console/tables', '/console/keys', '/provision', '/attach', 'confirmed', '배포 상세', '상태와 이미지', '빌드 로그', '배포 이벤트', '롤백 확인', '배포 취소', '리소스 콘솔', '스키마', '쿼리', '백업', '연결', '자격 증명 교체', '공급자 명령 실행', '프로비저닝 계획 만들기', '서비스에 연결', '저장소 연결과 미리보기 배포', 'GitHub 연결', '저장소 가져오기', '서비스에 저장소 연결', '저장소 정보 동기화', '사용자 관리', '클럽 회원으로 승인', '일반 사용자로 승인', '할당량 저장', '가입 신청', '이메일 인증', '인증 코드 다시 보내기', 'GitHub로 계속하기', 'GitHub OAuth 연결은 준비 중입니다.', '연결할 서비스가 없습니다.', '동기화할 저장소가 없습니다.']) {
    assert.ok(combined.includes(marker), `${marker} missing from dashboard routes`);
  }
  assert.doesNotMatch(files[3], /\/deployments\/\$\{deploymentId\}\/status/, 'tenant dashboard must not expose worker-owned deployment status mutation');
  assert.match(files[3], /cancellationAllowed[\s\S]*?QUEUED[\s\S]*?BUILDING[\s\S]*?IMAGE_READY/);
  assert.match(files[3], /실행 중이거나 완료된 배포는 롤백 또는 서비스 삭제를 사용하세요/);
});

test('dashboard avoids default workspace link and aggregates logs across deployments/services', async () => {
  const home = await fs.readFile(new URL('../apps/dashboard/app/page.tsx', import.meta.url), 'utf8');
  const api = await fs.readFile(new URL('../apps/dashboard/lib/api.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(home, /href="\/org\/default\/projects\/new"/);
  for (const marker of ['createOrgSlug', 'buildLogResults', 'deploymentEventResults', 'runtimeLogResults']) {
    assert.ok(`${home}\n${api}`.includes(marker), `${marker} missing from dashboard API-backed log aggregation`);
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
