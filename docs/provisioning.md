# 리소스 프로비저닝

> RAIBITSERVER의 DB/storage/cache/vector/queue는 raw compose container가 아니라 프로젝트에 연결되는 관리형 catalog resource입니다.

## 목적

이 문서는 resource catalog, provider-neutral desired-state plan, dry-run/live provider mode, secret 처리 원칙을 설명합니다.

## 계획 미리보기와 실제 실행 요청

기존 리소스의 `POST /resources/:resourceId/provision`은 `{ "intent": "preview-plan" }` 또는 `{ "intent": "live-provision" }`만 받습니다. `dryRun`, `execute`, 빈 본문은 허용하지 않습니다. 미리보기는 `PLAN_ONLY`와 마스킹된 계획을 반환하며 리소스·타임스탬프·감사 로그·작업 대기열을 변경하지 않습니다. 생성 및 실제 실행 요청은 서버가 `desiredState.resourceExecution`에 live intent, 환경과 이미지 digest를 기록하고 `PROVISIONING`으로 유지합니다. API는 외부 공급자를 실행하거나 READY를 만들지 않습니다.

API와 Go worker의 신뢰된 운영 설정은 `RAIBITSERVER_RESOURCE_ENVIRONMENT=local|release`입니다. 미설정·잘못된 값은 실제 쓰기를 거부합니다. production Helm은 항상 `release`를 설정하므로 현재 매트릭스에서는 생성·실행이 차단됩니다. 호출자의 environment/region/provider 값으로 승격할 수 없습니다. 로컬 6개 엔진은 각각 `RAIBITSERVER_PROVIDER_<ENGINE>_IMAGE=repository@sha256:<64 lowercase hex>`가 있어야 저장·claim할 수 있습니다. SQLite는 로컬 파일 전용이며 Go claim 대상이 아닙니다.

Go는 실제 SQL claim의 UPDATE 전에 환경·지원 엔진·일치하는 digest·live intent를 필터링합니다. legacy pending 행에 intent가 없으면 자동 실행하지 않습니다. 운영자가 기존 행을 재검토하고 지원되는 로컬 환경에서 명시적으로 실행 요청해야 합니다. 이 안전성 검증은 실제 엔진 lifecycle의 release 증거를 대신하지 않습니다.

CLI: `raibitserver resources provision --resource-id ID --intent preview-plan` 또는 `--intent live-provision`. 로컬 `node src/cli.js provision-plan project.json`은 컴파일 전용이고, TypeScript의 `provision --execute`는 Go 전용 실행 경계에서 거부됩니다.

## 지원 catalog

지원 여부의 유일한 원본은 `test-fixtures/contracts/resource-capabilities-v1.json`입니다. `local`은 구현된 로컬 기능, `release`는 운영 릴리스 기능이며 현재 release 기능은 모두 false입니다. `planOnly`의 명령 계획과 `liveEvidence: not-recorded`는 실행 성공이 아닙니다. MySQL/MariaDB/MongoDB/Redis/Valkey의 query/schema는 아직 계획 전용입니다. 관리형 backup/list/delete와 새 격리 리소스로의 restore API·desired-state lifecycle은 구현되어 있지만, capability catalog의 release backup/restore가 false인 동안 실제 provider 백업 실행이 제공된다고 해석하지 않습니다.

백업 생성은 idempotency key와 format version을 받고 비동기 상태를 기록합니다. 삭제는 명시적 확인이 필요하며, restore는 원본 리소스를 덮어쓰지 않고 이름이 다른 새 target resource를 만듭니다. 공개 응답은 connection secret과 backup artifact key를 반환하지 않습니다. 이 API 계약과 로컬 상태 테스트는 실제 dump, object storage, provider restore 또는 복구 리허설의 live PASS가 아닙니다.

변경 후 `node scripts/generate-resource-capabilities.mjs`로 TypeScript/CLI/Go/Helm 패키지 내부의 복제 파일을 생성하고 `node --test tests/resource-capability-parity.test.js`로 byte/hash drift를 검사합니다. production Helm 패키징은 dedicated-local 지원 6개 엔진의 digest-pinned 이미지를 요구하지만 운영 인증을 부여하지 않습니다.

- PostgreSQL
- MySQL
- MariaDB
- MongoDB
- Redis
- Valkey
- SQLite
- Object Storage — 준비 중 (`ENGINE_NOT_IMPLEMENTED`), 생성 불가
- Qdrant/vector — 준비 중 (`ENGINE_NOT_IMPLEMENTED`), 생성 불가
- NATS/queue — 준비 중 (`ENGINE_NOT_IMPLEMENTED`), 생성 불가

