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

## `registry credential broker request failed`

### 증상

source clone과 commit pin은 성공하고 `Dockerfile selected` 다음에 credential broker 요청이 즉시 실패합니다. 이 순서라면 애플리케이션 build가 시작되기 전에, executor가 short-lived registry credential을 받는 네트워크 단계에서 멈춘 것입니다.

### 원인

executor는 registry credential을 받기 위해 `registry-auth.<domain>`에 HTTPS로 연결합니다. 자체 registry 구성에서는 cluster 내부 CoreDNS가 `registry.<domain>`과 `registry-auth.<domain>`을 전용 `raibit-registry-auth` Service의 ClusterIP로 보냅니다. 이 전용 Pod만 TLS 8443을 열고, executor NetworkPolicy도 정확한 namespace와 Pod label, port만 허용합니다. Helm release에 workload registry overlay가 빠졌거나 bootstrap이 예전 구성이면 GitHub 같은 public HTTPS clone은 성공해도 이 내부 broker 연결만 차단됩니다.

### 확인

서버에서 전용 Service 주소, CoreDNS 매핑, 생성된 overlay와 executor 정책을 순서대로 확인합니다. overlay에는 secret 값이 아니라 기존 Secret 이름만 있어야 합니다.

```sh
kubectl -n raibitserver-infra get service raibit-registry-auth -o wide
kubectl -n kube-system get configmap coredns -o jsonpath='{.data.NodeHosts}'
cat ~/.config/raibitserver/workload-registry-values.yaml
kubectl -n raibitserver-system get networkpolicy raibitserver-builder-executor -o yaml
```

CoreDNS의 `NodeHosts`에서 두 registry hostname은 `raibit-registry-auth` Service의 ClusterIP와 같아야 합니다. overlay에는 `privateGateway.enabled: true`, namespace `raibitserver-infra`, Pod 이름 `raibit-registry-auth`, `servicePort: 443`, `port: 8443`이 있어야 합니다. NetworkPolicy에도 같은 namespaceSelector와 podSelector 아래 TCP 443/8443 조합이 렌더되어야 합니다. 서버 자체의 `/etc/hosts`는 Docker smoke test를 위해 노드 IP를 사용할 수 있으므로, 서버에서 실행한 `getent hosts` 결과만으로 Pod의 split DNS를 판단하지 않습니다.

### 해결

최신 checkout에서 bootstrap을 다시 실행해 전용 TLS gateway와 selector 기반 overlay를 만들고, updater를 다시 설치한 뒤 즉시 한 번 실행합니다. updater는 `main` SHA가 이전 배포와 같아도 overlay 입력 digest가 달라졌으면 같은 승인 commit을 다시 배포합니다.

```sh
bash deploy/production/bootstrap-workload-registry.sh
sudo bash deploy/production/install-auto-update.sh "$USER"
sudo systemctl start raibitserver-auto-update.service
journalctl -u raibitserver-auto-update.service -f
```

새 builder는 전송 실패를 비밀 URL이나 token 없이 더 구체적으로 기록합니다. `DNS lookup failed`는 CoreDNS/hostname, `TLS certificate validation failed`는 인증서 SAN 또는 CA, `connection was refused`는 ingress listener, `network is unreachable` 또는 `request timed out`은 NetworkPolicy와 routing을 우선 확인합니다.

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
