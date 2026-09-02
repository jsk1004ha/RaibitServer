# RAIBITSERVER

> 동아리, 학교, 소규모 팀을 위한 **컨테이너 우선 PaaS + DBaaS + 프로젝트 운영 플랫폼**입니다.

RAIBITSERVER는 GitHub 저장소, Dockerfile, 사전 빌드 이미지, ZIP/로컬 예제, 관리형 DB와 리소스를 하나의 프로젝트 모델로 묶습니다. 사용자의 서비스는 항상 **컨테이너 이미지**와 **Kubernetes desired state**로 변환되며, TypeScript 제어 평면이 원하는 상태를 저장하고 Go 인프라 서비스가 실제 빌드·배포·프로비저닝을 조정합니다.

이 README는 처음 온 사람이 빠르게 이해하고 실행할 수 있도록 핵심만 담습니다. 화면을 따라 첫 배포까지 진행하려면 [처음 사용 가이드](docs/getting-started.md), 세부 운영 자료를 찾으려면 [문서 허브](docs/README.md)를 먼저 보세요.

## 주요 기능

- **멀티 서비스 프로젝트**: `web`, `private`, `worker`, `cron`, `job` 서비스를 한 프로젝트에서 관리합니다.
- **컨테이너 우선 빌드**: 사용자 Dockerfile을 최우선으로 사용하고, 없을 때만 프레임워크 감지/생성 Dockerfile fallback을 사용합니다.
- **BuildKit 캐시 경로**: builder는 inline cache와 선택적 registry cache(`cache-from/cache-to`) 및 패키지 매니저 cache mount를 계획해 반복 배포 시간을 줄입니다.
- **관리형 리소스**: PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey, SQLite, Object Storage, Qdrant/vector, NATS/queue를 카탈로그 리소스로 다룹니다.
- **서브도메인 라우팅**: 서비스 실행 URL은 조직 slug를 tenant segment로 쓰는 `apps--<org>--<project>.<BASE_DOMAIN>` 형태를 사용하고, preview/console/resource 화면도 같은 flat single-label 규칙을 따릅니다.
- **공통 오류 화면**: 활성 표준 4xx·5xx 38종을 미리보기·오류 backend에서 제공하고, 호스팅 라우팅 404·upstream 500/502/503/504를 같은 RAIBIT 상태 화면으로 안내하되 사용자 앱의 자체 오류 응답은 유지합니다.
- **검증 가능한 배포 버전**: 공개 `/status`는 현재 실행 중인 Dashboard 이미지에 기록된 GitHub 커밋 SHA를 표시하고 정확한 커밋 페이지로 연결합니다.
- **승인·쿼터·감사**: 비동아리 사용자는 관리자 승인 후 쿼터 안에서 사용하고, 주요 작업은 감사 로그와 사용량에 반영됩니다.
- **AI 배포 관리자**: 서비스별 위협을 먼저 검사하고, 안전한 서비스만 결정적 재검증을 거쳐 순서대로 배포합니다. 외부 AI는 선택 사항이며 secret을 받거나 보안 차단을 해제할 수 없습니다.
- **환경 변수 보관함**: 서비스별 일반값과 암호화된 비밀값을 관리하고, `.env` 텍스트를 가져오며, API와 화면에는 secret 원문 대신 마스킹된 값을 제공합니다.
- **사용자 밴**: 관리자가 사유와 선택적 만료 시각을 기록해 계정을 제한하고 기존 세션을 즉시 무효화할 수 있습니다.
- **CI 승인 자동 업데이트**: production 서버가 `main`의 정확한 SHA에 대한 CI 성공을 확인한 뒤 digest 고정·서명·Helm rollback 보호를 거쳐 최신 버전을 반영합니다.
- **실시간 운영 UX**: 배포/런타임 로그는 조회 API와 SSE snapshot stream을 모두 제공하고, 쿼터 응답은 게이지/경고를 포함합니다.
- **안전한 기본값**: namespace 격리, NetworkPolicy, non-root 컨테이너, privileged/hostPath 차단, 리소스 제한, secret masking을 기본으로 적용합니다.
- **빌드 경로 격리**: `buildContext`/`dockerfilePath`는 서비스 소스 디렉터리 내부로 강제되어 worker 호스트 경로 유출을 차단합니다.
- **로컬 검증 가능**: 기본 검증은 실제 Kubernetes, registry, cloud, GitHub secret 없이 dry-run으로 재현됩니다.

## 아키텍처 요약

| 영역 | 구현 | 역할 |
| --- | --- | --- |
| Dashboard / API / CLI | TypeScript, Next.js, NestJS | 제품 UI, 인증/RBAC, API, CLI |
| Deterministic core | `packages/core` | 빌드 계획, compose import, 라우팅, manifest, 보안/쿼터 규칙 |
| Control-plane DB | PostgreSQL + Prisma | 프로젝트, 서비스, 리소스, 배포, 워크플로 desired state 저장 |
| Infra reconcilers | Go services | builder/orchestrator/provisioner/log/metrics 작업 처리 |
| Runtime target | Container image + Kubernetes | 사용자 워크로드 실행 상태 |

자세한 구성은 [아키텍처 문서](docs/architecture.md)를 참고하세요.

## 사전 요구사항

- Node.js **24+**
- pnpm **11.1.2** (`corepack enable` 권장)
- live Helm gate 실행 시: Bash, Docker, kind, kubectl, Helm, curl, Go 1.26.x

Node.js 24+는 로컬 SQLite DB console 경로가 `node:sqlite`를 사용하기 때문에 필요합니다. Go 모듈은 1.25.0 이상을 선언하지만 CI와 재현 가능한 live 검증은 1.26.x를 사용합니다. 기본 dry-run 검증은 cloud credential, registry, Kubernetes cluster, GitHub secret 없이 실행됩니다.

## 빠른 시작

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev:up
pnpm dev:seed
pnpm e2e:dry
pnpm dev:down
```

결과 증거는 `.raibitserver-work/e2e-report.json`에 저장됩니다.

기존 스크립트 호환 alias도 유지합니다.

| 권장 명령 | 호환 alias | 설명 |
| --- | --- | --- |
| `pnpm dev:up` | `pnpm dev-up` | 로컬 도구 감지 및 dev 상태 준비 |
| `pnpm e2e:dry` | `pnpm dev:e2e:dry`, `pnpm dev-e2e` | 외부 부작용 없는 기본 E2E |
| `pnpm e2e:live:helm` | `pnpm e2e:live`, `pnpm dev:e2e:live` | Docker/kind/Helm으로 API·Provisioner·Orchestrator를 검증하는 live reconciliation gate |
| `pnpm dev:down` | `pnpm dev-down` | 로컬 상태 정리 |

## 기본 검증

변경 전후에 아래 명령을 우선 확인합니다.

```sh
pnpm test
pnpm typecheck
node scripts/check-structure.js
node src/cli.js validate examples/project.json
node src/cli.js manifest examples/project.json >/tmp/raibitserver-manifest.json
node src/cli.js compose examples/docker-compose.yml >/tmp/raibitserver-compose-plan.json
pnpm prisma:validate
```

Go가 설치되어 있다면 인프라 서비스도 확인합니다.

```sh
for dir in services/builder services/orchestrator services/provisioner services/log-ingester services/metrics-ingester; do
  (cd "$dir" && go test ./... && go build ./...)
