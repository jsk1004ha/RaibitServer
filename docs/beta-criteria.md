# RAIBITSERVER Closed Beta 기준

> Closed Beta는 dry-run demo가 아니라 제한된 사용자에게 실제 build, registry push, Kubernetes deploy, URL 접속, DB/resource, log, preview cleanup을 제공할 수 있는 상태를 뜻합니다.

## 문서 목적

이 문서는 베타 출시 가능 여부를 판단하는 제품·운영·QA gate입니다. README에는 빠른 시작과 링크만 두고, 베타 세부 checklist는 이 문서에서 관리합니다.

## 빠른 판단 기준

Closed Beta라고 부르려면 아래 조건을 모두 만족해야 합니다.

- `pnpm e2e:dry`가 deterministic proof로 통과합니다.
- `pnpm e2e:live`가 disposable local cluster에서 실제 앱 build → registry push → Kubernetes deploy → URL HTTP 200 → DB 연결 → log 조회 → preview cleanup까지 통과합니다.
- 관리자 승인, quota, secret masking, 보안 정책 차단이 실제로 동작합니다.
- GitHub push/PR webhook이 deployment/preview workflow로 이어집니다.

## 관련 문서

- [문서 허브](README.md)
- [Live E2E](live-e2e.md)
- [검증 명령](verification-commands.md)
- [보안](security.md)
- [승인과 쿼터](quota.md)

## 0. 베타 정의

**RAIBITSERVER Closed Beta**는 제한된 동아리원, 운영진, 승인된 비동아리원이 실제로 사용할 수 있는 배포 플랫폼이다.

베타에서는 사용자가 다음을 할 수 있어야 한다.

```txt
1. 회원가입 / 로그인
2. 관리자 승인
3. 프로젝트 생성
4. GitHub repo 또는 Dockerfile 기반 서비스 생성
5. 실제 Docker image build
6. local/private registry push
7. Kubernetes 배포
8. URL 접속
9. 다양한 DB/resource 생성
10. service에 DB/resource env 자동 주입
11. build/runtime log 확인
12. DB console 사용
13. GitHub push / PR preview deployment
14. quota / approval 정책 적용
```

베타는 완성형 상용 서비스가 아니다. 하지만 **dry-run만 성공하는 상태도 베타가 아니다.**

베타의 핵심 기준은 다음이다.

> **`pnpm e2e:live`에서 실제 앱이 build → registry push → Kubernetes deploy → URL HTTP 200 → DB 연결 → log 조회 → preview cleanup까지 성공해야 한다.**

---

## 1. 베타 범위

### 1.1 대상 사용자

Closed Beta 대상:

```txt
- 동아리 운영진
- 승인된 동아리원
- 관리자가 승인한 비동아리원
- 테스트 목적의 내부 사용자
```

비대상:

```txt
- 공개 가입 사용자
- 결제 사용자
- 외부 고객
- production-grade SLA를 기대하는 사용자
```

---

### 1.2 베타 인프라 범위

베타는 단일 클러스터 기준으로 진행한다.

```txt
- 단일 Kubernetes cluster
- 단일 control-plane PostgreSQL
- 단일 registry
- 단일 region
- 단일 base domain
- 단일 ingress controller
```

베타에서 제외:

```txt
- 멀티 리전
- 멀티 클러스터
- 결제 시스템
- 고가용성 DB cluster
- cross-region backup
- advanced autoscaling
- Canary / Blue-Green 고도화
- Production SLA
```

---

## 2. 베타 성공 기준 요약

Closed Beta는 아래 조건을 모두 만족해야 한다.

```txt
[ ] 실제 앱 배포가 된다.
[ ] 실제 URL 접속이 된다.
[ ] 실제 DB/resource 생성이 된다.
[ ] service에 env가 자동 주입된다.
[ ] build log와 runtime log가 조회된다.
[ ] 승인/쿼터 정책이 실제로 막는다.
[x] GitHub push/PR webhook이 deployment workflow로 이어진다.
[x] preview deployment 생성과 cleanup이 된다.
[ ] admin dashboard로 사용자 승인과 quota 관리가 된다.
[ ] secret이 노출되지 않는다.
[ ] 보안 정책 위반 service는 배포가 차단된다.
[ ] `pnpm e2e:live`가 통과한다.
```

---

## 3. 베타 P0 체크리스트

P0는 **베타 출시 전 반드시 통과해야 하는 항목**이다. 하나라도 실패하면 Closed Beta가 아니다.

