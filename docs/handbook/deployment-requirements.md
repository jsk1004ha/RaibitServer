# RAIBITSERVER 애플리케이션 배포 조건

이 문서는 “이 저장소를 RAIBITSERVER에 올릴 수 있는가?”를 판단하는 기준입니다. 아래 필수 조건을 하나라도 충족하지 못하면 먼저 애플리케이션이나 서비스 설정을 수정합니다.

## 1. 배포 가능 여부 한눈에 보기

| 영역 | 필수 조건 | 실패하면 |
| --- | --- | --- |
| 계정 | 이메일 인증과 관리자 승인 완료 | 프로젝트 생성·배포 차단 |
| 권한 | 대상 조직의 멤버이며 프로젝트 작업 권한 보유 | 401 또는 403 |
| 쿼터 | 프로젝트·서비스·배포·CPU·메모리·스토리지 한도 이내 | 403 또는 quota 오류 |
| 소스 | 현재 live builder가 허용하는 GitHub 저장소 또는 digest 고정 이미지 | clone/source 단계 실패 |
| revision | 존재하는 branch와 commit, 운영 배포는 authoritative commit 확인 | build 시작 전 실패 |
| 컨테이너 | 앱이 설정된 포트에서 `0.0.0.0`으로 실행 | 공개 HTTP 검증 실패 |
| 보안 | non-root, no privileged, no hostPath/hostNetwork, 제한된 권한 | 배포 요청 또는 admission 차단 |
| 비밀값 | Git이 아닌 환경 변수·Secret reference 사용 | 보안 검사 차단 또는 유출 위험 |
| 상태 확인 | `READY` 후 공개 HTTP와 앱 상태 경로를 별도 검사 | 겉보기 배포 성공을 실제 성공으로 오판 |
| 데이터 | 영구 데이터는 관리형 리소스에 저장 | 재배포 시 데이터 손실 |

## 2. 계정과 권한 조건

배포하려면 다음 상태가 모두 필요합니다.

- 이메일 인증을 완료한 계정
- 관리자가 `CLUB_MEMBER` 또는 승인된 `NON_CLUB`으로 처리한 계정
- 대상 조직의 멤버십
- `project:create`, `service:create`, `deploy:run` 등 작업에 맞는 권한
- 밴되지 않은 사용자와 유효한 로그인 세션

`PENDING` 사용자는 보호된 콘솔 작업과 프로젝트·서비스·리소스 생성, 운영·미리보기 배포를 수행할 수 없습니다. 관리자 화면은 `ADMIN`만 접근할 수 있습니다.

### 일반 사용자 기본 쿼터

아래 값은 승인된 `NON_CLUB` 계정의 현재 기본값입니다. 운영자가 사용자별로 변경할 수 있으며 `CLUB_MEMBER`도 hard safety cap과 보안 정책은 계속 적용됩니다.

| 항목 | 기본값 |
| --- | ---: |
| 프로젝트 | 1개 |
| 서비스 | 2개 |
| 일일 배포 | 3회 |
| 동시 미리보기 배포 | 1개 |
| 전체 CPU request | 500 millicores |
| 전체 메모리 request | 512 MB |
| DB 스토리지 | 512 MB |
| Object Storage | 1,024 MB |
| 월 빌드 시간 | 60분 |
| 월 런타임 | 120시간 |

현재 사용량은 콘솔 또는 `raibitserver usage`로 확인합니다.

## 3. 지원하는 실행 단위

| 서비스 유형 | 용도 | 공개 URL |
| --- | --- | --- |
| `web` | 웹사이트, HTTP API | 있음 |
| `private` | 프로젝트 내부 API | 없음 |
| `worker` | 큐·백그라운드 처리 | 없음 |
| `cron` | 주기적 작업 | 없음 |
| `job` | 일회성 작업·migration | 없음 |

`web`만 public hostname을 가집니다. 다른 서비스는 내부 hostname과 서비스 콘솔만 사용합니다. 한 프로젝트에 여러 서비스를 둘 수 있지만 처음에는 필요한 실행 단위만 만듭니다.

## 4. 지원하는 소스와 빌드 방식

### 소스 유형

| 소스 | 사용 조건 |
| --- | --- |
| GitHub | 정확한 `https://github.com/<owner>/<repo>` URL과 존재하는 branch 필요. 공개 저장소는 URL로 배포 가능 |
| GitHub App | private 저장소, 저장소 목록 가져오기, push/PR 자동화에 권장·필수 |
| 사전 빌드 이미지 | pull 가능한 `registry/repository@sha256:<64자리 digest>` 형식이 필수 |
| local | 개발·검증 전용. production tenant API에서는 기본 차단 |