done
```

변경 영역별 검증 명령은 [검증 명령 매트릭스](docs/verification-commands.md)에 정리되어 있습니다.

## API와 CLI 사용 예시

정식 API 계약은 [`openapi/raibitserver.yaml`](openapi/raibitserver.yaml)에 있고, CLI는 API client와 로컬 planner/executor smoke path를 함께 검증합니다.

```sh
RAIBITSERVER_API_URL=http://localhost:3000/api raibitserver whoami
raibitserver projects list
raibitserver projects create --name demo --organization-id org_id
raibitserver services create --project-id prj_id --name web --source-type image --image registry.example/demo/web@sha256:DIGEST
raibitserver deploy --service-id svc_id
raibitserver deployments logs --deployment-id dep_id
# API: GET /api/deployments/dep_id/stream 또는 /api/services/svc_id/logs/stream (SSE)
raibitserver resources create --project-id prj_id --engine sqlite --name data
raibitserver db query --resource-id res_id --query "SELECT 1"
raibitserver admin approve --user-id usr_id
```

CI smoke와 manifest 생성에는 루트 CLI도 사용할 수 있습니다.

```sh
node src/cli.js validate examples/project.json
node src/cli.js manifest examples/project.json
node src/cli.js compose examples/docker-compose.yml
```

## 문서 바로가기

| 필요 | 문서 |
| --- | --- |
| 사용자·운영자·AI 종합 설명서 | [docs/handbook/README.md](docs/handbook/README.md) |
| AI용 빠른 컨텍스트 | [llms.txt](llms.txt) |
| 처음 설치하고 화면을 따라 사용하기 | [docs/getting-started.md](docs/getting-started.md) |
| 전체 문서 목록 | [docs/README.md](docs/README.md) |
| 시스템 구조 | [docs/architecture.md](docs/architecture.md) |
| 로컬 dry-run E2E | [docs/local-e2e.md](docs/local-e2e.md) |
| live E2E | [docs/live-e2e.md](docs/live-e2e.md) |
| GitHub App/preview | [docs/github-app.md](docs/github-app.md), [docs/preview-deployments.md](docs/preview-deployments.md) |
| 대시보드·호스팅 오류 화면 | [docs/hosted-error-pages.md](docs/hosted-error-pages.md) |
| 보안 정책 | [docs/security.md](docs/security.md) |
| 승인/쿼터 | [docs/quota.md](docs/quota.md) |
| DB console | [docs/db-console.md](docs/db-console.md) |
| 리소스 프로비저닝 | [docs/provisioning.md](docs/provisioning.md) |
| 워크플로 작업 | [docs/workflows.md](docs/workflows.md) |
| 문제 해결 | [docs/troubleshooting.md](docs/troubleshooting.md) |
| 베타 출시 기준 | [docs/beta-criteria.md](docs/beta-criteria.md) |
| Staging 배포 | [deploy/staging/README.md](deploy/staging/README.md) |
| Production 배포 | [deploy/production/README.md](deploy/production/README.md) |
| 변경 이력 | [CHANGELOG.md](CHANGELOG.md) |

## 핵심 환경 변수

| 분류 | 변수 |
| --- | --- |
| DB/상태 | `DATABASE_URL`, `RAIBITSERVER_PERSISTENCE`, `RAIBITSERVER_CONTROL_PLANE_DATABASE_URL`, `RAIBITSERVER_CONTROL_PLANE_STORE`, `RAIBITSERVER_CONTROL_PLANE_FILE`, `REDIS_URL` |
| Secret/Auth | `JWT_SECRET`, `RAIBITSERVER_AUTH_JWT_SECRET`, `RAIBITSERVER_AUTH_ISSUER`, `RAIBITSERVER_SESSION_TTL_SECONDS`, `RAIBITSERVER_AUTH_RATE_LIMIT`, `RAIBITSERVER_TRUST_PROXY_HEADERS`, `ENCRYPTION_KEY`, `RAIBITSERVER_SECRET_ENCRYPTION_KEY`, `ADMIN_EMAILS` |
| Dashboard/API | `PORT`, `RAIBITSERVER_API_URL`, `RAIBITSERVER_CONSOLE_URL`, `RAIBITSERVER_DASHBOARD_ORIGIN`, `RAIBITSERVER_DASHBOARD_BASIC_AUTH` |
| Build/Runtime | `REGISTRY_URL`, `RAIBITSERVER_REGISTRY`, `RAIBITSERVER_REGISTRY_USERNAME`, `RAIBITSERVER_REGISTRY_PASSWORD`, `RAIBITSERVER_BUILDKIT_CACHE`, `RAIBITSERVER_BUILDKIT_CACHE_REF`, `KUBECONFIG`, `RAIBITSERVER_KUBE_CONTEXT`, `BASE_DOMAIN`, `RAIBITSERVER_BASE_DOMAIN`, `RAIBITSERVER_INGRESS_GATEWAY_NAMESPACE`, `RAIBITSERVER_EXECUTE`, `RAIBITSERVER_PUSH` |
| Object Storage | `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` |
| Provider | `RAIBITSERVER_POSTGRES_PROVIDER_URL`, `POSTGRES_PROVIDER_URL`, `RAIBITSERVER_PROVIDER_POSTGRESQL_IMAGE`, `RAIBITSERVER_PROVIDER_MYSQL_IMAGE`, `RAIBITSERVER_PROVIDER_MARIADB_IMAGE`, `RAIBITSERVER_PROVIDER_MONGODB_IMAGE`, `RAIBITSERVER_PROVIDER_REDIS_IMAGE`, `RAIBITSERVER_PROVIDER_VALKEY_IMAGE`, `RAIBITSERVER_PROVIDER_MINIO_IMAGE`, `RAIBITSERVER_PROVIDER_QDRANT_IMAGE`, `RAIBITSERVER_PROVIDER_NATS_IMAGE` |
| GitHub App/OAuth | `RAIBITSERVER_GITHUB_APP_SLUG`, `RAIBITSERVER_GITHUB_CLIENT_ID`, `RAIBITSERVER_GITHUB_CLIENT_SECRET`, `RAIBITSERVER_GITHUB_CALLBACK_URL`, `RAIBITSERVER_GITHUB_REDIRECT_URI`, `RAIBITSERVER_GITHUB_STATE_SECRET`, `RAIBITSERVER_GITHUB_WEBHOOK_SECRET` |
| AI 배포 조언(선택) | `RAIBITSERVER_AI_AGENT_URL`, `RAIBITSERVER_AI_AGENT_TOKEN`, `RAIBITSERVER_AI_AGENT_MODEL` |

Production 실행 전 필수 설정은 [production 배포 문서](deploy/production/README.md)를 확인하세요.
GitHub webhook 엔드포인트(`POST /github/webhooks`)는 HMAC 검증을 반드시 수행하므로 `RAIBITSERVER_GITHUB_WEBHOOK_SECRET`(또는 `GITHUB_WEBHOOK_SECRET`)이 비어 있으면 요청을 거부합니다.

## 서버 구축 세팅 체크리스트

이 섹션은 베타/production 서버를 직접 구성할 때 누락되기 쉬운 항목을 한 번에 점검하기 위한 운영 체크리스트입니다. 로컬 dry-run은 파일 기반 상태와 mock provider로도 동작하지만, 실제 서버는 **PostgreSQL control-plane DB + Kubernetes runtime + registry + Go worker** 구성이 기본입니다.

### 1. 권장 배포 형태

```txt
사용자/관리자
  -> HTTPS Ingress / Load Balancer
     -> Dashboard(Next.js)
     -> API(NestJS, /api)
     -> 사용자 서비스 Ingress(*.apps / *.preview)