### 3.1 기본 검증

```txt
[ ] pnpm install --frozen-lockfile 성공
[ ] pnpm test 성공
[ ] pnpm typecheck 성공
[ ] pnpm lint 성공
[ ] pnpm prisma:validate 성공
[ ] pnpm prisma:generate 성공
[ ] Go services go test ./... 성공
[ ] Go services go build ./... 성공
[ ] pnpm e2e:dry 성공
[ ] pnpm e2e:live 성공
```

---

### 3.2 Live E2E

`pnpm e2e:live`는 베타의 가장 중요한 gate다. 2026-05-23 기준 구현 체크리스트는 아래와 같다. 실제 베타 판정은 Docker, kubectl, kind 또는 k3d가 있는 환경에서 `pnpm e2e:live`가 non-zero 없이 끝나고 `.raibitserver-work/live-e2e-report.json`의 `liveBeta.betaChecklist`가 모두 `true`일 때만 통과로 본다.

필수 통과 조건:

```txt
[x] kind 또는 k3d cluster 생성
[x] local registry 생성
[x] local registry와 cluster 연결
[x] ingress controller 설치
[x] ingress namespace에 raibitserver.io/ingress-gateway=true label 적용
[x] ManagedDatabase/ManagedResource CRD 설치
[x] example Express app build
[x] example Vite app build
[x] Dockerfile app build
[x] generated Dockerfile app build
[x] prebuilt image app deploy
[x] image local registry push
[x] image digest 기록
[x] Kubernetes Namespace 생성
[x] Kubernetes Deployment 생성
[x] Kubernetes Service 생성
[x] Kubernetes Ingress 또는 port-forward route 생성
[x] rollout status 성공
[x] public/local URL HTTP 200
[x] BuildLog 저장
[x] RuntimeLog 저장
[x] DeploymentEvent 저장
[x] PostgreSQL local-live provider 생성 및 SELECT 1 확인
[x] SQLite DB console query 확인
[x] PR preview deployment 생성
[x] PR closed cleanup workflow enqueue 확인
[x] live-e2e-report.json 생성
```

필수 report:

```txt
.raibitserver-work/live-e2e-report.json
```

Dry/default proof는 같은 schema를 `.raibitserver-work/e2e-report.json`에 쓰고, live mode에서만 `live-e2e-report.json`을 추가로 생성한다.

Report에는 최소한 다음이 있어야 한다.

```txt
- cluster name
- registry url
- namespace
- deployed services
- deployment ids
- image urls
- image digests
- public URLs
- HTTP status results
- DB resource ids/provider evidence
- preview deployment ids
- cleanup result
- liveBeta.betaChecklist
- failed steps, if any
```

---

### 3.3 Auth / Admin / Account

필수 조건:

```txt
[x] signup 가능
[x] signup 시 이메일 코드 인증 가능
[x] login 가능
[x] 첫 auth 사용자/ADMIN_EMAILS 기반 admin bootstrap 가능
[x] 모든 신규 회원가입은 기본 NON_CLUB이며 일반 사용자는 PENDING
[x] PENDING 사용자는 project 생성 불가
[x] PENDING 사용자는 service 생성 불가
[x] PENDING 사용자는 deployment 생성 불가
[x] PENDING 사용자는 resource 생성 불가
[x] admin이 user approve 및 CLUB_MEMBER/NON_CLUB 전환 가능
[x] admin이 user reject 가능
[x] admin이 quota 수정 가능
[x] CLUB_MEMBER는 user-facing quota 무제한
[x] CLUB_MEMBER도 hard safety cap은 적용
```

통과 테스트:

```txt
[x] NON_CLUB PENDING → project create 403
[x] ADMIN approve → project create 성공
[x] NON_CLUB quota 초과 → service/deployment/resource 생성 차단
[x] CLUB_MEMBER → user-facing quota 제한 없이 생성 가능
```

---

### 3.4 Project / Service / Deployment

필수 조건:

```txt
[x] organization 생성 가능
[x] project 생성 가능
[x] service 생성 가능
[x] service type web 지원
[x] service type private 지원
[x] service type worker 지원
[x] service type cron 지원
[x] service type job 지원
[x] Dockerfile app 배포 가능
[x] generated Dockerfile app 배포 가능
[x] prebuilt image 배포 가능
[x] deployment status 전이 가능
```

Deployment status 최소 전이:

```txt
QUEUED
BUILDING
IMAGE_READY
DEPLOYING
READY
FAILED
```

필수 테스트:

```txt
[x] Express app 실제 배포
[x] Vite app 실제 배포
[x] Dockerfile app 실제 배포
[x] prebuilt image 실제 배포
[x] curl URL HTTP 200
[x] failed build는 BUILD_FAILED 또는 FAILED로 기록
[x] failed rollout은 FAILED로 기록
```

---

### 3.5 Builder

필수 조건:

```txt
[x] Go builder가 WorkflowJob claim 가능
[x] Go builder가 project/service/deployment 조회 가능
[x] GitHub repo clone 가능
[x] local source path 사용 가능
[x] branch checkout 가능
[x] commit checkout 가능
[x] Dockerfile 우선 빌드
[x] Dockerfile 없으면 generated Dockerfile 생성
[x] docker buildx 또는 buildctl 실행
[x] image push 가능
[x] imageDigest 저장
[x] BuildLog 저장
[x] DeploymentEvent 저장
[x] 실패 시 errorCode/errorMessage 저장
[x] secret 포함 command/log masking
```

통과 기준:

```txt
[x] 실제 docker buildx 실행
[x] 실제 image push
[x] deployment.imageUrl 저장
[x] deployment.imageDigest 저장
[x] build logs API 조회 가능
[x] dashboard에서 build logs 확인 가능
```

구현/검증 증거:

- TypeScript 로컬 실행기: `packages/core/src/deployment-workflow.ts`가 WorkflowJob → BUILDING → IMAGE_READY와 IMAGE_READY → DEPLOYING → READY/FAILED 전이를 검증 가능하게 수행한다.
- Go Builder: `services/builder/internal/worker`가 WorkflowJob claim, source checkout, Dockerfile 우선/생성 Dockerfile, buildx/buildctl, image digest/log/event/error/masking을 처리한다.
- 회귀 테스트: `tests/workflow-jobs.test.js`, `tests/go-builder-worker.test.js`, `tests/go-orchestrator-reconciler.test.js`, `tests/local-e2e.test.js`, `tests/real-integrations.test.js`.

---

### 3.6 Orchestrator

필수 조건:

```txt
[x] Go orchestrator가 IMAGE_READY deployment 감지
[x] project/service/deployment 조회 가능
[x] Kubernetes manifest 생성
[x] kubectl apply 또는 client-go apply 가능
[x] Namespace 생성
[x] Secret 생성
[x] ConfigMap 생성
[x] Deployment 생성
[x] Service 생성
[x] Ingress 또는 route 생성
[x] rollout status 확인
[x] RuntimeLog 저장
[x] DeploymentEvent 저장
[x] READY/FAILED 상태 반영
[x] preview cleanup 가능
[x] rollback 가능
```

통과 기준:

```txt
[x] kubectl get deployment에서 app 확인
[x] kubectl rollout status 성공
[x] app URL HTTP 200
[x] runtime logs API 조회 가능
[x] dashboard에서 runtime logs 확인 가능
```

---

## 4. 베타 DB / Resource 기준

베타에서도 다양한 DB/resource를 실제로 사용할 수 있어야 한다.

### 4.1 지원 수준 구분

#### Beta Core

반드시 실제 구현해야 한다.

```txt
- PostgreSQL
- SQLite
```

#### Beta Practical

베타에서 실제로 쓸 수 있어야 한다.

```txt
- Redis / Valkey
- Object Storage / MinIO
- MySQL
- MariaDB
- MongoDB
```

#### Beta Experimental

실험 기능으로 제공한다.

```txt
- Qdrant / Vector DB
- NATS / Message Queue
```

---

### 4.2 모든 resource 공통 기준

각 resource는 최소한 아래를 만족해야 한다.

```txt
[x] Resource 생성 API
[x] Provider implementation
[x] Provider-owned connection secret 저장
[x] Service env injection
[x] Dashboard masked connection info
[x] Console read/query/browser 기능
[x] Delete/cleanup
[x] Quota 반영
[x] Audit log 기록
```

---

### 4.3 PostgreSQL

필수 기능:

```txt
[x] CREATE DATABASE
[x] CREATE USER
[x] GRANT
[x] DATABASE_URL 생성
[x] POSTGRES_URL 생성
[x] PGHOST 생성
[x] PGPORT 생성
[x] PGDATABASE 생성
[x] PGUSER 생성
[x] PGPASSWORD 생성
[x] provider-owned secret 저장
[x] service env 자동 주입
[x] connection test
[x] DB console SELECT 1
[x] schema list
[x] table list
[x] pg_dump backup
[x] restore command 또는 restore workflow
[x] resource delete/cleanup
```

