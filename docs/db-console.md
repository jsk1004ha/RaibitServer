# DB Web Console

> DB Web Console은 관리형 resource를 안전하게 탐색하고 제한된 query를 실행하는 운영/개발 도구입니다.

## 목적

각 resource engine별 console 지원 범위와 query guard를 설명합니다. Console은 provider-owned secret을 사용하며 request body의 connection URL을 신뢰하지 않습니다.

## 지원 범위

| 엔진 | Console contract |
| --- | --- |
| PostgreSQL | schema/table/query, provider-backed execution 또는 provider-contract plan |
| MySQL/MariaDB | `SELECT 1`, schema/table browser, backup/restore/delete command contract |
| SQLite | `node:sqlite` 기반 local executable console, table browse, guarded query |
| MongoDB | collection/document browse, `find` query contract |
| Redis/Valkey | key/value/TTL browse, guarded delete command contract |
| Object Storage | bucket/object browser, upload/download/delete command contract |
| Qdrant/vector | collection/search-test contract |
| NATS/queue | connection info, subject contract |

## 공통 guard

- destructive SQL은 명시적 confirmation이 필요합니다.
- DB 조회는 `db:data:read` 권한이 필요하며, `MAINTAINER`는 조회만 가능합니다. `VIEWER`는 DB 행 조회 권한이 없습니다.
- query limit, timeout, result-size control을 console layer 또는 provider adapter에서 강제합니다.
- provider connection material은 sealed provider secret에서만 가져옵니다.
- request body의 connection URL/URI/DSN/JDBC 값은 사용하지 않습니다.

## SQLite 추가 guard

SQLite는 실행 전에 다음을 차단합니다.

- `ATTACH`
- `DETACH`
- `VACUUM INTO`
- `load_extension`
- unsafe PRAGMA

SQLite parent directory는 provider-owned `.raibitserver-work/sqlite` local console root 아래에서만 생성합니다.

읽기 전용 SQL은 SQLite의 `query_only=ON` 연결에서 실행합니다. PRAGMA 조회는 명시된 메타데이터 조회 목록으로 제한하며, `table_info(...)`, `index_info(...)` 등 schema 탐색은 허용합니다. `user_version(...)`처럼 괄호로 값을 지정하는 PRAGMA도 쓰기이므로 DB 쓰기 권한과 confirmation이 필요합니다.

PostgreSQL `bigint` 결과는 정밀도 손실을 막기 위해 JSON 문자열로 반환합니다. 중첩 결과에도 같은 변환을 적용한 뒤 반환할 JSON의 UTF-8 크기를 계산해 result-size 제한을 적용합니다.

## Online manager 화면

Dashboard resource console은 다음 API를 사용합니다.

- `GET /resources/:resourceId` — resource 상태와 masked connection info 확인
- `POST /resources/:resourceId/provision` — provider plan 생성 및 provider-owned secret 저장
- `POST /resources/:resourceId/attach` — service secret env 자동 주입
- `GET /resources/:resourceId/console/schema|tables|collections|keys` — browser view
- `POST /resources/:resourceId/console/query|command|browse` — guarded query/command 실행

요청 body의 connection URL/URI/DSN/JDBC 값은 사용하지 않고, provider-owned secret에서 복원한 값만 console adapter에 전달합니다.

## 로컬 검증

`pnpm e2e:dry`가 SQLite query/table browse와 Beta DB/resource provider-contract evidence를 검증합니다. 세부 회귀 테스트는 `tests/db-resource-beta.test.js`, `tests/db-console.test.js`, `tests/resource-providers.test.js`입니다.

## 관련 문서

- [리소스 프로비저닝](provisioning.md)
- [보안](security.md)
- [문제 해결](troubleshooting.md)