비공개 네트워크
  -> PostgreSQL(control-plane)
  -> Redis/queue/cache
  -> Image registry
  -> Object storage
  -> Kubernetes API
  -> Go workers(builder, orchestrator, provisioner, log/metrics ingester)
```

- **Control plane**: API, Dashboard, Prisma/PostgreSQL, audit/quota/auth 상태를 담당합니다.
- **Runtime plane**: Kubernetes namespace, Deployment/Service/Ingress, Secret ref, NetworkPolicy를 담당합니다.
- **Worker plane**: builder가 source를 image로 만들고 registry에 push하며, orchestrator/provisioner가 DB desired state를 실제 Kubernetes/resource 상태로 reconcile합니다.
- `RAIBITSERVER_CONTROL_PLANE_FILE`은 deterministic local worker 전용입니다. 베타/production에서는 PostgreSQL store를 사용합니다.

### 2. 서버와 클러스터 준비물

| 영역 | 필요 설정 |
| --- | --- |
| OS/런타임 | Linux 서버 또는 Kubernetes cluster, Node.js 24+, pnpm 11.1.2, Go 모듈 1.25.0+ (release 검증 1.26.x) |
| Container build | Docker/BuildKit 또는 Kubernetes 내부 builder, image push 권한이 있는 registry |
| Kubernetes | `kubectl`, Helm, ingress controller, 기본 StorageClass/PVC, namespace 생성 권한 |
| Database | PostgreSQL 15+ 권장, Prisma migration 적용 가능해야 함 |
| Queue/cache | Redis 호환 backend 권장. workflow lease/backlog와 cache에 사용 |
| TLS/DNS | public load balancer, wildcard DNS, TLS 인증서 또는 cert-manager |
| Storage | object storage/S3-compatible backend, DB backup 저장소, registry retention 정책 |
| 관측성 | API health check, worker log, Kubernetes event, audit log, metrics/log 수집 경로 |

단일 서버 베타는 한 노드에 control-plane과 소형 Kubernetes(kind/k3d/k3s 등)를 함께 둘 수 있지만, 외부 사용자를 받는 운영 환경은 control-plane DB, registry, runtime cluster를 분리하는 구성을 권장합니다.

### 3. DNS와 라우팅

`BASE_DOMAIN=raibitserver.app`을 예로 들면 다음 DNS가 ingress/load balancer를 바라봐야 합니다.

| 용도 | 예시 |
| --- | --- |
| API | `api.raibitserver.app` |
| Main/Dashboard | `raibit.kr` 공개 랜딩, `console.raibit.kr` 로그인 전용 콘솔 |
| 서비스 실행 URL | `apps--<org>--<project>.raibitserver.app` |
| PR preview URL | `preview--pr-<number>--<org>--<project>.raibitserver.app` |
| 서비스 관리 화면 | `console--<org>--<project>-<service>.raibitserver.app` |
| 리소스 관리 화면 | `resources--<org>--<project>-<resource>.raibitserver.app` |

서비스 실행 host는 조직 slug 경계 충돌을 막기 위해 `apps--<org>--<project>.<BASE_DOMAIN>` 패턴으로 생성됩니다. PR preview는 `preview--pr-<number>--<org>--<project>.<BASE_DOMAIN>`, service/resource 관리 화면은 `console--...` 및 `resources--...` 단일 label을 사용합니다. 따라서 `*.<BASE_DOMAIN>` wildcard 인증서 하나로 generated route를 처리할 수 있습니다.

Cloudflare Tunnel을 쓰는 경우 각 tenant hostname을 직접 매핑하지 마세요. 공개 apex와 `api.<BASE_DOMAIN>`, `console.<BASE_DOMAIN>`, `*.<BASE_DOMAIN>`을 **내부 Kubernetes Ingress Controller 하나**로 보내고, 최종 Host 기반 라우팅은 Kubernetes Ingress가 담당해야 합니다. Cloudflare Tunnel hostname wildcard는 `*.example.com` 형태만 쓰고 `test.*.example.com` 같은 중간 wildcard에 의존하지 않습니다. 자세한 예시는 [Cloudflare Tunnel 운영 가이드](docs/cloudflare-tunnel.md)와 [production tunnel 예시](deploy/production/cloudflare-tunnel.example.yml)를 참고하세요.

Tenant NetworkPolicy는 임의의 사용자 라벨이 아니라 Kubernetes 예약 네임스페이스 라벨 `kubernetes.io/metadata.name`으로 ingress controller를 식별합니다. 기본 네임스페이스는 `ingress-nginx`이며, 다른 네임스페이스를 쓰면 Helm `ingress.gatewayNamespace`를 설정하세요. 이 값은 같은 release의 API, Go orchestrator, ValidatingAdmissionPolicy에 함께 렌더되고 tenant 프로젝트 입력으로는 변경할 수 없습니다.

존재하지 않는 tenant hostname과 upstream 5xx는 공통 오류 backend로 전달할 수 있습니다. `hostedErrors.fallbackIngress.tls.existingSecret`을 비우면 기존 `ingress.tls.existingSecret`을 재사용합니다. 선택된 Secret에는 wildcard 인증서가 있어야 하며, 사용 중인 ingress-nginx 또는 Traefik 연결은 [호스팅 오류 화면 가이드](docs/hosted-error-pages.md)대로 설정하세요.

> 보안 필수: `raibit.kr`의 랜딩과 `/public/sites`만 공개합니다. 로그인·가입·콘솔 경로는 `console.raibit.kr`로 이동하며 세션 쿠키는 host-only로 유지합니다. 부모 도메인 쿠키는 `apps--*.raibit.kr` 사용자 워크로드에도 bearer token을 보내므로 사용하지 않습니다. `/admin`과 관리자 메뉴는 JWT의 `userRole=ADMIN`인 계정만 사용할 수 있으며 Cloudflare Access/MFA를 추가 방어선으로 둘 수 있습니다.

### 4. production 환경 변수 예시

아래 값은 예시입니다. 실제 secret은 password manager, sealed secret, cloud secret manager, Kubernetes Secret 등으로 주입하고 저장소에 커밋하지 마세요.

```sh
# 공통
NODE_ENV=production
PORT=3000
BASE_DOMAIN=raibitserver.app
RAIBITSERVER_BASE_DOMAIN=raibitserver.app