## Desired-state plan

`packages/core/src/provisioner.ts`는 지원되는 로컬 resource를 provider-neutral plan으로 compile하며 미지원 엔진은 거부합니다.

- `ManagedDatabase`, `ManagedCache` 형태의 CR-style manifest (storage/vector/queue 형태는 미활성 계약)
- provider 이름과 plan (`shared-small` 기본값). 이는 provider-neutral 목표 계약이며 현재 Go live adapter의 실행 방식과 동일하다는 뜻은 아닙니다.
- storage, version, credential secret 이름 (자동 backup policy 없음)
- connection environment variable용 Secret manifest

`provisionProjectResources`는 이 manifest의 dry-run 계획만 반환합니다. 실제 공급자 실행은 Go provisioner가 담당하며 TypeScript의 execute 요청은 거부됩니다.

## 목표 Shared provider model

RAIBITSERVER DBaaS의 목표 운영 단위는 **공유 provider 인스턴스 + 프로젝트별 tenant primitive**입니다. 아래 표는 목표 설계이며 현재 authoritative Go live adapter에는 아직 구현되지 않았습니다. 현재 live adapter는 리소스별 PVC/Service/StatefulSet을 tenant namespace에 만드는 `raibitserver-local-*` dedicated-local 모델입니다.

| 엔진 | 공유 provider | 프로젝트별 생성 단위 | 삭제/복구 단위 |
| --- | --- | --- | --- |
| PostgreSQL | PostgreSQL 서버 1개 + PgBouncer | database + cluster-level role/user | `pg_dump -Fc`/`pg_restore` per database |
| MySQL/MariaDB | MySQL/MariaDB 서버 1개 | database + user/grant | database dump/restore |
| MongoDB | MongoDB 서버 1개 | database + user | `mongodump --db` / `mongorestore --db` |
| Redis/Valkey | Redis/Valkey 서버 1개 | ACL user + key prefix | `SCAN MATCH <prefix>*` + `UNLINK`; prefix restore는 별도 검증 필요 |
| Object Storage | S3/MinIO provider | bucket + scoped credentials | bucket mirror/restore |

PostgreSQL 서비스 연결은 기본적으로 `서비스/API -> PgBouncer -> PostgreSQL` 경로를 사용합니다. Provider admin URL은 database/user/grant 생성에만 사용하고, workload에는 provider-owned secret으로 PgBouncer 경유 `DATABASE_URL`을 주입합니다.

### 메모리/연결 최적화

- PostgreSQL은 `max_connections`를 낮게 유지하고 PgBouncer transaction pooling으로 앱 연결 폭증을 흡수합니다.
- OOM 압력이 생기면 provider 운영자는 `shared_buffers`, `work_mem`, `hash_mem_multiplier`, 과도한 connection 수를 함께 낮춥니다.
- shared-small tenant에는 role/database 단위 `statement_timeout`, `idle_in_transaction_session_timeout`, connection limit, storage/quota/metering을 적용합니다.
- Redis/Valkey는 prefix만 믿지 않고 ACL key pattern(`~<prefix>*`)과 위험 명령 차단(`-FLUSHDB`, `-FLUSHALL`)을 같이 사용합니다.

### 단점과 위험 완화

- **Noisy neighbor**: 무거운 쿼리, 인덱스 생성, 대량 insert, Redis 대량 key가 같은 provider의 다른 tenant에 영향을 줄 수 있습니다. shared-small에는 quota/timeout/slow-query 관측을 켜고, 반복 위반 또는 상위 사용량 tenant는 dedicated plan으로 승격합니다.
- **격리 한계**: database/user 분리는 실용적이지만 PostgreSQL role, WAL, autovacuum, shared buffers, 디스크 I/O는 공유됩니다. 따라서 username/database/bucket/prefix는 provider 전체에서 충돌하지 않게 생성하고 tenant가 admin endpoint를 직접 받지 않게 합니다.
- **백업/복구 복잡도**: shared provider에서는 프로젝트 단위 복구만 수행하도록 per-database/per-bucket dump 흐름을 표준화합니다. Redis prefix 복구는 가장 취약하므로 production 전 restore rehearsal이 필요합니다.
- **Redis prefix-only 위험**: Redis logical DB 분리는 tenant 격리 수단으로 쓰지 않습니다. Redis Cluster는 database 0만 사용하는 제약도 있으므로 ACL key pattern과 command 제한을 필수로 둡니다.
- **파괴적 삭제 위험**: shared Redis/Valkey provider에서 `FLUSHDB`/`FLUSHALL`은 금지입니다. 삭제 command contract는 `SCAN MATCH <prefix>*`로 key를 찾고 `UNLINK`로 비동기 삭제합니다.

