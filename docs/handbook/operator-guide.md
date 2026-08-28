# RAIBITSERVER 운영자 설명서

이 문서는 가입 승인, 쿼터, 배포 상태, 리소스, 장애와 production 업데이트를 관리하는 운영자용입니다. 전체 설치 값과 Helm 계약은 [Production 배포 문서](../../deploy/production/README.md)가 기준입니다.

## 1. 운영자 역할 구분

| 역할 | 책임 |
| --- | --- |
| 계정 관리자 | 가입 신원 확인, 승인·거절, 밴·해제, 쿼터 |
| 플랫폼 운영자 | API·Dashboard·worker·DB·registry·Ingress 상태 |
| 리소스 운영자 | 관리형 DB·캐시의 생성, 백업, 복구, 삭제 |
| 보안 담당자 | Secret, RBAC, NetworkPolicy, image scan·서명, 감사 로그 |
| 릴리스 담당자 | CI 승인 SHA, image digest, Helm rollout·rollback |

소규모 운영에서는 한 사람이 여러 역할을 맡을 수 있지만, destructive 작업과 secret 접근은 가능한 한 분리합니다.

## 2. 매일 확인할 상태

### 공개 상태

- <https://raibit.kr/status>
- `GET https://raibit.kr/api/status`
- public landing, console login, 대표 tenant app

### Kubernetes 상태

```sh
kubectl -n raibitserver-system get pods,deployments,jobs
kubectl -n raibitserver-system get events --sort-by=.lastTimestamp
kubectl get namespaces
```

tenant 장애는 해당 namespace에서만 확인합니다.

```sh
kubectl -n <tenant-namespace> get pods,deployments,services,ingresses
kubectl -n <tenant-namespace> get events --sort-by=.lastTimestamp
```

출력에 Secret data, 환경 변수 값, 전체 connection URL을 포함하지 않습니다.

### 정상 판정

- Dashboard와 API readiness 2xx
- control-plane DB query 정상
- builder dispatcher와 executor job 정상
- orchestrator·provisioner·log/metrics ingester Running
- 최근 deployment가 정상적으로 terminal state에 도달
- registry pull/push와 image signature 검증 정상
- tenant 대표 app readiness와 DB smoke test 정상

## 3. 가입 승인과 계정 관리

관리자 화면에서 신청자의 이름, 학번, 이메일, 동아리원 신청 여부를 확인합니다.

### 승인

- 실제 동아리원 확인 후 `CLUB_MEMBER`
- 외부·일반 사용자는 `NON_CLUB`
- 신청 정보가 불충분하면 즉시 임의 승인하지 않고 확인
- 승인과 쿼터 변경 사유를 감사 가능한 형태로 남김

### 밴

- 구체적인 사유와 필요하면 미래 만료 시각을 입력합니다.
- 밴 즉시 session version이 바뀌어 기존 세션이 무효화됩니다.
- 운영자는 자기 자신을 밴할 수 없습니다.
- 최소 두 명의 복구 가능한 관리자를 유지합니다.

### 기본 쿼터