# Control-plane DB / Prisma
RAIBITSERVER_PERSISTENCE=prisma
DATABASE_URL=postgresql://raibitserver:<password>@postgres.internal:5432/raibitserver?schema=public
RAIBITSERVER_CONTROL_PLANE_STORE=postgresql
RAIBITSERVER_CONTROL_PLANE_DATABASE_URL=postgresql://raibitserver:<password>@postgres.internal:5432/raibitserver?schema=public

# Auth / secret
RAIBITSERVER_AUTH_JWT_SECRET=<32바이트-이상-랜덤값>
RAIBITSERVER_AUTH_ISSUER=raibitserver
RAIBITSERVER_AUTH_AUDIENCE=raibitserver-api
RAIBITSERVER_SECRET_ENCRYPTION_KEY=<32바이트-이상-랜덤값>
ADMIN_EMAILS=admin@example.com
RAIBITSERVER_ADMIN_BOOTSTRAP_TOKEN=<32바이트-이상-랜덤-초기-admin-token>
RAIBITSERVER_EMAIL_VERIFICATION_TTL_SECONDS=600
RAIBITSERVER_EMAIL_DOMAIN=raibitserver.app
RAIBITSERVER_EMAIL_FROM="RAIBITSERVER <email-verification@raibitserver.app>"
RAIBITSERVER_EMAIL_DELIVERY_MODE=webhook
RAIBITSERVER_EMAIL_WEBHOOK_URL=https://mail-bridge.internal/send
RAIBITSERVER_EMAIL_WEBHOOK_TOKEN=<mail-bridge-token>

# Dashboard -> API
RAIBITSERVER_API_URL=https://api.raibitserver.app/api
RAIBITSERVER_CONSOLE_URL=https://console.raibit.kr/console
# public/console dual-host에서는 RAIBITSERVER_DASHBOARD_ORIGIN을 설정하지 않습니다.
# 세션 쿠키는 console.raibit.kr host-only로 유지합니다.
RAIBITSERVER_DASHBOARD_BASIC_AUTH=<optional-extra-user>:<strong-random-password>

# Kubernetes / runtime
KUBECONFIG=/etc/raibitserver/kubeconfig
RAIBITSERVER_KUBE_CONTEXT=raibitserver-prod
RAIBITSERVER_EXECUTE=1
RAIBITSERVER_ROLLOUT_TIMEOUT_SECONDS=300

# Registry / builder
REGISTRY_URL=registry.raibitserver.app/raibitserver
RAIBITSERVER_REGISTRY=registry.raibitserver.app
RAIBITSERVER_REGISTRY_USERNAME=<registry-user>
RAIBITSERVER_REGISTRY_PASSWORD=<registry-password>
RAIBITSERVER_PUSH=1
RAIBITSERVER_BUILD_TIMEOUT_SECONDS=900
RAIBITSERVER_ALLOW_ANONYMOUS_GIT=0

# Provider
REDIS_URL=redis://redis.internal:6379
RAIBITSERVER_POSTGRES_PROVIDER_URL=postgresql://provider:<password>@postgres-provider.internal:5432/postgres
RAIBITSERVER_POSTGRES_POOLER_HOST=pgbouncer.shared-providers.svc.cluster.local
S3_ENDPOINT=https://s3.example.com
S3_ACCESS_KEY=<access-key>
S3_SECRET_KEY=<secret-key>

