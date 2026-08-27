# RAIBITSERVER 아키텍처

> RAIBITSERVER는 TypeScript 제어 평면과 Go 인프라 reconcilers를 분리해, 사용자의 원하는 상태를 안전하게 실제 런타임 상태로 수렴시키는 플랫폼입니다.

## 목적

이 문서는 RAIBITSERVER의 주요 구성 요소, 데이터 흐름, 책임 경계를 설명합니다. 구현 세부 파일을 찾기 전 전체 구조를 이해할 때 사용합니다.

## 구성 요소

| 영역 | 위치 | 책임 |
| --- | --- | --- |
| Dashboard | `apps/dashboard` | 프로젝트, 서비스, 리소스, 로그, 승인/쿼터 관리 UI |
| Control Plane API | `apps/api` | 인증, RBAC, quota, audit, desired state 저장 |
| CLI | `apps/cli`, `src/cli.js` | API 조작과 로컬 smoke/manifest/compose 검증 |
| Core | `packages/core` | 빌드 전략, compose import, 도메인 라우팅, manifest compile, 보안/쿼터 규칙 |
| Shared packages | `packages/*` | schemas, API client, UI, config 공유 |
| Builder | `services/builder` | source/Dockerfile/image build, registry push, build log 기록 |
| Orchestrator | `services/orchestrator` | Kubernetes manifest apply, rollout 확인, runtime log/event 기록 |
| Provisioner | `services/provisioner` | 관리형 DB/storage/cache/vector/queue provider reconcile |
| Infra | `infra/*`, `deploy/*` | Terraform, Helm, CRD, 배포 환경 구성 |

## 핵심 흐름

```txt
사용자 입력/API 요청
  -> TypeScript API가 desired state 저장
  -> WorkflowJob 생성
  -> Go worker가 job claim
  -> build / k8s apply / resource provision 수행
  -> status, log, event, artifact 저장
  -> Dashboard/API/CLI에서 조회
```

## 설계 원칙

- 사용자 워크로드는 항상 **container image + Kubernetes desired state**로 귀결됩니다.
- 사용자 Dockerfile이 프레임워크 감지, buildpack, 생성 Dockerfile보다 우선합니다.
- API 요청 경로는 장시간 build/Kubernetes 작업을 직접 실행하지 않고 desired state와 job만 기록합니다.
- Go 서비스는 dry-run과 execute mode를 구분해 로컬 검증과 실제 실행을 분리합니다.
- local verification은 실제 Kubernetes, registry, cloud credential 없이 동작해야 합니다.

## 제어 평면과 인프라 경계

| 제어 평면이 하는 일 | Go 인프라 서비스가 하는 일 |
| --- | --- |
| 사용자/조직/프로젝트/서비스/리소스 모델 관리 | build, push, apply, provision 실행 |
| 인증, RBAC, quota, audit 처리 | job claim, retry, status update 처리 |
| desired state와 workflow job 저장 | 실제 인프라 상태를 desired state에 수렴 |
| secret 참조와 masking 정책 적용 | 실행 로그에서 secret 노출 방지 |

## 보안 기본값

생성 runtime artifact는 다음을 기본으로 합니다.

- namespace isolation
- NetworkPolicy
- non-root container
- privileged/hostPath/host networking 차단
- resource requests/limits
- dropped capabilities
- `RuntimeDefault` seccomp
- service account token automount 차단
- secret ref 기반 환경 변수 주입

자세한 내용은 [보안 문서](security.md)를 참고하세요.

## Builder 격리와 registry credential

Production Builder는 DB 연결 권한과 tenant Dockerfile 실행 권한을 같은 Pod에 두지 않습니다. 장기 실행 `builder-dispatcher` Deployment만 control-plane PostgreSQL에 연결하고, 기본적으로 매분 예약되는 CronJob batch는 최대 4개의 disposable `builder-executor` Pod를 병렬 실행합니다. CronJob batch 중첩은 `Forbid`로 막고 active executor 수는 `builder.isolation.parallelism`으로 제한합니다. 각 Pod는 mTLS RPC로 WorkflowJob 하나만 처리합니다. Executor에는 `DATABASE_URL`이나 Kubernetes service-account token이 없으며 executor NetworkPolicy에도 PostgreSQL egress가 없습니다. BuildKit은 executor의 Kubernetes native sidecar로만 살아 있으며 workspace, metadata, cache state와 함께 Pod 종료 시 폐기됩니다. gVisor 컨테이너 경계를 넘는 BuildKit 제어 연결은 Pod마다 생성한 단기 mTLS 인증서와 `127.0.0.1` TCP endpoint만 사용하므로, Dockerfile의 `RUN` 프로세스가 daemon API를 호출할 수 없습니다. Pod마다 Downward API의 UID를 worker ID로 사용하고, 재시작은 `Never`, Job backoff는 `0`입니다.

