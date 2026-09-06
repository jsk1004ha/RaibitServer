# RAIBITSERVER 사용자 설명서

이 문서는 웹 콘솔을 사용하는 일반 사용자 기준입니다. 플랫폼 서버를 설치하는 방법이 아니라 가입, 프로젝트 생성, 배포, 리소스 연결, 업데이트와 삭제를 설명합니다.

## 1. 시작하기

1. <https://raibit.kr/>에서 `가입 신청`을 누릅니다.
2. 이름, 학번, 이메일, 8자 이상의 비밀번호를 입력합니다.
3. 라이빗 동아리원 여부를 선택합니다.
4. 이메일로 받은 6자리 코드를 입력합니다.
5. 관리자가 신원과 동아리원 여부를 확인해 승인할 때까지 기다립니다.
6. 승인 후 <https://console.raibit.kr/>에 로그인합니다.

가입 정보는 정확하게 입력합니다. 학번과 이름은 관리자가 신청자를 확인하는 데 사용하며 동아리원 선택은 자동 승인 수단이 아닙니다.

### 로그인이 되지 않을 때

| 표시 | 확인할 것 |
| --- | --- |
| 이메일 또는 비밀번호 오류 | 이메일 대소문자, 비밀번호 입력 확인 |
| 이메일 인증 필요 | 6자리 코드 인증 완료 여부 확인 |
| 승인 대기 | 관리자 승인 상태 확인 |
| 세션 만료 | 로그인 화면에서 다시 로그인 |
| 요청 실패 500 | [시스템 상태](https://raibit.kr/status) 확인 후 지원 요청 |

## 2. 콘솔 구조

콘솔은 한 화면에서 한 가지 작업에 집중하도록 분리되어 있습니다.

| 메뉴 | 하는 일 |
| --- | --- |
| 개요 | 프로젝트·서비스·리소스 요약 |
| 프로젝트 | 프로젝트 목록과 현재 상태 |
| 프로젝트 만들기 | 4단계 생성 흐름 |
| GitHub 연결 | App 설치, 저장소 가져오기·연결·동기화 |
| 사용 안내 | 짧은 기능별 안내 |
| 관리자 | 가입 승인, 밴, 쿼터. 관리자만 표시 |

상단 검색을 열면 프로젝트, 배포, 리소스와 주요 메뉴를 빠르게 찾을 수 있습니다. 검색 화면은 `Esc`로 닫습니다.

## 3. 저장소를 먼저 준비하기

가장 안정적인 배포는 저장소에 Dockerfile을 직접 두고 앱 상태를 확인할 endpoint를 제공하는 방식입니다.

최소 준비물:

- `README.md`: 로컬 실행·테스트 방법
- `Dockerfile`: production 실행 이미지
- `.dockerignore`: `.git`, `node_modules`, 실제 `.env` 제외
- `.gitignore`: 실제 `.env`, 빌드 산출물 제외
- lockfile: `package-lock.json`, `pnpm-lock.yaml` 등
- health endpoint: 권장 `/healthz/live`, `/healthz/ready`
- CI: 테스트와 Docker build 확인

앱은 설정된 포트에서 `0.0.0.0`으로 실행해야 합니다. 데이터베이스 비밀번호나 API token을 저장소에 넣지 않습니다. 현재 상태 경로는 Kubernetes probe로 자동 연결되지 않으므로 배포 후 직접 요청해 확인합니다. 자세한 기준은 [배포 조건](deployment-requirements.md)을 사용합니다.

## 4. 프로젝트 만들기

`프로젝트 만들기`는 네 화면으로 진행됩니다. 1~3단계의 `다음`은 화면만 이동하고 4단계의 `프로젝트 만들기`에서 한 번 제출됩니다.

### 1단계: 프로젝트

- 이름: 사람이 알아보기 쉬운 이름
- 슬러그: URL과 내부 식별에 쓰는 짧은 값
- 조직: 로그인 권한으로 자동 확인

슬러그를 비워도 서버가 안전한 값을 만들 수 있습니다. 나중에 URL이 달라질 수 있으므로 운영 시작 후 슬러그를 자주 바꾸지 않습니다.

### 2단계: 저장소

- 공개 GitHub 저장소: 정확한 GitHub HTTPS URL과 branch 입력
- private 저장소: 먼저 GitHub App 연결
- 사전 빌드 이미지: `빌드된 이미지` 선택 후 `registry/repository@sha256:<digest>` 입력
- local source: 개발 환경 외에는 사용하지 않음

현재 live builder는 GitHub 저장소만 checkout합니다. ZIP, GitLab, Bitbucket은 화면이나 schema에 값이 보여도 production live 지원으로 간주하지 않습니다. 일반적인 branch는 `main`이며 저장소 기본 branch가 다르면 실제 값을 입력합니다.

### 3단계: 서비스

- 웹사이트·HTTP API: `web`
- 내부 API: `private`
- 백그라운드 처리: `worker`
- 예약 작업: `cron`
- 일회성 작업: `job`

Dockerfile이 저장소 루트에 있으면 경로는 `Dockerfile`, build context는 `.`입니다. monorepo는 서비스가 있는 폴더를 기준으로 경로를 설정합니다.

### 4단계: 리소스

지금 필요한 DB와 캐시만 고릅니다. 선택하지 않아도 프로젝트 생성 후 추가할 수 있습니다.

마지막 버튼을 누른 뒤 프로젝트 목록으로 돌아가 생성된 프로젝트, 서비스, 리소스를 각각 확인합니다. 일부만 생성됐다는 오류가 보이면 같은 이름으로 반복 생성하기 전에 프로젝트 상세와 API 오류를 확인합니다.

## 5. GitHub 연결

private 저장소, repository import, push/PR 자동 배포를 사용하려면 GitHub App을 연결합니다.

1. `GitHub 연결`에서 App 설치를 시작합니다.
2. 개인 계정 또는 조직을 선택합니다.
3. RAIBITSERVER가 사용할 저장소만 허용합니다.
4. 콘솔에서 검증된 설치와 저장소 목록을 확인합니다.
5. 저장소를 가져오거나 기존 서비스에 연결합니다.
6. branch를 확인하고 metadata를 동기화합니다.

token, private key, installation ID를 브라우저 폼에 직접 넣지 않습니다. webhook은 서버가 HMAC 서명을 검증하며 검증되지 않은 push/PR 요청은 배포를 만들지 않습니다.

## 6. 서비스 설정

프로젝트의 `서비스`에서 대상 서비스의 `설정`을 엽니다.

확인할 항목:

- 서비스 이름과 유형
- source 유형과 저장소 URL
- branch
- root directory
- Dockerfile 경로
- build context
- image 또는 image digest
- port
- install/build/start command

현재 콘솔 서비스 설정에서는 tenant health path와 CPU·메모리 값을 직접 편집하지 않습니다. 설정을 바꿨다고 실행 중인 Pod가 자동으로 모두 교체된다고 가정하지 않습니다. 변경 후 새 운영 배포를 요청하고 새 배포 ID를 확인합니다.

## 7. 환경 변수와 비밀키

1. 프로젝트의 `환경 변수` 화면을 엽니다.
2. 대상 서비스를 선택합니다.
3. 키와 값을 입력합니다.
4. token, password, secret, connection string은 비밀값으로 저장합니다.
5. 변경 후 서비스를 재배포합니다.

여러 값을 넣을 때 `.env 텍스트 가져오기`를 사용할 수 있습니다.

```dotenv
NODE_ENV=production
PORT=8080
PUBLIC_API_URL=https://example.com
API_TOKEN=replace-with-real-value
```

비밀값은 저장 후 마스킹됩니다. 기존 원문을 다시 볼 수 없으므로 교체할 때는 새 값을 입력합니다.

### 자주 하는 실수

- 프로젝트가 아닌 다른 서비스에 환경 변수를 저장함
- 키 이름 오타
- 줄 끝 공백이나 따옴표를 값에 포함함
- 변경 후 재배포하지 않음
- `DATABASE_URL`을 직접 복사해 일반값으로 저장함

관리형 리소스 연결 정보는 직접 입력하지 않고 attachment를 사용합니다.

## 8. 관리형 리소스 만들기

### 생성

1. 프로젝트의 `리소스`를 엽니다.
2. `리소스 추가`를 누릅니다.
3. 엔진, 이름, plan, storage를 선택합니다.
4. 생성 후 상태가 `READY`가 될 때까지 기다립니다.

`READY` 전에는 서비스에 연결하거나 실제 쿼리를 실행하지 않습니다. 준비가 오래 걸리면 provision event와 시스템 상태를 확인합니다.

### 서비스 연결

1. 준비된 리소스의 `연결` 화면을 엽니다.
2. 대상 서비스를 선택합니다.
3. 연결 요청 후 주입된 환경 변수 키와 Secret reference를 확인합니다.
4. 서비스를 재배포합니다.
5. readiness와 실제 읽기·쓰기를 테스트합니다.

PostgreSQL 앱은 보통 `DATABASE_URL`을 읽으면 됩니다. 접속 URL 전체를 화면, 로그, 지원 요청에 복사하지 않습니다.

### DB Console

- schema, table, collection, key 조회는 역할에 따라 허용됩니다.
- viewer는 read-only입니다.
- 쓰기·파괴적 쿼리는 추가 권한과 확인이 필요합니다.
- connection URL을 요청 body에 넣어 우회할 수 없습니다.
- 운영 데이터 변경 전에는 WHERE 조건, row 수, 백업을 확인합니다.

## 9. 첫 운영 배포

1. 서비스 목록에서 `운영 배포`를 누릅니다.
2. 배포 목록에 새 배포 ID가 생겼는지 확인합니다.
3. 배포 상세에서 상태, commit SHA, image digest, build log, event를 봅니다.
4. `READY`가 되면 공개 URL을 엽니다.
5. 공개 HTTP, 앱이 제공하는 health endpoint, 핵심 기능을 각각 확인합니다.

### 상태 순서

```text
queued → BUILDING → IMAGE_READY → DEPLOYING → READY
```

실패하면 `BUILD_FAILED` 또는 `FAILED`가 됩니다. 요청이 202로 접수됐다는 사실은 성공이 아닙니다.

### 성공 판정

다음이 모두 맞아야 완료입니다.

- 의도한 commit SHA가 배포됨
- 이미지 digest가 존재함
- 상태가 `READY`
- public URL이 2xx 응답
- 필요한 정적 파일과 이미지가 정상 표시
- 브라우저 콘솔에 치명적 오류가 없음
- DB 사용 앱은 실제 INSERT 후 SELECT 가능
- 재배포 후 기존 DB 데이터 유지
- 런타임 로그가 콘솔에 수집됨

`READY`는 현재 Kubernetes rollout 상태입니다. 공개 URL이나 health endpoint가 실제로 2xx인지 보장하지 않으므로 위 검사를 생략하지 않습니다.

### CLI에서 배포와 복구 운영

CLI 수명주기 명령에는 조직과 프로젝트 범위를 항상 지정하고, 서비스 작업에는 서비스 ID를 함께 지정합니다. 자동화에서는 `--json`을 사용합니다.

```sh
raibitserver deploy retry --organization-id org_id --project-id prj_id --service-id svc_id --deployment-id dep_id --idempotency-key retry-1 --json
raibitserver services redeploy --organization-id org_id --project-id prj_id --service-id svc_id --idempotency-key redeploy-1 --json
raibitserver deployments logs --organization-id org_id --project-id prj_id --service-id svc_id --deployment-id dep_id --follow --cursor CURSOR
raibitserver deployments events --organization-id org_id --project-id prj_id --service-id svc_id --deployment-id dep_id --follow --cursor CURSOR
raibitserver services logs --organization-id org_id --project-id prj_id --service-id svc_id --follow --cursor CURSOR
raibitserver resources attach --organization-id org_id --project-id prj_id --resource-id res_id --service-id svc_id
raibitserver resources backup create --organization-id org_id --project-id prj_id --resource-id res_id --idempotency-key backup-1
raibitserver resources backup list --organization-id org_id --project-id prj_id --resource-id res_id --cursor CURSOR
raibitserver resources backup delete --organization-id org_id --project-id prj_id --resource-id res_id --backup-id backup_id --confirm
raibitserver resources restore create --organization-id org_id --project-id prj_id --resource-id res_id --backup-id backup_id --name restored-db --idempotency-key restore-1
raibitserver resources restore get --organization-id org_id --project-id prj_id --resource-id res_id --backup-id backup_id --restore-id restore_id
```

`--follow`는 재개 커서를 `Last-Event-ID`로 보내며 Ctrl-C 시 스트림을 정리합니다. 백업 삭제에는 `--confirm`이 필수입니다. 출력은 connection secret과 backup artifact key를 포함하지 않습니다. 종료 코드는 성공 0, 일반 실패 1, 사용 오류 2, 인증·권한 오류 3, 충돌 4, unavailable·`NOT_RUN` 5입니다.

## 10. PR 미리보기 배포

현재 별도 hostname과 workload로 격리되는 미리보기 계약은 GitHub PR 번호가 있는 배포에만 적용됩니다.

- GitHub App과 PR 자동화를 연결합니다.
- PR event로 생성된 배포에 PR 번호가 기록됐는지 확인합니다.
- `preview--pr-<번호>--...` 주소가 생성됐는지 확인합니다.
- 기능, 모바일 화면, 콘솔 오류를 확인합니다.
- PR이 닫힌 뒤 cleanup 상태를 확인합니다.

서비스 화면의 수동 `미리보기` 요청처럼 PR 번호가 없는 요청은 현재 운영과 분리된 identity를 보장하지 않습니다. 격리 검증 용도로 사용하지 않습니다. PR 미리보기에도 secret, quota, 보안 정책이 동일하게 적용됩니다.

## 11. 업데이트

1. 코드 수정과 테스트를 완료합니다.
2. GitHub CI가 성공한 commit을 push합니다.
3. 서비스 설정이 같은 branch를 보고 있는지 확인합니다.
4. 운영 배포를 새로 만듭니다.
5. 새 배포 commit SHA와 GitHub commit을 비교합니다.
6. 기능과 데이터 영속성을 다시 테스트합니다.

자동 업데이트가 설정된 플랫폼이라도 tenant 애플리케이션의 새 commit이 언제나 자동 배포된다고 가정하지 않습니다. 서비스의 webhook·자동 배포 설정과 실제 deployment 생성 여부를 확인합니다.

## 12. 취소와 롤백

### 취소

`queued`, `BUILDING`, `IMAGE_READY` 상태에서만 취소할 수 있습니다. 이미 `DEPLOYING`이거나 종료된 배포는 취소 대신 결과를 확인합니다.

### 롤백

- 이전에 `READY`였고 image가 남아 있는 배포가 필요합니다.
- 롤백 화면에서 명시적으로 확인해야 합니다.
- DB schema까지 자동으로 과거 상태로 되돌리지 않습니다.
- 코드 롤백과 DB migration 호환성을 별도로 확인합니다.

## 13. 프로젝트·서비스·리소스 삭제

삭제 전 확인:

- public URL 중단 영향
- 다른 서비스의 내부 호출
- 리소스 attachment
- DB·스토리지 백업
- 마지막 정상 image와 commit
- 복구 담당자와 보존 기간

프로젝트 삭제 요청 후 화면에 `삭제 요청됨` 또는 `DELETING`이 보일 수 있습니다. 워커가 실제 Kubernetes 객체와 provider 리소스를 정리할 때까지 기다립니다.

`READY` 관리형 리소스의 엔진이나 credential을 계획 화면에서 강제로 바꾸지 않습니다. 필요한 경우 백업 → 새 리소스 생성 → 데이터 이전 → 서비스 연결 변경 → 검증 → 이전 리소스 삭제 순서를 사용합니다.

## 14. 오류별 확인 순서

| 증상 | 먼저 확인 |
| --- | --- |
| 401·로그인 이동 | 세션 만료, 올바른 console host |
| 403 | 승인, 조직 권한, 쿼터, 밴 상태 |
| 409 | 이미 존재하는 이름, 잘못된 상태 전이, READY 리소스 변경 |
| `BUILD_FAILED` | 저장소 접근, commit, Dockerfile, dependency, scan |
| `FAILED` | health, port, non-root, resource limit, rollout event |
| 이미지 400 | public asset 경로, Next image 설정, 원본 파일 존재 여부 |
| DB 연결 실패 | 리소스 READY, attachment, Secret key, migration |
| 데이터 사라짐 | 로컬 filesystem 사용 여부, 올바른 DB 연결 여부 |
| 500 | 배포 event와 API 로그, [시스템 상태](https://raibit.kr/status) |

오류 로그는 마지막 줄만 보지 말고 처음 발생한 `error` 앞뒤를 확인합니다. secret-looking 값은 공유 전에 마스킹합니다.

## 15. 도움받기

1. <https://raibit.kr/status>에서 플랫폼 상태를 확인합니다.
2. [문제 해결 문서](../troubleshooting.md)를 검색합니다.
3. `ishsraibit@gmail.com`으로 문의합니다.
4. 재현 가능한 버그는 [GitHub Issues](https://github.com/jsk1004ha/RaibitServer/issues)에 남깁니다.

문의에는 프로젝트·서비스 이름, 배포 ID, 실패 시각, commit SHA, secret을 제거한 로그를 포함합니다.