# GitHub OAuth/App
RAIBITSERVER_GITHUB_APP_SLUG=<github-app-slug>
RAIBITSERVER_GITHUB_CLIENT_ID=<github-oauth-client-id>
RAIBITSERVER_GITHUB_CLIENT_SECRET=<github-oauth-client-secret>
RAIBITSERVER_GITHUB_CALLBACK_URL=https://console.raibitserver.app/github/callback
RAIBITSERVER_GITHUB_REDIRECT_URI=https://console.raibitserver.app/api/control/auth/github/callback
RAIBITSERVER_GITHUB_STATE_SECRET=<32-plus-character-state-secret>
RAIBITSERVER_GITHUB_WEBHOOK_SECRET=<webhook-secret>
```

private 저장소 빌드용 App ID와 RSA private key는 API 환경변수에 넣지 않고 dispatcher 전용 Kubernetes Secret으로 분리합니다. 설정 예시는 [GitHub App 가이드](docs/github-app.md)에 있습니다.

운영에서 사용하면 안 되는 개발 편의 변수도 있습니다.

- Nest API는 부팅 시 `PORT`, `RAIBITSERVER_AUTH_RATE_LIMIT`, production auth/secret 설정을 먼저 검증합니다. `NODE_ENV=production`에서는 32자 미만 `RAIBITSERVER_AUTH_JWT_SECRET`, 32자 미만 `RAIBITSERVER_SECRET_ENCRYPTION_KEY`, `ADMIN_EMAILS`가 있는데 32자 미만 `RAIBITSERVER_ADMIN_BOOTSTRAP_TOKEN`, `RAIBITSERVER_AUTH_DISABLED=1`, `RAIBITSERVER_AUTH_DEV_HEADERS=1`, `RAIBITSERVER_AUTH_DEV_TOKEN=1`이 모두 fail-fast로 차단됩니다.
- `RAIBITSERVER_AUTH_DISABLED`, `RAIBITSERVER_AUTH_DEV_HEADERS`, `RAIBITSERVER_AUTH_DEV_TOKEN`, `RAIBITSERVER_ROLE`은 로컬 개발 전용입니다. 특히 인증 비활성화는 `NODE_ENV=production`에서는 무시되며, 로컬에서도 `RAIBITSERVER_AUTH_DISABLED_CONFIRM=I_UNDERSTAND_THIS_GRANTS_GLOBAL_OWNER` 확인값이 있어야만 활성화됩니다. dev header 인증은 추가로 `RAIBITSERVER_DEV_HEADER_BIND_LOCAL=1`이 있어야만 켜집니다.
- 인증 rate limit은 기본적으로 소켓 원격 주소를 사용하고 `X-Forwarded-For`를 신뢰하지 않습니다. signup, 이메일 인증·재발송, 로그인은 처리 전에 durable email/action, source/action, 전체 auth-flow source, global bucket을 모두 선차감하며 성공해도 bucket을 reset하지 않습니다. 키에는 원문 이메일이나 source 대신 secret-keyed digest를 저장합니다. 따라서 로그인 성공 여부나 계정 존재 여부로 제한을 우회할 수 없고, 한 source의 이메일 순환 공격과 한 이메일의 source 순환 공격을 함께 제한합니다. Cloudflare Access/Tunnel, Nginx, Ingress처럼 신뢰된 프록시만 API 앞에 있고 origin bypass가 방화벽으로 막힌 경우에만 `RAIBITSERVER_TRUST_PROXY_HEADERS=1`을 설정하세요.
- 가입 신청은 이메일/비밀번호와 함께 이름·학번을 필수로 저장합니다. 관리자는 승인 화면에서 이름/학번/이메일을 확인하고 `CLUB_MEMBER` 또는 `NON_CLUB`으로 승인합니다.
- 운영 첫 admin은 더 이상 “첫 가입자”만으로 자동 승격되지 않습니다. `ADMIN_EMAILS`에 포함된 이메일이 `RAIBITSERVER_ADMIN_BOOTSTRAP_TOKEN`을 함께 제출할 때만 admin bootstrap이 허용됩니다.
- 이메일/비밀번호 signup은 6자리 이메일 인증 코드를 먼저 발송하고, `/auth/email/verify` 성공 후에만 세션 토큰을 발급합니다. 같은 이메일로 signup을 다시 시작하면 이전에 소비되지 않은 signup 인증 코드와 payload를 무효화하고 새 payload/코드를 발급해, 악의적이거나 오래된 pending signup이 정상 가입을 계속 막거나 피해자가 공격자 지정 비밀번호/조직으로 계정을 만들게 하지 않습니다. `/auth/email/resend`는 아직 만료되지 않은 최신 pending signup payload에 대해서만 코드를 재발급합니다. 발신자는 발송 전용 주소(`RAIBITSERVER_EMAIL_FROM`, 예: `RAIBITSERVER <email-verification@raibitserver.app>`)이고, `RAIBITSERVER_EMAIL_DOMAIN`/`RAIBITSERVER_BASE_DOMAIN`/`BASE_DOMAIN`에서 자동 생성할 수도 있습니다. 이 기능은 사용자 메일함/MX를 운영하지 않으며 production은 `RAIBITSERVER_EMAIL_WEBHOOK_URL` 같은 실제 mail bridge와 발신 도메인의 SPF/DKIM/DMARC 설정이 필요합니다.
- DB console 권한은 `db:schema:read`, `db:data:read`, `db:query:write`로 분리됩니다. 기본 developer는 schema metadata만 볼 수 있고 row data `SELECT`는 maintainer/db-admin 이상 권한이 필요합니다.
- public egress는 프로젝트 namespace 전체가 아니라 `*-public-egress` 서비스별 NetworkPolicy로만 열립니다. ingress/proxy에서는 `x-raibitserver-user`, `x-raibitserver-role`, `x-raibitserver-organization`, `x-raibitserver-project` 헤더를 외부 요청에서 제거하세요.
- production tenant API는 local/file source와 기본 허용 목록 밖 Git host를 거부합니다. 예외가 필요하면 `RAIBITSERVER_ALLOWED_GIT_HOSTS`로 Git host를 명시하고, 로컬 source는 개발 환경에서만 사용하세요.
- `RAIBITSERVER_ALLOW_MEMORY_PERSISTENCE=1`은 production 안전 조건을 깨뜨립니다.
- `RAIBITSERVER_DRY_RUN=1` 또는 `RAIBITSERVER_EXECUTE` 미설정 상태에서는 worker가 실제 apply/push/provision을 수행하지 않습니다.
- builder는 `localPath`, `buildContext`, `dockerfilePath`를 workspace/source 경계 안으로만 해석합니다. 상위 디렉터리(`..`) 또는 절대 경로로 경계를 벗어나는 빌드 입력은 거부됩니다.
- production의 익명 Git clone은 기본 차단됩니다. 공개 GitHub 저장소가 꼭 필요할 때만 Helm `builder.anonymousGit.enabled=true`를 명시하며, shared token이나 ambient Git credential은 사용하지 않습니다.
- private GitHub source build는 verified installation/repository binding까지는 구현됐지만, Git clone용 exact-repository short-lived token broker가 연결되기 전까지 의도적으로 실패합니다. DB 연결 dispatcher와 tenant BuildKit executor의 Pod/NetworkPolicy 분리는 구현되어 있습니다.

### 5. 처음 서버 올리는 순서

1. **DB 생성**
   - PostgreSQL database/user를 만들고 `DATABASE_URL`로 접근을 확인합니다.
   - production API는 in-memory store를 사용하지 않도록 `RAIBITSERVER_PERSISTENCE=prisma`를 둡니다.
2. **Prisma 준비**
   ```sh
   pnpm install --frozen-lockfile
   pnpm prisma:validate
   pnpm prisma:generate
   node scripts/check-migration-contract.mjs
   pnpm exec prisma migrate deploy --schema prisma/schema.prisma
   ```
   - `prisma/migration-contract.json`은 순서가 있는 migration ID와 LF 정규화 SHA-256, 애플리케이션 호환성 하한(`000008`), `forward-fix` 복구 방식을 기록합니다. 기존 migration은 수정하지 않고 새 항목을 추가합니다. migration을 먼저 적용한 뒤 reader, writer를 배포하며 애플리케이션 롤백 시 확장된 스키마를 유지합니다. 새 migration은 nullable 컬럼·테이블·인덱스만 허용하며 down migration, DROP, rename, 필수 컬럼 전환은 거부합니다.
   - 인덱스 허용 문법은 `CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ON table (column, ...) [WHERE column IS NOT NULL [AND ...]]`입니다. 이름은 schema 접두사 없는 일반 식별자 또는 큰따옴표 식별자이며, 함수·표현식·추가 옵션·알 수 없는 접미사는 거부합니다. 기존 테이블에는 non-unique 인덱스만 허용합니다. UNIQUE 인덱스는 같은 migration에서 앞서 `CREATE TABLE`로 만든 테이블에만 허용해 N−1 writer가 허용하던 중복 쓰기를 제한하지 않습니다. 새 테이블 정의의 PK·UNIQUE·NOT NULL·DEFAULT는 기존 writer를 제한하지 않으므로 유지합니다. 이 게이트는 전체 PostgreSQL 문법 검증기가 아니며, 실제 migration 적용 검증도 필요합니다.
   - `node --test tests/migration-compatibility.test.js tests/postgres-integration.test.js`는 `RAIBITSERVER_TEST_DATABASE_URL`을 지정하면 별도 임시 schema에서 fresh install, `000008` 업그레이드, 실제 N−1 Prisma client 읽기·쓰기 및 forward-fix를 검증합니다. URL이 없으면 DB 시나리오는 건너뛰며 오프라인 계약 검증만 수행합니다. CRD 게이트는 `test-fixtures/contracts/crd-schema-v1.json` 대비 기존 served/storage 버전과 필드를 보존하고 새 optional 필드만 허용합니다. CRD 적용 전에는 별도 로컬 클러스터에서 `kubectl apply --dry-run=server`로 CRD와 구형·확장 객체를 검증해야 합니다.
3. **Secret 준비**
   - `RAIBITSERVER_AUTH_JWT_SECRET`, `RAIBITSERVER_SECRET_ENCRYPTION_KEY`, GitHub/registry/provider secret을 secret manager에 저장합니다.
   - 회원가입 요청은 이메일 코드만 발송하고, 코드 인증이 성공해야 user/organization을 생성하고 세션 토큰을 발급합니다. 로컬 첫 verified auth 사용자는 `ADMIN / NON_CLUB / APPROVED`가 되고, 운영 첫 admin은 `ADMIN_EMAILS` + bootstrap token으로 제한됩니다. 인증 완료된 신규 회원가입은 먼저 `NON_CLUB`으로 시작하며, 운영자는 어드민 화면에서 `CLUB_MEMBER`/`NON_CLUB`을 전환합니다.
4. **이미지 빌드/배포**
   - 저장소 루트를 build context로 사용해 API, Dashboard, CLI와 Go service Dockerfile을 빌드하고 registry에 push합니다. 예: `docker build -f apps/api/Dockerfile -t <registry>/api:<tag> .`
   - 배포 전 각 push 결과의 manifest-list digest를 확인하고 Helm의 `image.digests.api`, `dashboard`, `orchestrator`, `builder`, `provisioner`, `logIngester`, `metricsIngester`에 활성화할 component의 `sha256:...` 값을 넣습니다. production 모드는 tag-only 이미지를 허용하지 않습니다.
   - live 관리형 PostgreSQL/MySQL/MariaDB/MongoDB/Redis/Valkey workload 이미지는 `provisioner.providerImages.*`에 `repository@sha256:<digest>` 형식으로 모두 지정합니다. production chart는 이 6개 이미지가 누락되거나 tag-only이면 거부합니다. MinIO/Qdrant/NATS 이미지는 plan-only adapter가 live bootstrap을 구현할 때까지 비워 둘 수 있으며, 값을 넣는 경우에도 digest pin은 필수입니다.
   - certified provider 이미지는 restricted Pod Security의 엔진별 non-root UID/GID 계약(PostgreSQL `70`, MySQL/MariaDB/MongoDB/Redis/Valkey `999`)으로 실행되고 데이터 경로에 쓸 수 있어야 합니다. 또한 `/bin/sh`와 인증 확인 CLI(`psql`, `mysql`/`mariadb`, `mongosh`, `redis-cli`/`valkey-cli`)를 포함해야 합니다. provisioner는 생성한 자격 증명으로 실제 인증 명령이 성공한 뒤에만 READY로 전환합니다.
   - `runtimeSecrets.existingSecret`, `database.existingSecret`, `ingress.tls.existingSecret`과 builder의 registry/signing/dispatch mTLS secret ref를 미리 생성합니다. hosted error 전용 Secret이 필요하면 `hostedErrors.fallbackIngress.tls.existingSecret`을 별도로 지정하고, 비우면 ingress TLS Secret을 재사용합니다. 선택된 Secret은 `*.<BASE_DOMAIN>`을 포함해야 합니다. `builder.dispatch.existingSecret`에는 release 전용 CA, dispatcher server keypair, executor client keypair가 필요하며 server certificate SAN은 `<release>-builder-dispatcher` Service DNS를 포함해야 합니다. private GitHub build를 켜면 App ID와 private key를 `builder.githubAppCredentials.existingSecret`에 별도로 두며 이 Secret은 dispatcher에만 mount합니다. chart는 application credential Secret을 생성하지 않습니다.
   - `infra/helm/raibitserver/ci-production-values.yaml`의 platform digest는 정적 chart 검증용 가짜 값이므로 실제 배포에 사용하지 않습니다. production 값은 `sh scripts/verify-helm.sh`로 fail-closed 조건을 먼저 검증합니다.
   - chart의 `crds/`는 최초 설치 시 적용되지만 Helm upgrade에서 CRD schema를 자동 갱신하지 않습니다. CRD 변경은 백업과 호환성 검토 후 별도 승인 절차로 적용합니다.
5. **API와 Dashboard 기동**
   - API는 `/api` global prefix를 사용합니다. health check와 auth/login/signup 경로를 확인합니다.
   - Dashboard는 `RAIBITSERVER_API_URL=https://api.<BASE_DOMAIN>/api`로 API를 바라보게 합니다.