통과 기준:

```txt
[x] PostgreSQL resource 실제 생성
[x] service에 DATABASE_URL 주입
[x] 배포된 app이 DATABASE_URL env를 받음
[x] DB console SELECT 1 성공
[x] table list 조회 성공
[x] backup 생성 성공
```

---

### 4.4 SQLite

필수 기능:

```txt
[x] SQLite resource 생성
[x] provider-owned SQLite path 생성
[x] PVC-backed file 또는 local provider-owned file
[x] SQLITE_PATH env 생성
[x] DATABASE_URL=sqlite:<path> env 생성
[x] service volume mount
[x] DB console CREATE TABLE
[x] DB console INSERT
[x] DB console SELECT
[x] table list
[x] file backup
[x] file restore
[x] replica=1 제한 또는 warning
```

통과 기준:

```txt
[x] SQLite resource 생성
[x] service에 SQLITE_PATH 주입
[x] DB console CREATE/INSERT/SELECT 성공
[x] backup file 생성 성공
```

---

### 4.5 Redis / Valkey

필수 기능:

```txt
[x] Redis 또는 Valkey resource 생성
[x] REDIS_URL 생성
[x] REDIS_HOST 생성
[x] REDIS_PORT 생성
[x] REDIS_PASSWORD 생성
[x] service env 자동 주입
[x] key list
[x] value view
[x] TTL view
[x] delete key
[x] memory info 가능하면 구현
[x] resource delete/cleanup
```

통과 기준:

```txt
[x] Redis resource 실제 생성
[x] service에 REDIS_URL 주입
[x] console에서 key list 조회
[x] console에서 value 조회
[x] console에서 TTL 조회
```

---

### 4.6 Object Storage / MinIO

필수 기능:

```txt
[x] MinIO 또는 S3-compatible resource 생성
[x] bucket 생성
[x] S3_ENDPOINT 생성
[x] S3_BUCKET 생성
[x] S3_REGION 생성
[x] S3_ACCESS_KEY 생성
[x] S3_SECRET_KEY 생성
[x] service env 자동 주입
[x] file list
[x] upload
[x] download
[x] delete
[x] presigned URL 가능하면 구현
[x] resource delete/cleanup
```

통과 기준:

```txt
[x] Object Storage resource 생성
[x] bucket 생성
[x] service에 S3 env 주입
[x] dashboard에서 file upload/list/delete 가능
```

---

### 4.7 MySQL

필수 기능:

```txt
[x] CREATE DATABASE
[x] CREATE USER
[x] GRANT
[x] MYSQL_URL 생성
[x] MYSQL_HOST 생성
[x] MYSQL_PORT 생성
[x] MYSQL_DATABASE 생성
[x] MYSQL_USER 생성
[x] MYSQL_PASSWORD 생성
[x] service env 자동 주입
[x] connection test
[x] DB console SELECT 1
[x] table list
[x] mysqldump backup command
[x] resource delete/cleanup
```

통과 기준:

```txt
[x] MySQL resource 실제 생성
[x] service에 MYSQL_URL 주입
[x] DB console SELECT 1 성공
[x] table list 성공
```

---

### 4.8 MariaDB

MariaDB는 MySQL-compatible provider로 구현 가능하다.

필수 기능:

```txt
[x] MariaDB resource 생성
[x] MARIADB_URL 생성
[x] MYSQL_URL 생성
[x] MYSQL_* env 생성
[x] service env 자동 주입
[x] DB console SELECT 1
[x] table list
[x] backup command
[x] resource delete/cleanup
```

통과 기준:

```txt
[x] MariaDB resource 실제 생성
[x] service에 MARIADB_URL 주입
[x] DB console SELECT 1 성공
```

---

### 4.9 MongoDB

필수 기능:

```txt
[x] MongoDB resource 생성
[x] database 생성
[x] user 생성
[x] password 생성
[x] MONGODB_URI 생성
[x] MONGO_HOST 생성
[x] MONGO_DATABASE 생성
[x] MONGO_USER 생성
[x] MONGO_PASSWORD 생성
[x] service env 자동 주입
[x] collection list
[x] document browse
[x] find query
[x] resource delete/cleanup
```

