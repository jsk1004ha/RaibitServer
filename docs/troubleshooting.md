# 문제 해결

> 이 문서는 RAIBITSERVER를 설치, 검증, 배포할 때 자주 만나는 실패와 우선 확인 순서를 정리합니다.

## `pnpm install --frozen-lockfile` 실패

### 증상

- lockfile 설치가 실패합니다.
- pnpm version mismatch 또는 Node.js version 오류가 납니다.

### 확인

```sh
node --version
corepack enable
pnpm --version
```

### 해결

- Node.js 24+를 사용합니다.
- 저장소는 `packageManager: pnpm@11.1.2`를 pinning합니다.
- corepack으로 pnpm 11.1.2를 활성화한 뒤 다시 설치합니다.

## Production API가 부팅을 거부함

### 증상

Production mode에서 in-memory fallback으로 뜨지 않고 부팅이 실패합니다.

### 확인할 환경 변수

```txt
DATABASE_URL
ENCRYPTION_KEY 또는 RAIBITSERVER_SECRET_ENCRYPTION_KEY
JWT_SECRET 또는 RAIBITSERVER_AUTH_JWT_SECRET
```

### 해결

Production persistence는 Prisma/PostgreSQL을 기본으로 사용합니다. In-memory repository는 dev/test fallback 전용이며, production에서는 명시적 opt-in 없이 사용하지 않습니다.

## Dry E2E는 성공하지만 Live E2E가 즉시 실패

### 증상

`pnpm e2e:live`가 build나 Kubernetes apply를 시작하기 전에 실패합니다.

### 확인

```sh
docker version
kind version
kubectl version --client=true
helm version
go version
```

### 해결

- Docker가 실행 중인지 확인합니다.
- `kind`, `kubectl`, Helm, curl, Go, base64가 설치되어 있는지 확인합니다. 현재 live gate는 k3d를 사용하지 않습니다.
- 같은 이름의 kind cluster가 있으면 삭제하거나 `RAIBITSERVER_LIVE_E2E_CLUSTER`에 사용하지 않는 이름을 지정합니다.

스크립트는 별도 live report 파일을 만들지 않습니다. 실패 시 표준 오류에 출력되는 control-plane/provider resource와 Pod log diagnostics에서 최초 실패 지점을 확인합니다.

## Deployment가 보안 정책에 차단됨

### 증상

manifest compile 또는 deployment queue 단계에서 security policy 오류가 발생합니다.

### 원인

RAIBITSERVER는 다음을 차단합니다.

- privileged container
- root execution
- host networking
- host PID/IPC
- hostPath
- capability addition
- writable non-`/tmp` mount
- service-account token automount
- non-`RuntimeDefault` seccomp

### 해결

서비스 desired state를 수정한 뒤 다시 deployment를 요청합니다. 자세한 정책은 [보안 문서](security.md)를 확인하세요.

## DB console query가 거부됨

### 확인할 것

- viewer role은 read-only query만 실행할 수 있습니다.
- non-read SQL은 `db:query` permission과 `confirmed: true`가 모두 필요합니다.
- live PostgreSQL query는 resource의 provider-owned connection URL이 필요합니다.
- request-supplied connection URL/URI/DSN/JDBC 값은 무시되거나 제거됩니다.
- SQLite는 provider-owned `.raibitserver-work/sqlite` root 밖의 파일을 열 수 없습니다.
- SQLite는 `ATTACH`, `DETACH`, `VACUUM INTO`, `load_extension`, unsafe PRAGMA를 차단합니다.

## 추가 확인 명령

```sh
pnpm test
pnpm typecheck
node scripts/check-structure.js
pnpm e2e:dry
```

변경 영역별 명령은 [검증 명령 매트릭스](verification-commands.md)를 참고하세요.