6. **Go worker 기동**
   - builder dispatcher/orchestrator/provisioner/log-ingester/metrics-ingester에 PostgreSQL control-plane URL을 주입합니다. disposable builder executor에는 DB URL을 절대 주입하지 않습니다. 기본 chart는 겹치지 않는 CronJob batch마다 executor 4개를 병렬 실행하며 `builder.isolation.parallelism`/`completions`로 경계 내 처리량을 조정합니다.
   - 실제 적용 환경에서는 `RAIBITSERVER_EXECUTE=1`, build push가 필요하면 `RAIBITSERVER_PUSH=1`을 설정합니다.
7. **GitHub App/OAuth 연결**
   - App callback과 setup URL: `https://console.<BASE_DOMAIN>/github/callback`
   - GitHub App의 **Request user authorization during installation**은 끄고 **Redirect on update**는 켭니다. 이미 설치된 App의 저장소 설정을 변경해도 Setup URL로 돌아와야 연결이 완료됩니다.
   - Webhook URL: `https://api.<BASE_DOMAIN>/api/github/webhooks`
   - Webhook event는 `push`, `pull_request`, `installation`, `installation_repositories`를 포함합니다.
   - 자세한 권한과 fixture 검증은 [GitHub App 문서](docs/github-app.md)와 [Preview Deployment 문서](docs/preview-deployments.md)를 참고하세요.