## Beta vs 정식 버전 위험 완화 범위

아래 항목은 shared provider를 활성화하기 전 완료해야 하는 목표 계약입니다. 현재 dedicated-local adapter가 이 표의 PgBouncer, tenant role/ACL, prefix 삭제, primitive 단위 복구를 제공한다고 해석하면 안 됩니다.

| 위험 | 베타 필수 구현 | 정식 버전/GA까지 유예 |
| --- | --- | --- |
| PostgreSQL connection/OOM | PgBouncer 경유 `DATABASE_URL`, role별 `CONNECTION LIMIT`, `statement_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout` provider plan contract | 실제 provider별 pool size 자동 튜닝, tenant별 slow-query 기반 throttling |
| PostgreSQL noisy neighbor | per-role timeout/connection limit와 quota/metering contract | heavy query 자동 탐지, project별 dedicated DB 자동 승격, index/build 작업 제한 UI |
| PostgreSQL role/database 격리 | provider 전체에서 충돌하기 어려운 generated database/user naming, provider-owned secret만 주입 | 조직별 별도 cluster/namespace 또는 paid dedicated plan |
| MySQL/MariaDB/MongoDB 격리 | database + user/grant 또는 database + user 생성 contract, database 단위 dump/restore command | provider별 live quota enforcement와 point-in-time per-tenant restore 자동화 |
| Redis/Valkey 전체 삭제 | ACL user + `REDIS_KEY_PREFIX`, `-@admin`, `-@dangerous`, `-FLUSHALL`, `-FLUSHDB`, 삭제는 `SCAN MATCH <prefix>*` + `UNLINK` | per-prefix memory/key cardinality meter, restore rehearsal 자동화, Redis Cluster topology별 prefix scan adapter |
| 백업/복구 | PostgreSQL/MySQL/MongoDB는 tenant primitive 단위 command contract 문서화 | Redis prefix-level restore tooling, self-serve point-in-time restore UI, 정기 복구 리허설 자동화 |

따라서 현재 Closed Beta에서는 shared-small live 실행을 약속하지 않습니다. PostgreSQL/MySQL/MariaDB/MongoDB/Redis/Valkey의 dedicated-local 실행만 별도 certified image로 제한하고, shared provider는 위 격리·쿼터·복구 조건이 구현된 뒤 활성화해야 합니다.

## 로컬 deterministic mode

Dry E2E는 provider manifest와 SQLite console 실행만 사용합니다. cloud credential이나 로컬 PostgreSQL/Redis 서버가 필요하지 않습니다.

SQLite resource는 PVC-style path contract를 사용하고 다음 env를 주입합니다.

```txt
SQLITE_PATH
DATABASE_URL=sqlite:<path>
```

## Live provider mode

Authoritative Go provisioner의 live mode는 다음 원칙을 적용합니다.

