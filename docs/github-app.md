# GitHub App 연동

GitHub App은 저장소 선택, private clone, push 배포, PR preview를 연결합니다. 사용자는 토큰이나 installation ID를 직접 입력하지 않습니다.

## 사용자 흐름

```txt
GitHub 연결
→ 계정 선택
→ 허용 저장소 선택
→ 사용자 권한 확인
→ 콘솔 저장소 선택
→ 프로젝트로 가져오기
```

설치 URL의 서명된 `state`는 로그인 사용자와 조직에 묶입니다. 설치 후 받은 `installation_id`는 그대로 신뢰하지 않습니다. 서버가 일회용 OAuth code를 user access token으로 교환하고, 그 사용자가 해당 설치에 접근할 수 있는지 확인한 뒤 저장소 목록을 교체합니다. 확인용 user token은 즉시 폐기합니다.

## GitHub App 설정

| 항목 | 값 |
| --- | --- |
| Callback URL | `https://console.<BASE_DOMAIN>/github/callback` |
| Setup URL | `https://console.<BASE_DOMAIN>/github/callback` |
| Request user authorization during installation | 끔 |
| Redirect on update | 켬 |
| Repository permission: Contents | Read-only |
| Webhook URL | `https://api.<BASE_DOMAIN>/api/github/webhooks` |
| Webhook events | `push`, `pull_request`, `installation`, `installation_repositories` |

RAIBITSERVER는 Setup URL에서 installation ID를 받은 뒤 별도 OAuth authorization으로 이동합니다. 따라서 GitHub App 설정의 “Request user authorization during installation”은 켜지 않습니다. 기존 설치의 저장소 선택을 바꿀 때도 Setup URL로 돌아오도록 “Redirect on update”는 켭니다.

GitHub가 기존 설치의 Configure 링크에서 설치용 `state` 쿼리를 제거할 수 있으므로 Dashboard는 연결 시작 시 같은 서명값을 host-only, HttpOnly, SameSite=Lax 쿠키에도 보관합니다. 이 쿠키는 `/github/callback`에만 전송되고 OAuth 단계가 시작되면 즉시 삭제됩니다. API는 로그인 사용자와 조직 scope 및 새 OAuth proof를 계속 확인합니다.

## API runtime Secret

API가 참조하는 `runtimeSecrets.existingSecret`에 다음 키를 둡니다.

```txt
RAIBITSERVER_GITHUB_APP_SLUG
RAIBITSERVER_GITHUB_CLIENT_ID
RAIBITSERVER_GITHUB_CLIENT_SECRET
RAIBITSERVER_GITHUB_CALLBACK_URL=https://console.<BASE_DOMAIN>/github/callback
RAIBITSERVER_GITHUB_WEBHOOK_SECRET
```

`RAIBITSERVER_GITHUB_STATE_SECRET`은 선택입니다. 생략하면 32바이트 이상인 `RAIBITSERVER_AUTH_JWT_SECRET`을 사용합니다. client secret, state secret, webhook secret은 로그나 Helm values에 적지 않습니다.

로컬 개발에서는 `http://localhost:<PORT>/github/callback`도 허용됩니다. production callback은 반드시 HTTPS여야 합니다.

## Builder Secret

private 저장소를 빌드하려면 App ID와 GitHub가 발급한 RSA private key를 dispatcher 전용 Secret으로 만듭니다.

```sh
kubectl -n raibitserver-system create secret generic raibitserver-github-app-builder \
  --from-literal=app-id='<numeric-app-id>' \
  --from-file=private-key.pem='./github-app.private-key.pem'
```

production values에는 Secret 이름만 기록합니다.

```yaml
builder:
  githubAppCredentials:
    enabled: true
    existingSecret: raibitserver-github-app-builder
```

private key는 DB 연결이 있는 trusted dispatcher에만 mount됩니다. disposable executor는 mTLS 세션으로 자기 서비스의 정확한 installation ID와 repository ID를 요청합니다. dispatcher는 control-plane의 authoritative binding을 다시 확인하고 GitHub에 `repository_ids: [<exact-id>]`로 짧은 수명의 installation token을 요청합니다.

## 소스 접근 정책

- 공개 저장소: `builder.anonymousGit.enabled=true`일 때만 production 익명 clone 허용
- 비공개 저장소: verified installation + catalog repository + dispatcher credential broker 필수
- credential 포함 URL, shared `GIT_ASKPASS`, global credential helper: 거부
- installation token: clone subprocess 환경의 transient Git header에만 전달
- token이 있는 clone 출력: 저장하지 않음
- private key: executor, workflow payload, service desired state에 전달하지 않음
- broker가 꺼졌거나 repository binding이 다르면 clone 전에 거부

## 주요 API

```txt
GET  /github/install
GET  /github/authorize
GET  /github/callback
GET  /github/installations
GET  /github/installations/:installationId/repositories
POST /github/repositories/import
POST /projects/:projectId/services/:serviceId/github
POST /github/repositories/:repositoryId/sync
POST /github/webhooks
```

## 검증

```sh
pnpm test
pnpm typecheck
sh scripts/verify-helm.sh
(cd services/builder && go test ./...)
```

로컬 테스트는 서명·만료·조직 scope, spoofed installation 차단, 저장소 catalog 교체, token 즉시 폐기, exact-repository token 발급, executor private-key 차단, 로그 마스킹을 확인합니다. 실제 GitHub App과 cluster를 사용하는 최종 smoke test는 private 저장소를 가져와 빌드 성공 및 token 비노출까지 확인해야 합니다.

## 관련 문서

- [Preview Deployment](preview-deployments.md)
- [배포 조건](handbook/deployment-requirements.md)
- [운영자 가이드](handbook/operator-guide.md)
- [보안](security.md)