8. **운영 smoke 검증**
   - 관리자 첫 로그인 → 조직/프로젝트 생성 → GitHub repo attach 또는 image service 생성 → deployment queue → worker 처리 → 서비스 URL 접속까지 확인합니다.
   - Disposable cluster의 Helm reconciliation 검증은 Docker daemon, kind, kubectl, Helm, Go toolchain이 있는 환경에서 `pnpm e2e:live`로 실행합니다. 이 명령은 `scripts/live-helm-e2e.sh`를 호출해 실제 API/orchestrator/provisioner 이미지를 빌드·로딩하고, migration/API health, 관리형 PostgreSQL 생성·immutable Secret·인증 쿼리·READY·주기 health reconciliation, Builder exhausted-attempt DB 복구, 삭제 lease 정밀도, 오케스트레이터의 DB 프로젝트/tenant namespace 삭제를 확인한 후 cluster를 제거합니다.
   - 이 게이트는 Go Builder의 source build/registry push/signing, tenant workload HTTP 200, runtime log, preview cleanup을 아직 포함하지 않습니다. 전체 앱 lifecycle Beta 판정은 이 잔여 항목의 별도 live evidence도 필요합니다. 정확한 범위는 [Live E2E 문서](docs/live-e2e.md)를 참고하세요.

### 6. Kubernetes 보안 기본값

- platform component는 `raibitserver-system` 같은 전용 namespace에 두고, 사용자 workload는 조직/프로젝트별 namespace로 분리합니다.
- tenant workload에는 restricted Pod Security, non-root 실행, resource requests/limits, Secret ref, NetworkPolicy를 적용합니다.
- TypeScript control plane의 provider 엔드포인트는 계획만 만들며 자격 증명이나 placeholder Secret을 쓰지 않습니다. authoritative Go provisioner만 암호학적 난수 자격 증명을 생성해 stdin으로 immutable Kubernetes Secret을 최초 1회 생성합니다. 재시도는 Secret을 읽지 않고 server-side create의 `AlreadyExists`만 확인하며, 기존 workload의 Secret이 사라졌다면 credential을 재생성하지 않습니다. workload에는 허용 key별 `secretKeyRef`만 주입하고 kubelet이 공개 connection contract와 실제 인증을 검사합니다. control-plane DB에는 Secret 이름·허용 환경변수 키·내부 endpoint 같은 공개 메타데이터만 기록하며 READY 리소스도 주기적으로 재검증합니다.
- provisioner는 cluster-wide `pods/exec`와 Secret read 권한을 갖지 않습니다. managed namespace와 제한된 tenant RoleBinding만 bootstrap하고, provider object CRUD는 해당 namespace의 tenant role로 수행합니다. admission policy가 unmanaged namespace 채택, 다른 ClusterRole/ServiceAccount 바인딩, ownership label이 없는 provider object 변경을 거부합니다.
- tenant spec의 `prePullImages`/`runtime.prePullImages`/`performance.prePullImages`는 DaemonSet을 만들지 않습니다. node-wide image warming은 tenant manifest가 아니라 operator-controlled 배포 정책에서만 허용해야 합니다.
- privileged container, hostPath, hostNetwork, root 실행, quota 초과 배포는 배포 전 차단되어야 합니다.
- orchestrator service account는 필요한 namespace/resource에만 권한을 주고 cluster-admin 상시 권한은 피합니다.
- registry pull secret과 provider credential은 사용자가 API body로 직접 넘기는 값이 아니라 platform secret/ref로 관리합니다.
- production Helm 배포는 digest-pinned checker 이미지로 `pre-install,pre-upgrade` 검증 Job을 실행합니다. 이 hook은 지정한 `ValidatingWebhookConfiguration` 안의 정확한 webhook 이름, `failurePolicy=Fail`, 설정한 `clientConfig.service` 또는 `clientConfig.url`, namespaced core/v1 Pod `CREATE`/`UPDATE` 규칙, 안전한 `raibitserver.io/managed=true` selector 계약을 확인합니다. 또한 trust-root Secret의 정확한 `.data[key]`가 비어 있지 않은지와 verifier Deployment/Service가 모두 존재하는지를 최소 `get` RBAC으로 확인하며, 실패하면 일반 workload가 설치되기 전에 release를 중단합니다. `helm lint/template`은 값과 manifest 계약만 오프라인 검증하므로, 클러스터에 verifier나 trust-root가 실제로 없으면 설치/업그레이드 시 hook 실행이 실패하는 것이 정상적인 fail-closed 동작입니다. checker 이미지는 `/bin/sh`, `kubectl`을 포함해야 하며 production에서는 반드시 sha256 digest로 고정합니다.
- builder dispatcher의 database egress는 `builder.databaseEgress`에 TCP port와 namespace/pod selector peer 또는 CIDR을 명시합니다. production 값에서 대상이 하나도 없으면 Helm render가 실패합니다. executor NetworkPolicy에는 이 규칙이 없고, public egress의 `except`에도 설정된 DB CIDR을 넣습니다.
- log/metrics ingester는 기본값이 비활성입니다. production에서 활성화하려면 각각의 digest와 공용 `database.existingSecret`을 준비하고, Kubernetes Service VIP용 `observability.networkPolicy.kubernetesApiEgress.cidrs`, 실제 API server backend용 `endpointCidrs`, 그리고 `databaseEgress.selectorPeers` 또는 `databaseEgress.cidrs`를 명시해야 합니다. 기본 포트는 각각 443과 6443이며 서로 다른 NetworkPolicy 규칙으로 렌더링되어 DNAT 전후 어느 지점에서 정책이 적용돼도 정확한 목적지만 허용합니다. 대상이 비어 있으면 Helm render가 실패합니다.
- log ingester service account는 Pod 조회와 `pods/log` 읽기만, metrics ingester service account는 `metrics.k8s.io` Pod 조회만 허용합니다. metrics ingester를 활성화하는 cluster에는 Metrics API를 제공하는 metrics-server 등도 필요합니다.
- 두 ingester는 외부 HTTP endpoint나 Service를 열지 않는 batch-style worker입니다. 자체 health endpoint가 없으므로 HTTP probe를 만들지 않으며, 치명 오류 시 process 종료와 Deployment restart 정책으로 복구합니다.

### 7. 방화벽과 네트워크

| 방향 | 열어야 할 대상 |
| --- | --- |
| Public inbound | 80/443 -> ingress/load balancer |
| Private inbound | PostgreSQL, Redis, registry, object storage, Kubernetes API |
| Admin only | SSH, Kubernetes API 직접 접근, DB admin endpoint |
| Outbound | GitHub API/webhook response, registry, package mirror, object storage |