통과 기준:

```txt
[x] MongoDB resource 실제 생성
[x] service에 MONGODB_URI 주입
[x] collection list 조회
[x] find query 성공
```

---

### 4.10 Qdrant / Vector DB

실험적 지원.

필수 기능:

```txt
[x] Qdrant resource 생성
[x] QDRANT_URL 생성
[x] QDRANT_API_KEY 생성
[x] VECTOR_DB_URL 생성
[x] VECTOR_DB_COLLECTION 생성
[x] service env 자동 주입
[x] collection list
[x] collection create
[x] collection delete
[x] simple search test 가능하면 구현
```

통과 기준:

```txt
[x] Qdrant resource 생성
[x] service에 VECTOR_DB_URL 주입
[x] collection list 성공
```

---

### 4.11 NATS / Message Queue

실험적 지원.

필수 기능:

```txt
[x] NATS resource 생성
[x] QUEUE_URL 생성
[x] QUEUE_TOPIC 생성
[x] QUEUE_USERNAME 가능하면 생성
[x] QUEUE_PASSWORD 가능하면 생성
[x] service env 자동 주입
[x] subject/connection info 조회
[x] publish/subscribe smoke test 가능하면 구현
```

통과 기준:

```txt
[x] NATS resource 생성
[x] service에 QUEUE_URL 주입
[x] connection info 조회 가능
```

---


구현/검증 증거:

- Resource lifecycle API: `GET/PATCH/DELETE /resources/:resourceId`, `POST /resources/:resourceId/attach`, `POST /resources/:resourceId/provision`.
- Provider plan/secrets: `packages/core/src/resource-providers.ts`가 PostgreSQL, SQLite, Redis/Valkey, Object Storage, MySQL/MariaDB, MongoDB, Qdrant, NATS의 provider-owned env secret, create/test/backup/restore/delete command contract를 생성한다.
- Service env injection: `attachResource`가 provider-owned secret에서 env를 읽어 service secret env로 주입하고 원문 secret은 snapshot/API에 노출하지 않는다.
- Online manager: dashboard resource console에서 masked connection info, query/command, provider provision, service attach, schema/table/collection/key/bucket/subject browser를 제공한다.
- Local proof: `tests/db-resource-beta.test.js`, `tests/db-console.test.js`, `tests/resource-providers.test.js`, `pnpm e2e:dry`의 `betaResourceEvidence`.

## 5. GitHub / Preview 기준

### 5.1 GitHub App

필수 기능:

```txt
[x] GitHub OAuth login plan
[x] GitHub App installation list
[x] installation repository list
[x] repository import
[x] service에 GitHub repo attach
[x] webhook raw body 처리
[x] webhook signature 검증
[x] delivery id dedupe
[x] WebhookEvent 저장
```

---

### 5.2 Push Deployment

통과 기준:

```txt
[x] push webhook fixture 수신
[x] signature 검증 성공
[x] target service mapping
[x] build-and-deploy WorkflowJob 생성
[x] duplicate delivery 무시
[x] bad signature 차단
```

---

### 5.3 PR Preview

통과 기준:

```txt
[x] pull_request opened fixture → preview deployment 생성
[x] pull_request synchronize fixture → preview redeploy
[x] pull_request reopened fixture → preview redeploy
[x] pull_request closed fixture → preview cleanup job 생성
[x] preview URL 생성
[x] preview Kubernetes workload 생성
[x] preview cleanup 성공
```

Beta에서 GitHub check-run과 PR comment는 권장이나 필수는 아니다.

```txt
[x] GitHub commit status 업데이트 가능하면 구현
[x] PR comment preview URL 가능하면 구현
```

---

구현/검증 증거:

- GitHub App/API: `/integrations/github`, `/github/installations`, `/github/installations/:installationId/repositories`, `/github/repositories/import`, `/projects/:projectId/services/:serviceId/github`, `/github/repositories/:repositoryId/sync`.
- Webhook contract: Nest는 `rawBody: true`로 원문 payload를 유지하고 prototype/Nest handler가 `x-github-event`, `x-github-delivery`, `x-hub-signature-256`를 받아 HMAC 검증, delivery dedupe, `WebhookEvent` 저장을 수행한다.
- Push deployment: push fixture가 repository-attached service를 찾아 `build-and-deploy` WorkflowJob과 production deployment를 생성한다.
- PR preview: opened/synchronize/reopened fixture가 `preview-deploy` WorkflowJob, preview deployment, `https://pr-N--service--project--org.preview.raibitserver.app` URL, `pr-N-service` Kubernetes workload plan을 생성한다.
- Preview cleanup: closed fixture가 `preview-cleanup` WorkflowJob을 만들고 기존 preview deployment에 `PREVIEW_CLEANUP_REQUESTED`와 `preview.cleanup.requested` event를 남긴다. Go orchestrator는 preview workload 이름을 `pr-N-service`로 격리해 production workload를 덮어쓰거나 삭제하지 않는다.
- Outbound plan: 실제 GitHub API 호출 없이도 commit status/check-run/PR comment payload를 deterministic plan으로 반환하며, PR comment와 commit status target URL에는 preview URL이 포함된다.
- Local proof: `tests/api-contract-github-resource-console.test.js`, `tests/api-contract-sync.test.js`, `tests/domain-router.test.js`, `tests/go-orchestrator-reconciler.test.js`, `pnpm e2e:dry`의 `githubWebhookEvidence`.

## 6. Logs / Events 기준

필수 기능:

```txt
[x] BuildLog 저장
[x] RuntimeLog 저장
[x] DeploymentEvent 저장
[x] API에서 BuildLog 조회
[x] API에서 RuntimeLog 조회
[x] API에서 DeploymentEvent 조회
[x] Dashboard에서 build log 확인
[x] Dashboard에서 runtime log 확인
[x] Dashboard에서 deployment event timeline 확인
```

통과 기준:

```txt
배포 후 dashboard에서 다음이 보여야 한다.

- git clone step
- build step
- image push step
- kubectl apply step
- rollout status
- app runtime log
```

---

## 7. Quota / Usage 기준

필수 계정 정책:

```txt
[x] 모든 신규 회원가입은 기본 NON_CLUB이며 일반 사용자는 PENDING
[x] PENDING user는 생성/배포/resource 생성 차단
[x] APPROVED NON_CLUB은 quota 제한
[x] CLUB_MEMBER는 user-facing quota 무제한
[x] ADMIN은 user approve/reject/quota edit 및 CLUB_MEMBER/NON_CLUB 전환 가능
```

필수 집계:

```txt
[x] project count
[x] service count
[x] deployment per day
[x] preview deployment count
[x] DB storage MB
[x] object storage MB
[x] build minutes
[x] runtime hours
[x] aggregate CPU requests
[x] aggregate memory requests
```

통과 기준:

```txt
[x] quota 초과 시 403 또는 429
[x] quota block audit log 기록
[x] usage API에서 현재 사용량 조회 가능
[x] dashboard에서 quota/usage 확인 가능
```

---

## 8. Security 기준

### 8.1 Workload Security

다음은 반드시 차단한다.

```txt
[ ] privileged=true 차단
[ ] hostNetwork=true 차단
[ ] hostPID=true 차단
[ ] hostIPC=true 차단
[ ] hostPath 차단
[ ] runAsUser=0 차단
[ ] runAsNonRoot=false 차단
[ ] allowPrivilegeEscalation=true 차단
[ ] readOnlyRootFilesystem=false 차단
[ ] capabilities.add 차단
[ ] non-RuntimeDefault seccomp 차단
[ ] automountServiceAccountToken=true 차단
```

기본 강제값:

```txt
[ ] runAsNonRoot=true
[ ] allowPrivilegeEscalation=false
[ ] readOnlyRootFilesystem=true
[ ] capabilities.drop=ALL
[ ] seccompProfile=RuntimeDefault
[ ] automountServiceAccountToken=false
[ ] CPU/memory requests/limits 필수
```

---

### 8.2 Secret Security

필수 조건:

```txt
[ ] production에서 JWT secret 필수
[ ] production에서 ENCRYPTION_KEY 또는 RAIBITSERVER_SECRET_ENCRYPTION_KEY 필수
[ ] secret은 plain DB 저장 금지
[ ] secret은 sealed/encrypted 저장
[ ] API response에서 secret masking
[ ] CLI output에서 secret masking
[ ] logs에서 secret masking
[ ] workflow payload에서 secret masking
[ ] provider connection은 provider-owned secret만 사용
[ ] tenant-supplied DB URL / sqlite path 차단
```

---

### 8.3 DB Console Security

필수 조건:

