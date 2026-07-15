# GitHub App 연동

> GitHub App/OAuth/webhook은 repository import, push deployment, PR preview deployment를 RAIBITSERVER workflow로 연결합니다.

## 목적

이 문서는 GitHub App 신뢰 경계, webhook 검증, 저장소 바인딩, 로컬 fixture 계약을 설명합니다.

## 필요한 환경 변수

```txt
GITHUB_APP_ID
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
GITHUB_PRIVATE_KEY
GITHUB_WEBHOOK_SECRET
```

## 저장소 신뢰 경계

- 일반 서비스 생성/수정 API는 `githubIntegrationId`, `githubInstallationId`, `githubRepositoryId`, 저장소 가시성 같은 바인딩 필드를 받지 않습니다.
- `/integrations/github`에서 만든 레코드는 처음에는 `unverified`입니다. 사용자가 입력한 installation ID나 token만으로는 저장소를 attach/import할 수 없습니다.
- 신뢰된 GitHub App callback/synchronizer가 installation 소유권을 검증하고, 그 installation이 접근할 수 있는 repository ID·정규화된 `owner/repo`·가시성을 catalog에 기록해야 합니다.
- attach/import는 프로젝트와 같은 조직의 verified installation 및 그 installation의 정확한 catalog repository만 허용합니다. 바인딩 뒤 repo URL·repository ID·installation ID는 서비스 수정 API로 바꿀 수 없습니다.
- workflow payload의 repo URL, repository ID, installation ID, branch, commit은 권한 근거가 아닙니다. Go builder는 control-plane의 authoritative service/deployment 기록과 다르면 clone 전에 거부합니다.

## 구현된 로컬 계약

- 익명 public clone은 자격 증명이 없는 `https://github.com/<owner>/<repo>` URL로 제한되고 production에서 명시적으로 활성화해야 합니다.
- Webhook signature는 HMAC SHA-256으로 검증합니다.
- legacy GitHub integration token은 encrypted `SecretValue` row 또는 sealed local store에 저장되지만 builder의 공용 자격 증명으로 사용하지 않습니다.
- GitHub App installation 목록, installation repository 목록, repository import, service attach, repository sync API가 같은 계약을 사용합니다.
- `push` fixture는 attached service를 찾아 production deployment와 `build-and-deploy` WorkflowJob을 생성합니다.
- `pull_request` `opened`/`synchronize`/`reopened` fixture는 preview deployment, preview URL, `preview-deploy` WorkflowJob, `pr-N-service` Kubernetes workload plan을 생성합니다.
- `pull_request closed` fixture는 `preview-cleanup` WorkflowJob을 만들고 기존 preview deployment에 cleanup event를 남깁니다.
- `pnpm e2e:dry`는 실제 GitHub credential 없이 `githubWebhookEvidence`로 push/PR/cleanup 경로를 검증합니다.

## Webhook 처리 계약

```txt
POST /github/webhooks
x-github-event: push | pull_request
x-github-delivery: <dedupe id>
x-hub-signature-256: sha256=<hmac>
```

- raw body를 그대로 HMAC 검증에 사용합니다.
- 같은 delivery id는 duplicate로 처리하고 추가 workflow를 만들지 않습니다.
- bad signature는 401로 차단합니다.
- 반환값에는 실제 GitHub API 호출 대신 commit status/check-run/PR comment outbound plan이 포함됩니다.

## 소스 접근 정책

Helm 기본값 `builder.anonymousGit.enabled=false`는 production 익명 clone을 차단합니다. 공개 저장소 clone을 운영에서 허용할 때만 이를 `true`로 바꾸며, 해당 경로는 ambient `GIT_*`, `GITHUB_TOKEN`, global/system Git credential helper를 사용하지 않습니다.

Private repository build는 현재 fail-closed입니다. 다음 항목이 모두 구현·검증되기 전에는 활성화하지 않습니다.

- verified installation의 정확한 repository 한 곳에만 유효한 short-lived GitHub App token broker
- token을 argv, workflow payload, service desired state, 로그에 남기지 않는 per-build 전달 경로
- tenant/build마다 분리된 builder Pod와 BuildKit daemon/state
- 만료·회수·교차 조직·repository mismatch 회귀 테스트

따라서 credential이 없는 로컬 검증은 webhook fixture, dry-run source plan, 공개 저장소 정책 테스트만 사용합니다. 정식 API contract는 [`openapi/raibitserver.yaml`](../openapi/raibitserver.yaml)을 확인하세요.

## 보안 주의사항

- token, private key, webhook secret은 request/CLI/log에 평문으로 출력하지 않습니다.
- shared builder Deployment에 GitHub token/GIT_ASKPASS Secret을 mount하지 않습니다.
- clone command에는 token을 직접 argv로 넣지 않고 ambient Git 자격 증명도 제거합니다.
- webhook secret 불일치 요청은 처리하지 않습니다.

## 관련 문서

- [Preview Deployment](preview-deployments.md)
- [보안](security.md)
- [로컬 E2E](local-e2e.md)