Dispatcher RPC는 TLS 1.3과 client certificate 검증을 강제하고, claim마다 암호학적 난수 session token을 발급해 verified client certificate fingerprint와 project/service/deployment/WorkflowLease에 묶습니다. Lease 기간과 갱신 시각은 client 입력이 아니라 dispatcher의 300초 정책과 server clock으로 결정합니다. Raw update RPC는 terminal build failure 기록과 credentialed repository URL redaction만 허용합니다. Raw update, build log, deployment event를 포함한 모든 DB-writing RPC는 PostgreSQL workflow lease row를 같은 transaction에서 잠그고 현재 attempt를 다시 확인합니다. 따라서 회수된 이전 attempt는 더 긴 session TTL이 남아 있어도 상태나 기록을 덮어쓸 수 없고 `IMAGE_READY` 전이는 scan/sign 뒤의 atomic publication RPC를 거쳐야 합니다. Helm `builder.dispatch.existingSecret`은 이 release 전용 CA와 `server.crt`/`server.key`/`client.crt`/`client.key`를 제공해야 하며 server certificate SAN은 `<release>-builder-dispatcher` Service DNS를 포함해야 합니다. Executor volume에는 CA와 client keypair만 선택적으로 투영되므로 server private key와 DB Secret은 들어가지 않습니다. Dispatcher가 재시작해 session을 잃으면 executor 요청은 실패하고 DB lease 만료 후 안전하게 재claim됩니다.

Rootless BuildKit은 process sandbox를 유지합니다. chart는 위험한 `--oci-worker-no-process-sandbox`를 전달하지 않으므로, 선택한 `runtimeClassName`과 builder node가 sandboxed rootless BuildKit을 지원하지 않으면 startup probe 단계에서 fail-closed합니다. 실제 클러스터 출시는 이 runtime 조합의 live build 증거가 필요합니다.

Production에는 registry-wide Docker config를 mount하지 않습니다. 외부 HTTPS credential broker가 다음 요청에 대해 최대 900초짜리 `pull`/`push` credential을 발급해야 합니다.

```json
{
  "organizationId": "...",
  "projectId": "...",
  "serviceId": "...",
  "jobId": "...",
  "repository": "<server-derived exact output repository>",
  "actions": ["pull", "push"],
  "minTtlSeconds": 840,
  "maxTtlSeconds": 900
}
```

응답은 같은 `repository`, 비어 있지 않은 `username`/`password`, RFC 3339 `expiresAt`을 포함해야 합니다. 요청에는 `minTtlSeconds`와 `maxTtlSeconds`가 함께 전달되며, production 기본 계약은 명령 제한 600초, Job 제한 780초, 자격증명 TTL 840~900초입니다. 따라서 자격증명은 전체 Job 제한보다 최소 60초 더 오래 유효하면서도 15분을 넘지 않습니다. Executor는 repository 일치와 TTL을 재검증하고 job 전용 `DOCKER_CONFIG`를 `0600`으로 만든 뒤 build/scan/sign에만 전달하고 cleanup합니다. Broker bootstrap token은 executor container에만 read-only로 mount되며 BuildKit container에는 전달되지 않습니다.

생성 Dockerfile의 frontend와 Node base image도 production values에서 `repository@sha256:<64 hex>` 형식으로 명시해야 합니다. 누락되거나 mutable tag이면 Helm render와 live generated build가 모두 거부됩니다.

## 관련 문서

- [워크플로 작업](workflows.md)
- [리소스 프로비저닝](provisioning.md)
- [보안](security.md)
- [검증 명령](verification-commands.md)