Cloudflare Tunnel 배포에서는 public inbound 80/443도 origin 서버에 직접 열지 않고, `cloudflared` outbound와 내부 ingress/service 통신만 허용하는 구성을 권장합니다. API/Dashboard는 localhost 또는 cluster Service로 bind하고, 외부에서 `3000`, NodePort, registry, DB/Redis/provider port에 직접 닿지 못하게 막습니다.

DB, Redis, provider credential endpoint는 public internet에 직접 노출하지 않습니다. PostgreSQL/MySQL/Redis public tunnel은 일반 사용자 접속 경로로 쓰지 말고, DB console은 RAIBITSERVER API mediated access로 유지합니다. 운영자 TCP 접속은 WARP/private network/SSH bastion으로 분리하세요. GitHub webhook은 API public endpoint로 받아야 하므로 webhook secret/HMAC 검증이 필수이며, Cloudflare Cache Rules에서는 `/api/*`, `/api/*/stream`, `/github/webhooks`, `/api/github/webhooks`를 cache bypass로 둡니다.

### 8. 백업, 복구, 관측성

- PostgreSQL은 PITR 또는 주기 백업을 켜고, migration 전 스냅샷을 남깁니다.
- object storage bucket, registry image retention, Kubernetes secret 백업 정책을 정합니다.
- audit log, workflow job, deployment event, preview cleanup event를 일정 기간 보관합니다.
- `/health` 또는 ingress health check, worker backlog, failed workflow, quota violation, GitHub webhook 401/5xx를 모니터링합니다.
- worker/API 실패는 표준 `errorCode`와 `lastErrorSpec`/deployment event metadata로 남겨 대시보드와 CLI가 같은 사용자 안내 문구와 retry 가능 여부를 표시할 수 있게 합니다.
- 복구 리허설은 “DB restore → API boot → worker reconcile → 기존 서비스 URL 정상화” 순서로 확인합니다.

### 9. go-live 직전 검증

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm prisma:validate
pnpm prisma:generate
sh scripts/verify-helm.sh
pnpm e2e:live
node src/cli.js validate examples/project.json
node src/cli.js manifest examples/project.json >/tmp/raibitserver-manifest.json
node src/cli.js compose examples/docker-compose.yml >/tmp/raibitserver-compose-plan.json
```

Go가 설치된 운영 빌드 환경에서는 다음도 함께 확인합니다.

```sh
for dir in services/builder services/orchestrator services/provisioner services/log-ingester services/metrics-ingester; do
  (cd "$dir" && go test ./... && go build ./...)
done
```

Production 세부 항목은 [Production 배포 문서](deploy/production/README.md), 검증 기준은 [베타 출시 기준](docs/beta-criteria.md)과 [검증 명령 매트릭스](docs/verification-commands.md)를 함께 확인하세요.

## DB와 리소스 지원 범위

RAIBITSERVER의 관리형 리소스는 raw compose container가 아니라 프로젝트에 연결되는 catalog resource입니다. TypeScript의 `shared-small` plan은 향후 공유 provider 안에 tenant primitive를 생성하기 위한 provider-neutral 계약입니다. 현재 authoritative Go live adapter는 이 공유 모델을 아직 실행하지 않으며, 각 리소스를 프로젝트 namespace의 전용 PVC/Service/StatefulSet으로 생성하는 `raibitserver-local-*` 구현입니다. 따라서 현재 live 경로를 shared capacity나 tenant-level backup/ACL이 구현된 것으로 해석하면 안 됩니다.

| 엔진 | 로컬 proof | Provider contract |
| --- | --- | --- |
| PostgreSQL | dry-run + dedicated-local 구현; release live evidence 대기 | immutable credential, authenticated `SELECT 1`, `DATABASE_URL` Secret ref |
| MySQL/MariaDB | dry-run + dedicated-local 구현; release live evidence 대기 | immutable credential, authenticated `SELECT 1` |
| MongoDB | dry-run + dedicated-local 구현; release live evidence 대기 | immutable credential, authenticated ping |
| Redis/Valkey | dry-run + dedicated-local 구현; release live evidence 대기 | immutable credential, authenticated `PING` |
| SQLite | 실행 가능한 로컬 console | Go live managed-resource adapter 대상 아님 |
| Object Storage | MinIO/S3 env plan | bucket bootstrap/HeadBucket 전까지 live fail-closed |
| Qdrant/vector | collection/search-test plan | collection bootstrap/auth check 전까지 live fail-closed |
| NATS/queue | subject/connection plan | stream/subject bootstrap/auth smoke 전까지 live fail-closed |

공유 provider의 noisy-neighbor 제어, PgBouncer, tenant별 role/ACL/quota, primitive 단위 백업·복구는 목표 계약이며 현재 Go live adapter의 완료 기능이 아닙니다. Closed Beta에서는 위 6개 dedicated-local 엔진만 digest-pinned certified image와 인증 probe를 통과한 경우 활성화하고, 나머지는 계획만 제공하거나 실패하도록 운영해야 합니다.

자세한 내용은 [리소스 프로비저닝](docs/provisioning.md)과 [DB console](docs/db-console.md)을 참고하세요.

## 문제 해결

자주 발생하는 문제는 [troubleshooting](docs/troubleshooting.md)에 정리되어 있습니다.

- `pnpm install --frozen-lockfile` 실패: Node.js 24+와 pnpm 11.1.2를 확인합니다.
- Production API 부팅 실패: `DATABASE_URL`, auth secret, encryption key를 확인합니다.
- dry E2E는 성공하지만 live E2E가 실패: Docker daemon, kind, kubectl, Helm, Go가 준비됐는지 확인하고, 실패 시 출력되는 control-plane/provider namespace diagnostics를 확인합니다.
- DB console query 거부: 역할, `confirmed: true`, provider-owned connection 여부를 확인합니다.

## 지원, 라이선스, 변경 이력

- 지원/문의: 저장소 이슈 트래커([GitHub Issues](https://github.com/jsk1004ha/RaibitSever/issues)) 또는 프로젝트 운영 채널을 사용합니다.
- 라이선스: [Apache-2.0](LICENSE)
- 변경 이력: [CHANGELOG.md](CHANGELOG.md)

## 문서 작성 기준

이 README와 하위 문서는 “프로젝트 목적, 설치/사용 방법, 문제 해결, 지원/라이선스, 심화 링크를 간결하게 제공하고 긴 내용은 별도 문서로 분리한다”는 원칙으로 정리했습니다. 작성 기준은 InfoGrab의 [좋은 README 작성하는 방법](https://insight.infograb.net/blog/2023/08/23/good-readme/)을 참고했습니다.