- PostgreSQL/MySQL/MariaDB/MongoDB/Redis/Valkey만 현재 live 대상입니다. 각 리소스는 tenant namespace에 전용 PVC/Service/StatefulSet으로 생성됩니다.
- provider image는 sha256 digest로 고정하고 restricted Pod Security의 엔진별 non-root UID/GID 계약(PostgreSQL 70, MySQL/MariaDB/MongoDB/Redis/Valkey 999), writable data path, `/bin/sh`, 엔진별 client CLI를 충족해야 합니다.
- PostgreSQL은 PVC 루트의 `lost+found`와 충돌하지 않도록 `PGDATA=/var/lib/postgresql/data/pgdata`를 고정합니다. MySQL/MariaDB의 application username `root`는 공식 이미지 초기화 계약과 충돌하므로 compile 단계에서 거부합니다.
- 현재 지원하는 plan은 기본 `shared-small` 호환 입력과 명시적 `dedicated-local`뿐이며 둘 다 dedicated-local workload로 실행됩니다. 사용자 지정 version/미구현 plan은 operator-pinned image와 다른 동작을 암묵적으로 선택하지 않도록 fail-closed 합니다.
- 이 adapter는 `local` region만 제공합니다. 외부 region 또는 알려지지 않은 provider 식별자를 현재 클러스터에 조용히 배치하지 않고 compile 단계에서 거부합니다.
- credential Secret은 create-once + immutable입니다. 최초 생성 응답에서 Kubernetes UID만 받아 control-plane 공개 metadata로 저장합니다. 생성 직후 프로세스가 중단된 재시도는 admission이 no-op으로 강제한 server-side dry-run metadata PATCH로 UID와 소유 generation만 확인하고, health·삭제 전에는 UID precondition이 있는 server-side dry-run DELETE로 같은 객체인지 확인합니다. 삭제는 Service 차단 후 StatefulSet을 foreground cascade로 완전히 종료하고 NetworkPolicy를 제거한 다음 UID-fenced Secret과 PVC 순서로 수행합니다.
- provisioner에는 Secret `get` 권한이 없습니다. 복구용 `patch`는 admission에서 dry-run no-op으로만 허용되고 클라이언트도 `PartialObjectMetadata` 외 응답이나 data 필드를 거부합니다. 예상 이름을 다른 객체가 먼저 만든 actual-create 경합, 기존 workload/PVC에 대응하는 Secret 유실, UID가 다른 same-name 재생성은 모두 fail-closed 합니다.
- Secret 전체를 `envFrom`으로 주입하지 않고 컴파일러가 허용한 key만 개별 `secretKeyRef`로 연결합니다. kubelet startup/readiness는 deterministic public connection contract와 실제 credential 인증(`SELECT 1`, Mongo ping, Redis/Valkey `AUTH` 성공 후 `PING`)을 함께 검사합니다. startup probe는 긴 초기화·복구 중 liveness 재시작 루프가 생기지 않도록 최대 20분의 bounded window를 제공합니다.
- READY 리소스는 `provisioner.healthIntervalSeconds` 주기로 다시 claim하여 immutable Secret UID, 인증 readiness, Service를 확인합니다. 일시적인 Kubernetes 오류는 3회 연속 실패 후 FAILED로 전환하고 계속 재검증하여 복구할 수 있으며, Secret 유실·UID 불일치 같은 integrity failure는 즉시 FAILED로 내립니다.
- Kubernetes 명령을 실행하기 직전에 DB claim heartbeat를 갱신하되 원래 CAS claim token은 바꾸지 않습니다. 따라서 긴 rollout/delete 중 stale lease가 다른 worker에 넘어가지 않으며, 지속적인 deletion/health/provisioning backlog도 교대 슬롯으로 서로를 무기한 굶기지 않습니다.
- live mode에서 성공적으로 한 리소스를 처리한 경우 polling sleep 없이 다음 backlog 항목을 처리합니다. idle/error와 상태를 다시 `PROVISIONING`으로 되돌리는 dry-run은 같은 row를 hot-loop하지 않도록 `provisioner.reconcileIntervalSeconds`만큼 대기합니다.
- provisioner의 cluster 권한은 managed namespace와 제한된 RoleBinding bootstrap에만 사용합니다. 실제 provider object 권한은 managed tenant namespace에 생성한 전용 RoleBinding으로 한정하며 Secret read와 `pods/exec`는 부여하지 않습니다.
- Object Storage/Qdrant/NATS는 bucket/collection/stream bootstrap과 authenticated semantic check가 없어 API 입력과 TS/Go 컴파일 단계에서 거부합니다. 이미지 설정이나 과거 템플릿 존재만으로 활성화되지 않습니다.

- PostgreSQL console query는 sealed provider `connectionSecretName`에서 connection material을 가져옵니다.
- tenant request body와 resource-create payload는 connection URL/URI/DSN/JDBC variants를 제공할 수 없습니다.
- read-only PostgreSQL console query와 table browse는 `READ ONLY` transaction, statement timeout, row limit, result-size control 안에서 실행합니다.
- PostgreSQL mutation은 `db:query` permission과 명시적 확인이 모두 필요합니다.
- SQLite query/table browse는 provider-owned `.raibitserver-work/sqlite` root 아래 path에 대해서만 실행합니다.
- SQLite는 `ATTACH`, `DETACH`, `VACUUM INTO`, `load_extension`, unsafe PRAGMA를 실행 전에 차단합니다.
- 다른 catalog resource는 dedicated provider adapter가 설정되기 전까지 connection/browse contract를 노출합니다.

## Secret 처리

- provider secret 값은 Kubernetes immutable Secret에만 저장하고 control-plane에는 Secret 이름, 허용 key, Kubernetes 객체 UID 등 값이 아닌 공개 ref metadata만 저장합니다.
- 재시도와 health check는 Secret 값을 API로 읽지 않습니다. required key 누락·공개 contract 불일치·credential 불일치는 workload의 authenticated readiness 실패로 드러납니다.
- API/CLI/log snapshot은 secret-looking 값을 masking합니다.
- 서비스 env에는 secret 값을 직접 기록하지 않고 secret ref를 사용합니다.

## 관련 문서

- [DB Console](db-console.md)
- [보안](security.md)
- [승인·쿼터](quota.md)