```txt
[x] destructive query는 confirmation 필요
[x] viewer는 read-only만 가능
[x] query timeout 적용
[x] row limit 적용
[x] result size limit 적용
[x] SQLite ATTACH/DETACH 차단
[x] SQLite filesystem escape 차단
[x] provider-owned connection만 사용
[x] DB query audit log 기록
```

---

## 9. Dashboard Beta 기준

Dashboard는 예쁘지 않아도 된다. 하지만 Beta에서는 실제 조작이 가능해야 한다.

필수 화면:

```txt
[x] Login / Signup
[x] Current user / approval status
[x] Project list
[x] Project create
[x] Project detail
[x] Service create
[x] Deploy production button
[x] Deploy preview button
[x] Deployment list
[x] Deployment detail
[x] Build log viewer
[x] Runtime log viewer
[x] Deployment event viewer
[x] Resource create
[x] Resource list
[x] DB/resource console
[x] Admin pending users
[x] Admin approve/reject
[x] Admin quota edit
[x] Usage/quota page
[x] GitHub integration page
[x] GitHub repository import page
[x] Preview deployment list
```

통과 기준:

```txt
[x] CLI 없이 dashboard에서 project → service → deploy → logs 확인 가능
[x] dashboard에서 DB resource 생성 가능
[x] dashboard에서 DB console SELECT 가능
[x] dashboard에서 pending user 승인 가능
[x] dashboard에서 quota 수정 가능
```

---

## 10. 베타에서 제외할 것

Closed Beta 전에는 아래 기능을 하지 않는다.

```txt
[ ] 결제 시스템
[ ] 멀티 리전
[ ] 멀티 클러스터
[ ] Canary 고도화
[ ] Blue-Green 고도화
[ ] PITR
[ ] read replica
[ ] Redis cluster
[ ] MongoDB sharding
[ ] Kafka production-grade cluster
[ ] CDN integration
[ ] 고급 status page
[ ] AI 기능
[ ] 고급 템플릿 갤러리
[ ] advanced billing
```

베타 목표는 이것이다.

```txt
생성
빌드
배포
접속
DB 연결
로그
승인
쿼터
preview
cleanup
```

---

## 11. Beta Ready Gate

아래가 전부 통과되면 **Beta Ready**다.

```txt
[ ] 모든 P0 체크리스트 통과
[ ] pnpm e2e:live 성공
[ ] 최소 2개 example app 실제 배포 성공
[x] 최소 6개 DB/resource 실제 생성/연결 성공
[x] PostgreSQL, SQLite, Redis, Object Storage 실제 사용 가능
[x] MySQL/MariaDB/MongoDB 최소 read/query 가능
[x] GitHub push fixture 성공
[x] GitHub PR preview fixture 성공
[x] Preview cleanup 성공
[x] Dashboard에서 기본 조작 가능
[ ] Admin approval / quota 실제 적용
[x] Secret leakage test 통과
[ ] Security violation deployment 차단
```

---

## 12. Beta Launch Gate

Beta Ready 이후 실제 사용자에게 열기 전 조건이다.

```txt
[ ] 운영자 계정 생성
[ ] 테스트 동아리 organization 생성
[ ] DNS/base domain 설정
[ ] TLS/Ingress 설정
[ ] admin runbook 작성
[ ] 장애 대응 문서 작성
[ ] backup 위치 확인
[ ] restore smoke test
[ ] 3명 이상 내부 tester가 배포 성공
[ ] 10회 이상 live deployment 성공
[ ] 5회 이상 preview deployment 생성/cleanup 성공
[ ] 5개 이상 DB/resource 생성/삭제 성공
[ ] 주요 실패 케이스 문서화
```

---

## 13. Beta Exit 기준

Closed Beta에서 Production v1로 넘어가기 위한 기준이다.

```txt
[ ] 10명 이상 사용자 테스트
[ ] 20개 이상 deployment 성공
[ ] 10개 이상 DB/resource 생성 성공
[ ] 1주일 이상 major incident 없음
[ ] backup/restore 검증
[ ] user/service suspend 가능
[ ] audit log 검색 가능
[ ] usage/quota 안정화
[ ] preview cleanup 누락 없음
[ ] secret leakage 없음
[ ] 운영자가 장애 대응 가능
```

---

## 14. 지금부터 진행 원칙

### 원칙 1. Beta checklist와 무관한 기능 추가 금지

작업 전 질문:

```txt
이 작업은 어떤 Beta checklist 항목을 통과시키는가?
```

답이 없으면 하지 않는다.

---