현재 production live builder의 checkout 경로는 GitHub HTTPS 저장소만 지원합니다. schema나 planning 계층에 ZIP, GitLab, Bitbucket 값이 있더라도 live ingestion이 구현됐다고 간주하지 않습니다. private 저장소 자격 증명을 URL에 넣지 않습니다. GitHub App 연결 정보는 사용자가 임의의 installation ID나 token으로 대체할 수 없으며, 서버가 검증한 설치와 저장소만 연결합니다. private build는 dispatcher의 exact-repository short-lived credential broker가 켜져 있어야 합니다.

### 빌드 우선순위

1. 사용자가 지정했거나 저장소에서 찾은 Dockerfile
2. 사용자가 지정한 custom build
3. 감지된 프레임워크 계획
4. Buildpacks 계열 fallback
5. 사전 빌드 이미지는 별도 build 없이 사용

Dockerfile이 있으면 프레임워크 자동 감지보다 항상 우선합니다. 빌드는 선택한 commit을 기준으로 실행하고 이미지 scan, registry push, 가능한 경우 서명을 거칩니다.

### 경로 조건

- 일반 저장소의 root directory와 build context는 `.`입니다.
- monorepo는 앱이 있는 하위 폴더를 root directory로 지정합니다.
- `dockerfilePath`는 build source 안의 파일이어야 합니다.
- 절대 경로와 `..`로 source boundary를 벗어나는 경로는 사용하지 않습니다.
- 경로는 대소문자를 포함해 저장소의 실제 이름과 일치시킵니다.
- `.dockerignore`에 `.git`, `node_modules`, 테스트 산출물, 실제 `.env`를 넣습니다.

## 5. 컨테이너 실행 계약

### 필수

- Linux 컨테이너 이미지여야 합니다.
- 프로세스가 foreground에서 실행되어야 합니다.
- 서버는 `127.0.0.1`이 아니라 `0.0.0.0`에 bind해야 합니다.
- 서비스 포트와 앱의 listen 포트가 같아야 합니다. 값을 생략하면 core 기본 포트는 `8080`입니다.
- 종료 신호 `SIGTERM`을 처리하고 bounded time 안에 종료해야 합니다.
- 컨테이너는 non-root 사용자로 실행되어야 합니다.
- root filesystem을 읽기 전용으로 사용할 수 있어야 합니다. 임시 파일은 `/tmp`를 사용합니다.
- 애플리케이션 상태를 별도 확인할 수 있도록 빠른 health endpoint를 제공하는 것을 권장합니다.

### 권장 health endpoint

| 경로 | 검사 내용 | 성공 조건 |
| --- | --- | --- |
| `/healthz/live` | 프로세스가 응답 가능한지 | 외부 의존성 없이 빠른 2xx |
| `/healthz/ready` | 트래픽을 받을 준비가 됐는지 | 필수 DB·캐시 연결 포함 2xx |

현재 tenant Deployment에는 이 경로가 Kubernetes liveness/readiness probe로 자동 연결되지 않습니다. 따라서 deployment `READY`는 health endpoint의 2xx를 보장하지 않으며, 공개 URL과 이 경로를 배포 후 직접 검사해야 합니다.

readiness에서 매번 schema migration이나 대용량 쿼리를 수행하지 않습니다. DB 장애가 앱 전체 준비 상태에 영향을 주는 서비스만 DB 연결을 readiness에 포함합니다.

### 최소 Node.js 예시

```js
import http from 'node:http';

const port = Number(process.env.PORT || 8080);
const server = http.createServer((request, response) => {
  if (request.url === '/healthz/live') {
    response.writeHead(200, { 'content-type': 'application/json' });
    return response.end(JSON.stringify({ ok: true }));
  }
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('RAIBITSERVER ready');
});

server.listen(port, '0.0.0.0');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
```

### 최소 Dockerfile 예시

```dockerfile
FROM node:24-bookworm-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node src ./src

ENV NODE_ENV=production
ENV PORT=8080
USER node
EXPOSE 8080

CMD ["node", "src/server.js"]
```

운영에서는 base image도 검토된 digest로 고정하고, multi-stage build로 빌드 도구를 runtime 이미지에서 제거하는 방식을 권장합니다.