일반 사용자의 기본값은 [배포 조건의 쿼터 표](deployment-requirements.md#일반-사용자-기본-쿼터)를 사용합니다. 증액 전 현재 사용량, 프로젝트 목적, 예상 CPU·메모리·스토리지와 종료 시점을 확인합니다.

CLI 예시:

```sh
raibitserver admin approve --user-id <USER_ID> --account-type NON_CLUB
raibitserver admin quota --user-id <USER_ID> --maxProjects 3
```

CLI token과 사용자 ID를 shell history나 공유 로그에 남기지 않도록 운영 환경을 구성합니다.

## 4. 배포 파이프라인 관찰

```text
API desired state
  → WorkflowJob
  → builder clone/commit pin
  → image build
  → vulnerability scan
  → registry push/sign
  → orchestrator reconcile
  → Ingress/domain
  → READY rollout record
```

API request path에서 builder나 Kubernetes rollout을 직접 수행하지 않습니다. 대기 상태가 길면 API를 반복 호출해 중복 배포를 만들기 전에 workflow job과 worker log를 확인합니다. Tenant deployment의 `READY`는 앱 HTTP health를 보장하지 않으므로 public smoke test를 별도로 수행합니다.

### 상태별 담당 영역

| 상태 | 주 담당 | 확인 대상 |
| --- | --- | --- |
| `queued` | API·dispatcher | workflow job, claim 가능 여부 |
| `BUILDING` | builder | clone, authoritative commit, Dockerfile, BuildKit |
| `IMAGE_READY` | builder→orchestrator | image digest, scan, signature, registry |
| `DEPLOYING` | orchestrator | Deployment, Pod, Service, Ingress, rollout 상태 |
| `READY` | tenant·edge | rollout record와 별도로 public HTTP, 앱 상태 경로, 기능, DB, logs |
| `BUILD_FAILED` | builder·tenant | 최초 build error |
| `FAILED` | orchestrator·tenant | rollout event와 error code |

## 5. 안전한 진단 순서

1. 사용자에게 보인 오류 시각, 배포 ID, commit SHA를 확인합니다.
2. 공개 status와 control-plane health를 확인합니다.
3. deployment record, build log, deployment event를 확인합니다.
4. 상태에 맞는 worker 하나만 좁혀서 로그를 확인합니다.
5. tenant namespace의 Pod, event, image digest를 비교합니다.
6. public URL의 readiness와 핵심 기능을 재현합니다.
7. DB 사용 앱은 값이 아닌 count·row ID 같은 안전한 증거로 영속성을 확인합니다.
8. 원인을 수정한 뒤 새 배포로 검증합니다.

### 로그 조회 예시

```sh
kubectl -n raibitserver-system logs deployment/raibitserver-api --since=15m
kubectl -n raibitserver-system logs deployment/raibitserver-orchestrator --since=15m
kubectl -n <tenant-namespace> logs deployment/<service> --since=15m
```

builder executor가 CronJob 또는 Job이면 label selector로 대상 Pod를 좁힙니다. 전체 namespace의 모든 과거 로그를 무제한 출력하지 않습니다.

## 6. 오류 분류

| 오류 | 흔한 원인 | 우선 조치 |
| --- | --- | --- |
| `authentication_required` | 세션 없음·만료 | console host에서 다시 로그인 |
| 403 | 승인·RBAC·쿼터·밴 | user와 membership, quota audit 확인 |
| 409 | 이름 충돌·상태 충돌 | 기존 객체와 현재 상태 확인 |
| authoritative commit 오류 | branch와 commit 불일치 | remote commit 존재·CI 확인 |
| clone 실패 | URL·권한·GitHub App | repository visibility와 설치 확인 |
| `credential_broker_unavailable` | builder GitHub App Secret 미설정 | dispatcher env·Secret mount와 `builder.githubAppCredentials` 확인 |
| Dockerfile 오류 | 경로·context·명령 | source root와 build log 확인 |
| registry credential broker 실패 | DNS·TLS·NetworkPolicy·overlay | 전용 broker Service와 split DNS 확인 |
| image scan 실패 | HIGH/CRITICAL 취약점 | base image·dependency 업데이트 |
| rollout timeout | port·health·image pull·quota | Pod event와 readiness 확인 |
| Prisma migration 실패 | DB listener·network·schema | migration Job log와 DB 연결 확인 |
| DB attachment 실패 | resource not READY·Secret metadata | resource state와 allowed key 확인 |
| log 미수집 | ingester·cursor·RBAC | ingester health와 runtime log row 확인 |

상세 절차는 [문제 해결](../troubleshooting.md)을 사용합니다.

## 7. 관리형 리소스 운영

### 생성·READY

- provider image는 허용된 digest와 non-root UID/GID 계약을 충족해야 합니다.
- credential Secret은 create-once·immutable 원칙을 사용합니다.
- provisioner는 실제 인증 probe가 성공한 뒤에만 `READY`로 전환합니다.
- Secret 유실·UID 불일치는 fail-closed로 처리합니다.

### 연결

- Secret 전체를 `envFrom`으로 넣지 않습니다.
- 카탈로그가 허용한 key만 개별 `secretKeyRef`로 주입합니다.
- 사용자 요청 body의 URL/DSN/JDBC 값은 provider 연결로 신뢰하지 않습니다.

### 변경

`READY` 리소스는 in-place 변경이나 credential rotation 계획을 거부할 수 있습니다. 새 리소스 생성, 데이터 이전, attachment 전환, 검증 후 기존 리소스 삭제를 사용합니다.

### 백업과 복구

- PostgreSQL/MySQL/MongoDB는 tenant 단위 dump·restore 절차를 준비합니다.
- Redis/Valkey는 `FLUSHDB`·`FLUSHALL`을 사용하지 않습니다.
- restore rehearsal 없이 백업 성공만으로 복구 가능하다고 판단하지 않습니다.
- project/resource 삭제 전 마지막 백업 ID와 복구 담당자를 기록합니다.

## 8. Production 릴리스

production 릴리스는 tag가 아니라 CI가 성공한 정확한 commit과 image digest를 기준으로 합니다.

필수 조건:

- 강한 JWT·암호화·admin bootstrap Secret
- Prisma/PostgreSQL persistence와 migration
- platform image 7종의 digest pin
- 활성 live provider image의 digest pin
- registry credential broker와 Cosign signing key
- restricted Pod Security, NetworkPolicy, RBAC
- wildcard TLS와 Ingress
- GitHub webhook HMAC
- backup/restore와 rollback 준비

검증:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm prisma:validate
pnpm prisma:generate
node scripts/check-structure.js
sh scripts/verify-helm.sh
```

Go가 있으면 각 `services/*` 모듈에서 다음을 실행합니다.

```sh
go test ./...
go build ./...
```

Helm과 live gate는 [Production 배포](../../deploy/production/README.md)와 [Live E2E](../live-e2e.md)를 따릅니다.

## 9. 자동 업데이트

production auto updater는 새 `main` commit이 있다는 이유만으로 바로 배포하지 않습니다. 정확한 SHA의 push CI가 성공한 경우에만 별도 checkout에서 build·scan·sign·push·Helm upgrade를 수행합니다.

```sh
systemctl status raibitserver-auto-update.timer
systemctl status raibitserver-auto-update.service
journalctl -u raibitserver-auto-update.service -f
```

실패 시:

1. timer를 멈추고 원인을 확인합니다.
2. 실패한 release가 rollback됐는지 확인합니다.
3. migration Job, image digest, values overlay, registry·Cosign 상태를 확인합니다.
4. 문제를 수정한 commit의 CI 성공 후 다시 실행합니다.
5. 이전 실패 SHA를 수동으로 성공 처리하지 않습니다.

설치·재설치 절차는 [main 자동 production 업데이트](../../deploy/production/README.md#main-자동-production-업데이트)를 사용합니다.

## 10. 삭제 운영

### 프로젝트·서비스

- 삭제 요청이 들어오면 새 deployment claim을 막습니다.
- 실행 중인 workload, Ingress, Service, Secret reference를 정리합니다.
- 최종 상태와 실패 event를 control-plane에 남깁니다.

### 리소스

- Service 접근 차단
- workload foreground 종료
- NetworkPolicy 제거
- UID로 fence된 Secret과 PVC 정리
- provider primitive 삭제와 감사 기록

recursive shell 삭제로 workspace나 서버 디렉터리를 정리하지 않습니다. Kubernetes owner reference, foreground cascade, UID precondition과 명시적 경로를 사용합니다.

## 11. 사고 대응 체크리스트

```text
[ ] 영향 범위: landing / console / 특정 tenant / DB / registry
[ ] 최초 발생 시각과 마지막 정상 시각
[ ] 관련 배포 ID, commit SHA, image digest
[ ] 사용자 영향과 데이터 손상 가능성
[ ] 현재 rollback 가능 배포
[ ] Secret 노출 여부
[ ] backup/restore 필요 여부
[ ] 임시 완화 조치와 종료 조건
[ ] 근본 원인 수정과 회귀 테스트
[ ] 사용자 공지와 사후 기록
```

Secret 노출 가능성이 있으면 로그를 더 넓게 공유하기 전에 token·credential을 회전하고 노출 경로를 차단합니다.

## 12. 운영 완료 증거

변경 또는 복구를 완료했다고 보고할 때 다음을 남깁니다.

- 배포된 commit SHA와 image digest
- Helm release revision 또는 deployment ID
- API/Dashboard/worker rollout 상태
- public status와 대표 tenant smoke test
- DB readiness와 필요한 쓰기·읽기 결과
- Pod restart 수
- runtime log·metric 수집 여부
- 실행한 테스트와 결과
- 남은 위험과 후속 작업