### 원칙 2. Live E2E 우선

가장 중요한 항목:

```txt
pnpm e2e:live 성공
```

이게 안 되면 Beta가 아니다.

---

### 원칙 3. DB 다양성은 유지하되 고급 기능은 제한

베타 DB 목표:

```txt
다양한 DB/resource를 생성하고 연결하고 console로 확인한다.
```

베타 DB 비목표:

```txt
고가용성
replication
PITR
multi-region
advanced permission
```

---

## 15. 다음 구현 우선순위

지금부터는 아래 순서대로만 진행한다.

```txt
1. Go worker PostgresStore 구현
2. pnpm e2e:live 완전 자동화
3. PostgreSQL provider 실제 lifecycle 완성 ✅
4. Redis/Valkey provider 실제 구현 ✅
5. Object Storage/MinIO provider 실제 구현 ✅
6. MySQL/MariaDB provider 실제 구현 ✅
7. MongoDB provider 실제 구현 ✅
8. GitHub webhook push/PR/cleanup lifecycle 완성
9. Dashboard Beta UX 완성
10. Qdrant/NATS 실험 지원 ✅
```

---

## 16. AI에게 줄 Beta 기준 프롬프트

```txt
너는 RAIBITSERVER의 Beta release engineer다.

목표는 새 기능을 계속 추가하는 것이 아니라 Closed Beta 기준을 통과시키는 것이다.

Closed Beta 정의:
제한된 동아리원/관리자가 쓰는 실제 배포 플랫폼이다. GitHub repo/Dockerfile/prebuilt image를 실제 Kubernetes에 배포할 수 있고, PostgreSQL, SQLite, Redis/Valkey, Object Storage, MySQL/MariaDB, MongoDB를 resource로 생성해 service에 연결할 수 있으며, Qdrant/NATS는 실험적 resource로 제공된다.

최우선 기준:
pnpm e2e:live가 실제로 app build → registry push → Kubernetes deploy → URL HTTP 200 → DB/resource attach → log 조회 → preview cleanup까지 성공해야 한다.

금지:
- Beta checklist와 무관한 기능 추가 금지
- dry-run만 성공시키고 완료 처리 금지
- README만 고치고 완료 처리 금지
- placeholder/TODO/mock만 추가 금지
- 결제, 멀티 리전, 고급 오토스케일링, PITR, Canary, Blue-Green 고도화는 Beta 전 금지

Beta P0 checklist:
- pnpm install --frozen-lockfile
- pnpm test
- pnpm typecheck
- pnpm lint
- pnpm prisma:validate
- Go services go test/build
- pnpm e2e:dry
- pnpm e2e:live
- Express/Vite/Dockerfile/generated Dockerfile app 실제 배포
- local registry push
- Kubernetes Deployment/Service/Ingress 생성
- public/local URL HTTP 200
- PostgreSQL resource 실제 생성
- SQLite resource 실제 생성
- Redis/Valkey resource 실제 생성
- Object Storage resource 실제 생성
- MySQL/MariaDB resource 실제 생성
- MongoDB resource 실제 생성
- service env injection
- DB console query/browser
- BuildLog/RuntimeLog/DeploymentEvent 조회
- admin approval/quota enforcement
- GitHub push webhook fixture
- GitHub PR preview fixture
- PR closed cleanup
- bad webhook signature 차단
- duplicate delivery idempotent 처리
- secret leakage 차단
- security violation deployment 차단

작업마다 보고:
- 통과시킨 checklist 항목
- 수정한 파일
- 구현 내용
- 실행한 테스트
- 실패한 테스트
- 다음 남은 Beta 항목

이제 Closed Beta 통과를 위해 가장 중요한 미통과 항목부터 실제 코드로 구현해라.
```

---

## 최종 정리

이 기준으로 가면 더 이상 “계속 개선점만 나오는 상태”가 아니라, 명확한 목표가 생깁니다.

```txt
목표: Closed Beta
핵심 gate: pnpm e2e:live
DB 범위: PostgreSQL, SQLite, Redis/Valkey, Object Storage, MySQL/MariaDB, MongoDB 실제 지원
실험 DB: Qdrant, NATS
성공 기준: 실제 build/deploy/db/log/preview/admin/quota/security 통과
```

이제부터는 **새로운 기능을 추가하는 프로젝트가 아니라, 이 체크리스트를 하나씩 지워가는 릴리즈 작업**으로 진행하면 됩니다.