실제 PostgreSQL 연결, health endpoint, non-root Dockerfile과 CI 구성이 필요한 경우 [RS-test2](https://github.com/jsk1004ha/RS-test2)를 참고할 수 있습니다. 이 저장소는 동작 검증용 예제이며 각 앱의 framework, migration, 보안 요구사항은 별도로 확인합니다.

## 6. 금지되는 workload 설정

다음 요청은 배포 전 검사 또는 Kubernetes admission에서 차단됩니다.

- `privileged: true`
- root 실행 또는 `runAsUser: 0`
- `hostNetwork`, `hostPID`, `hostIPC`
- `hostPath`
- service account token automount
- `allowPrivilegeEscalation: true`
- Linux capability 추가
- `/tmp` 외 writable mount
- `readOnlyRootFilesystem: false`
- `RuntimeDefault`가 아닌 seccomp profile

CPU·메모리 limit이 없으면 경고 또는 정책 차단 대상이 될 수 있습니다. 앱이 필요한 최소 request와 현실적인 limit을 지정합니다.

## 7. 환경 변수와 비밀값

### 저장 위치

| 값 | 저장 위치 |
| --- | --- |
| 공개 가능한 설정 | 서비스 일반 환경 변수 |
| API token·password·secret | 서비스 암호화 비밀값 |
| DB 접속 정보 | 관리형 리소스 attachment가 만든 Secret reference |
| 플랫폼 JWT·registry·Cosign key | 운영자 Kubernetes Secret 또는 외부 secret manager |

금지 사항:

- `.env`를 commit하지 않습니다.
- token을 Dockerfile `ARG`나 이미지 layer에 넣지 않습니다.
- connection string 전체를 로그에 출력하지 않습니다.
- private repo token을 Git URL에 넣지 않습니다.
- 마스킹된 값을 원문이라고 가정해 다시 저장하지 않습니다.

`.env.example`에는 키 이름과 안전한 예시만 남깁니다.

```dotenv
NODE_ENV=production
PORT=8080
DATABASE_URL=
API_TOKEN=
```

## 8. 데이터베이스와 관리형 리소스

애플리케이션 컨테이너의 로컬 파일은 재배포·재시작 때 보존을 보장하지 않습니다. 영구 데이터는 관리형 리소스에 저장합니다.

### PostgreSQL 연결 순서

1. 프로젝트 리소스에서 PostgreSQL을 생성합니다.
2. 상태가 `READY`가 될 때까지 기다립니다.
3. 대상 서비스에 리소스를 연결합니다.
4. 서비스 환경 변수에 provider-owned Secret reference가 생겼는지 확인합니다.
5. 서비스를 다시 배포합니다.
6. `/healthz/ready`와 실제 INSERT/SELECT를 검증합니다.

PostgreSQL attachment는 다음 키를 제공할 수 있습니다.

```text
DATABASE_URL
POSTGRES_URL
PGHOST
PGPORT
PGDATABASE
PGUSER
PGPASSWORD
```

애플리케이션은 가능하면 `DATABASE_URL` 하나를 사용합니다. 키의 실제 목록은 리소스 연결 화면의 metadata를 기준으로 하며 값은 출력하지 않습니다.

### migration 원칙

- RAIBITSERVER가 tenant 앱의 migration을 자동으로 추측해 실행한다고 가정하지 않습니다.
- migration은 idempotent하게 만들고, 시작 시 실행하거나 별도 `job` 서비스로 실행합니다.
- 여러 replica가 동시에 migration을 실행하지 않도록 DB lock 또는 별도 job을 사용합니다.
- 파괴적 schema 변경 전에는 백업과 복구 절차를 확인합니다.

### 현재 live 범위 주의

카탈로그에는 여러 엔진이 있지만 현재 live provider 범위는 동일하지 않습니다. PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey의 dedicated-local 지원과 Object Storage/Qdrant/NATS의 제한은 [리소스 프로비저닝](../provisioning.md)을 기준으로 확인합니다.

## 9. 도메인과 네트워크

- generated hostname은 base domain 바로 아래의 flat single-label 형식입니다.
- 기본 `web` 서비스는 `apps--<조직>--<프로젝트>.<base-domain>` 형태입니다.
- 이름이 `web`이 아닌 공개 서비스는 service 이름이 label에 추가될 수 있습니다.
- GitHub PR 번호가 전달된 미리보기는 `preview--pr-<번호>--...<base-domain>` 형태입니다.
- `private`, `worker`, `cron`, `job`은 공개 hostname이 없습니다.
- 앱은 DB, registry, Kubernetes API를 public internet에 직접 노출하지 않습니다.
- public URL 뒤에 reverse proxy가 있으므로 host와 HTTPS 처리 시 trusted proxy 정책을 명확히 설정합니다.

실제 운영 hostname은 콘솔의 배포 결과를 사용합니다. URL을 문자열 조합으로 추측하지 않습니다.

## 10. 배포 상태 해석

| 상태 | 의미 | 사용자 행동 |
| --- | --- | --- |
| `queued` | workflow 대기 | 잠시 기다리고 event 확인 |
| `BUILDING` | clone·build·scan·push 진행 | build log 확인 |
| `IMAGE_READY` | 이미지 준비 완료 | orchestrator 대기 |
| `DEPLOYING` | Kubernetes rollout 중 | Pod 상태와 event 확인 |
| `READY` | rollout record 완료. 앱 HTTP 정상은 보장하지 않음 | 공개 HTTP·상태 경로·기능 검증 |
| `BUILD_FAILED` | 소스 또는 이미지 단계 실패 | 최초 error log부터 수정 |
| `FAILED` | rollout·정책·runtime 실패 | event, Pod 상태, health 확인 |
| `CANCELLED` | 사용자 또는 시스템이 취소 | 새 배포 필요 |

`QUEUED`, `BUILDING`, `IMAGE_READY`만 취소할 수 있습니다. `READY` 이후 문제가 있으면 이전 `READY` 이미지로 확인된 롤백을 사용하거나 새 수정 배포를 만듭니다.

## 11. 업데이트와 삭제

### 업데이트

1. 저장소에 변경을 commit하고 branch에 push합니다.
2. CI를 통과시킵니다.
3. 서비스 설정의 branch, root directory, Dockerfile, 포트, 환경 변수를 확인합니다.
4. 새 운영 배포를 요청합니다.
5. 배포의 commit SHA가 의도한 commit과 같은지 확인합니다.
6. 기존 DB 데이터가 유지되는지 포함해 smoke test합니다.

### 삭제

- 프로젝트 삭제는 서비스, 배포, 리소스에 영향을 줄 수 있습니다.
- 관리형 리소스 삭제 전 백업과 보존 정책을 확인합니다.
- `READY` 리소스는 in-place 엔진 변경이나 재프로비저닝 대신 삭제 후 재생성이 필요할 수 있습니다.
- 삭제 요청 후 `DELETE_REQUESTED`, `DELETING` 같은 상태를 거쳐 실제 리소스가 정리될 수 있습니다.
- 이름이 사라졌다는 이유만으로 PVC, Secret, provider primitive까지 정리됐다고 가정하지 않습니다.

## 12. 배포 전 복사해서 쓰는 체크리스트

```text
[계정]
[ ] 이메일 인증과 관리자 승인이 완료됐다.
[ ] 대상 조직과 프로젝트에 권한이 있다.
[ ] 현재 쿼터 안에 있다.

[소스]
[ ] 저장소 URL과 branch가 정확하다.
[ ] 배포할 commit SHA를 확인했다.
[ ] 실제 .env와 secret을 commit하지 않았다.
[ ] root directory, Dockerfile 경로, build context가 source 경계 안에 있다.

[앱]
[ ] Linux 컨테이너로 빌드된다.
[ ] non-root로 실행된다.
[ ] 0.0.0.0의 서비스 포트에서 응답한다.
[ ] 제공하는 경우 /healthz/live와 /healthz/ready를 별도 HTTP 요청으로 확인했다.
[ ] SIGTERM을 처리한다.
[ ] 영구 데이터를 로컬 filesystem에 저장하지 않는다.

[리소스]
[ ] 필요한 관리형 리소스가 READY다.
[ ] 서비스 attachment와 Secret reference를 확인했다.
[ ] migration과 백업 방법을 준비했다.

[검증]
[ ] 저장소 CI가 통과한다.
[ ] 로컬 테스트와 Docker build가 성공한다.
[ ] 실제 배포가 READY다.
[ ] 공개 URL과 핵심 기능을 테스트했다.
[ ] 로그에 secret이 없다.
```

## 13. 사용자 또는 AI에게 전달할 배포 정보 양식

```yaml
project:
  name: ""
  organization: ""
service:
  name: web
  type: web
source:
  repository: "https://github.com/OWNER/REPO"
  branch: main
  expectedCommitSha: ""
  rootDirectory: "."
build:
  dockerfilePath: Dockerfile
  buildContext: "."
runtime:
  port: 8080
resources:
  - engine: postgresql
    attachAs: DATABASE_URL
verification:
  publicPath: "/"
  optionalApplicationHealthPaths:
    live: /healthz/live
    ready: /healthz/ready
  expectedHttpStatus: 200
  dataWriteReadRequired: true
```

값이 없는 항목을 AI가 임의로 만들어 내지 않도록 합니다. ID, commit SHA, URL, secret 이름은 API나 콘솔에서 실제 값을 조회해 채웁니다.
