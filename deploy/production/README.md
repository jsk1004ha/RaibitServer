# RAIBITSERVER Production 배포

> Production은 관리형 PostgreSQL, 격리된 Kubernetes runtime, signed image, audit log, quota enforcement를 필수로 사용하는 운영 환경입니다.

## 목적

Production 배포 전 필수 의존성과 보안/운영 조건을 한곳에서 확인합니다.

## 필수 인프라

- Control-plane용 managed PostgreSQL
- 격리된 Kubernetes runtime cluster
- image registry
- ingress controller와 TLS 인증서
- Redis 또는 queue/cache backend
- object storage/S3-compatible backend
- audit log 보관 경로
- 모니터링/로그 수집 경로

## 필수 환경 변수

```txt
DATABASE_URL
RAIBITSERVER_SECRET_ENCRYPTION_KEY 또는 ENCRYPTION_KEY
RAIBITSERVER_AUTH_JWT_SECRET 또는 JWT_SECRET
ADMIN_EMAILS
BASE_DOMAIN
REGISTRY_URL
KUBECONFIG 또는 in-cluster config
```

GitHub 연동을 사용하면 다음도 필요합니다.

```txt
GITHUB_APP_ID
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
GITHUB_PRIVATE_KEY
GITHUB_WEBHOOK_SECRET
```

## Go worker store 설정

Go builder는 production에서 PostgreSQL control-plane store를 poll할 수 있어야 합니다.

```txt
RAIBITSERVER_CONTROL_PLANE_DATABASE_URL
```

또는 다음 조합을 사용할 수 있습니다.

```txt
RAIBITSERVER_CONTROL_PLANE_STORE=postgresql
DATABASE_URL
```

`RAIBITSERVER_CONTROL_PLANE_FILE`은 deterministic local worker mode 전용입니다.

## Go-live 전 검증

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm prisma:validate
node src/cli.js validate examples/project.json
node src/cli.js manifest examples/project.json >/tmp/raibitserver-manifest.json
node src/cli.js compose examples/docker-compose.yml >/tmp/raibitserver-compose-plan.json
pnpm e2e:dry
```

Go가 설치되어 있으면 다음도 통과해야 합니다.

```sh
for dir in services/builder services/orchestrator services/provisioner services/log-ingester services/metrics-ingester; do
  (cd "$dir" && go test ./... && go build ./...)
done
```

Disposable local cluster smoke test가 필요하면 [Live E2E](../../docs/live-e2e.md)를 실행합니다.

## Cloudflare Tunnel edge 배포

Cloudflare Tunnel을 production ingress 앞단으로 사용할 수 있지만, Tunnel은 HTTP/HTTPS edge 진입점으로만 둡니다.

무료/자체 운영 배포에서는 generated tenant hostname을 모두 base domain 바로 아래 **한 개 DNS label**로 평탄화합니다. 그러면 Cloudflare Universal SSL의 `*.<BASE_DOMAIN>` wildcard 하나로 app/preview/console/resource 주소를 모두 커버할 수 있습니다.

- 플랫폼 주소는 공개 apex, `api.<BASE_DOMAIN>`, `console.<BASE_DOMAIN>`을 유지합니다.
- tenant 서비스는 `apps--<org>--<project>[--<service>].<BASE_DOMAIN>` 형태를 사용합니다.
- preview는 `preview--pr-<number>--<org>--<project>[--<service>].<BASE_DOMAIN>` 형태를 사용합니다.
- service/resource console은 각각 `console--...<BASE_DOMAIN>`, `resources--...<BASE_DOMAIN>` 형태를 사용합니다.
- Cloudflare Tunnel에는 공개 apex, `api.<BASE_DOMAIN>`, `console.<BASE_DOMAIN>`, `*.<BASE_DOMAIN>`만 두고 최종 tenant Host match는 Kubernetes Ingress가 처리합니다.
- `test.*.<BASE_DOMAIN>` 같은 중간 wildcard나 `*.apps.<BASE_DOMAIN>` 같은 multi-level wildcard route는 사용하지 않습니다.
- 로그인은 중앙 `console.<BASE_DOMAIN>`에서 host-only HttpOnly 세션으로 처리합니다. 부모 도메인 쿠키는 tenant workload에 bearer token을 노출하므로 사용하지 않습니다. `console`, `console--*`, `resources--*`에는 Cloudflare Access와 앱 내부 RBAC를 유지하고, 필요하면 `RAIBITSERVER_DASHBOARD_BASIC_AUTH`를 추가 방어선으로 설정합니다.
- `/api/*`, `/api/*/stream`, `/github/webhooks`, `/api/github/webhooks`는 Cloudflare cache bypass로 둡니다.
- DB/TCP/registry/Kubernetes API/NodePort는 일반 사용자 public tunnel로 노출하지 않습니다.
- origin 서버 방화벽은 public inbound를 닫고 `cloudflared` outbound와 내부 cluster traffic만 허용합니다.

예시 config는 [`cloudflare-tunnel.example.yml`](cloudflare-tunnel.example.yml), 세부 guardrail은 [Cloudflare Tunnel 운영 가이드](../../docs/cloudflare-tunnel.md)를 확인하세요.

## Workload registry와 credential broker 연결

`bootstrap-workload-registry.sh`는 registry와 credential broker를 배포한 뒤, cluster 안에서 두 공개 hostname을 전용 `raibit-registry-auth` Service의 ClusterIP로 해석하도록 split DNS를 구성합니다. 이 Pod는 8443에서 TLS를 직접 종료하고 요청의 SNI와 `Host`가 정확히 `registry.<domain>` 또는 `registry-auth.<domain>`인지 검사합니다. broker hostname은 기존 broker handler로 보내고 registry hostname은 고정된 내부 `raibit-registry:5000` Service로만 전달합니다. Registry의 upload `Location`은 상대 URL로 고정해 내부 Service 주소가 client에 노출되거나 다음 push 요청이 gateway를 이탈하지 않게 합니다.

빌드 executor의 NetworkPolicy에는 공유 Traefik IP나 사설 CIDR 예외를 넣지 않습니다. 대신 `raibitserver-infra` namespace의 `app.kubernetes.io/name=raibit-registry-auth` Pod만 선택하고, Service 포트 443과 실제 TLS listener 포트 8443만 허용합니다. 두 포트를 함께 적는 이유는 Service DNAT과 NetworkPolicy 처리 순서가 네트워크 플러그인마다 다를 수 있기 때문입니다. 대상 Pod 경계는 그대로이므로 사용자 Dockerfile이 같은 노드의 다른 HTTPS virtual host나 metadata/private network로 우회할 수 없습니다. broker token 값도 Helm values에 기록하지 않고 기존 Kubernetes Secret 이름만 참조합니다.

서버 사용자로 저장소 checkout에서 실행합니다. 스크립트 안에서 필요한 K3s 작업만 `sudo`를 사용하므로 스크립트 자체를 `sudo bash`로 실행하지 않습니다.

```sh
bash deploy/production/bootstrap-workload-registry.sh
```

성공하면 다음 두 파일이 mode `0600`으로 생성됩니다.

```txt
~/.config/raibitserver/workload-registry.env
~/.config/raibitserver/workload-registry-values.yaml
```

첫 파일은 확인용 non-secret 설정이고, 두 번째 파일은 `builder.registry`, broker URL, 기존 Kubernetes Secret 이름, 전용 게이트웨이 namespace·Pod label·port만 담는 Helm overlay입니다. 자동 updater는 overlay와 모든 상위 디렉터리의 종류·소유자·쓰기 권한을 검사하고, symlink를 따라가지 않는 file descriptor에서 최대 1 MiB의 immutable snapshot을 만든 뒤 `helm lint`, `helm template`, `helm upgrade` 세 단계에 같은 snapshot을 적용합니다.

자동 updater는 기존 `raibit-registry` StatefulSet을 발견하면 overlay나 새 상태 파일이 아직 없어도 workload registry를 관리 대상으로 인식합니다. CI를 통과한 정확한 commit에서 `registry-broker` image를 별도로 build·서명하고, [`reconcile-workload-registry-gateway.sh`](reconcile-workload-registry-gateway.sh)로 전용 TLS gateway, 상대 registry URL, NetworkPolicy, CoreDNS split DNS를 재조정합니다. 변경 전에 API server dry-run을 수행하며, 기존 상태와 적용 직후 상태를 따로 저장합니다. 이후 단계가 실패하면 UID·spec·annotation 또는 ConfigMap 값이 적용 직후 상태와 정확히 같을 때만 이전 상태로 되돌립니다. 다른 운영 작업이 동시에 값을 바꾼 경우에는 그 변경을 덮어쓰지 않고 중단합니다. 처음 생성되어 이전 spec이 없는 객체도 경합 가능성이 있는 무조건 삭제를 하지 않으며, 명시적인 복구 오류를 남깁니다.

재조정과 평상시 5분 점검에서는 빌더 Secret과 broker runtime Secret의 **값을 출력하지 않고 SHA-256만 비교**합니다. 이어서 전용 ClusterIP·TLS 경로로 실제 `POST /broker` 요청을 보내 짧은 수명의 자격증명이 발급되는지 확인하고, registry `/v2/`가 정확히 HTTP 401과 하나의 Bearer challenge를 반환하는지 검사합니다. realm은 `https://registry-auth.<domain>/token`, service는 설정된 registry service와 정확히 일치해야 합니다. 따라서 Deployment가 Ready라는 이유만으로 고장 난 토큰·라우팅을 정상으로 오판하지 않습니다.

이미 구버전 자동 updater가 설치된 서버에서 `registry credential broker request failed`를 복구할 때는 timer를 그대로 두면 됩니다. 첫 주기는 CI를 통과한 새 `main`을 일반 platform에 반영하고 updater 자체를 교체하며, 다음 약 5분 주기는 새 updater가 registry gateway를 탐지해 재조정합니다. 진행 상황은 다음 명령으로 두 주기 모두 확인합니다.

```sh
systemctl status raibitserver-auto-update.timer
journalctl -u raibitserver-auto-update.service -f
```

timer가 아직 설치되지 않은 새 서버만 먼저 `bootstrap-workload-registry.sh`를 실행한 뒤 `install-auto-update.sh`를 설치합니다.

수동 Helm 배포를 하는 서버라면 기존 production values 뒤에 overlay를 추가합니다. 아래 예시는 Helm 3용입니다.

```sh
helm upgrade --install raibitserver infra/helm/raibitserver \
  --namespace raibitserver-system \
  --create-namespace \
  -f ~/production-values.yaml \
  -f ~/.config/raibitserver/workload-registry-values.yaml \
  --atomic --timeout 20m
```

Helm 4에서는 마지막 줄의 `--atomic` 대신 `--rollback-on-failure --wait=watcher --wait-for-jobs`를 사용합니다.

## main 자동 production 업데이트

`deploy/production/auto-update.sh`와 `install-auto-update.sh`는 GitHub `main`을 production에 자동 반영하는 서버측 updater입니다. GitHub Actions에 production credential을 저장하거나 public repository에 self-hosted runner를 붙이지 않습니다.

업데이트는 다음 순서로 fail-closed 동작합니다.

```txt
main SHA 변경 감지
→ 저장된 registry 상태 digest와 실제 broker 발급·토큰 일치 상태 확인
→ 새 SHA 또는 drift가 있으면 그 정확한 SHA의 push CI 확인
→ CI completed/success일 때만 전용 checkout으로 fetch
→ platform 변경 시 Helm 관리 image 7개 build/push
→ registry 변경·drift 시 registry-broker image build/push
→ 각 image digest cosign 서명
→ production-values.yaml의 digest pin 갱신 후보 생성
→ workload registry overlay의 소유권·권한 검사 및 snapshot 생성
→ registry overlay 후보로 helm lint/template 사전 검증
→ 전용 TLS gateway·registry config·CoreDNS를 비교 후 재조정
→ 두 values를 함께 사용해 최종 helm lint/template
→ Helm major 확인(3: --atomic, 4: --rollback-on-failure + watcher wait)
→ helm upgrade --install
→ API/Dashboard rollout 확인
→ 실제 broker 발급과 registry challenge를 다시 확인
→ 승인 checkout의 updater를 libexec에 원자적으로 self-refresh
→ 성공한 platform·registry SHA와 상태 digest를 state에 기록
```

CI가 아직 실행 중이면 다음 timer 주기까지 기다립니다. CI가 실패한 SHA는 production에 배포하지 않으며, 새로운 `main` SHA가 생길 때까지 현재 release를 유지합니다. updater는 `flock`으로 직렬화되어 이전 build/deploy가 끝나기 전에 다음 실행이 겹치지 않습니다.

현재 서버에 설치할 때는 repository checkout에서 다음을 실행합니다.

```sh
sudo bash deploy/production/install-auto-update.sh raibit1
```

설치 후 systemd timer는 boot 후 첫 확인을 수행하고, 각 실행이 끝난 뒤 약 5분 간격으로 다시 `main`을 확인합니다. 첫 확인은 설치 직후에도 비동기로 시작됩니다.

```sh
systemctl status raibitserver-auto-update.timer
systemctl status raibitserver-auto-update.service
journalctl -u raibitserver-auto-update.service -f
```

updater는 사람이 사용하는 repository checkout을 `git reset`하지 않습니다. 별도의 managed checkout을 사용합니다.

```txt
~/.local/share/raibitserver-production/repository
```

설치된 실행 파일은 다음 경로에 있으며, 성공한 rollout 뒤 같은 SHA의 checkout에 포함된 새 updater로 원자적으로 교체됩니다. 따라서 updater 자체의 수정도 다음 배포 성공 시 서버에 반영됩니다.

```txt
~/.local/libexec/raibitserver-production-auto-update
```

installer는 이 절대 경로를 systemd의 `RAIBITSERVER_UPDATER_LIBEXEC_PATH` 환경 변수로 전달합니다. root installer는 사용자 홈 아래 관리 경로의 기존 구성요소에 symlink나 일반 파일이 끼어 있으면 쓰기 전에 중단하며, 홈 아래 디렉터리·실행 파일·환경 파일은 `runuser`로 대상 사용자 권한에서 생성합니다. updater는 시작할 때 libexec 디렉터리가 canonical한 현재 실행 사용자 소유의 실제 디렉터리인지, group/world writable이 아닌지, 기존 대상이 symlink가 아닌 일반 파일인지 확인합니다. 승인 checkout의 새 스크립트도 일반 파일과 Bash 구문을 확인한 후 같은 디렉터리에서 임시 파일을 만들고 `mv`로 교체합니다. 이 검증이 실패하면 rollout이 완료되었더라도 성공 SHA를 기록하지 않으므로 운영자가 경로 권한을 수정한 뒤 안전하게 다시 실행할 수 있습니다.

성공한 production SHA와 실행 상태는 별도 state 디렉터리에 기록됩니다.

```txt
~/.local/state/raibitserver-auto-update/deployed-sha
~/.local/state/raibitserver-auto-update/deployed-input-digest
~/.local/state/raibitserver-auto-update/registry-reconciled-sha
~/.local/state/raibitserver-auto-update/registry-reconciled-input-digest
~/.local/state/raibitserver-auto-update/registry-reconciled-state-digest
~/.local/state/raibitserver-auto-update/last-success.json
```

`deployed-input-digest`는 production values와 실제 적용한 workload registry overlay snapshot의 SHA-256입니다. registry용 세 상태 파일은 마지막으로 재조정한 commit·입력 digest·Kubernetes desired-state digest를 따로 기록합니다. `main` SHA가 같아도 설정이나 gateway/NetworkPolicy/registry config/CoreDNS가 달라지거나 실제 broker 점검이 실패하면 updater는 `already running`으로 종료하지 않고 같은 승인 commit을 다시 검증해 복구합니다. 이 state가 없는 구버전 updater에서 처음 전환할 때도 한 번 재조정되므로 새 overlay가 기존 commit에 누락되는 상황을 막습니다.

서버별 non-secret 설정은 설치 시 다음 파일에 생성되며 필요하면 수정할 수 있습니다.

```txt
~/.config/raibitserver/auto-update.env
```

기본값은 `jsk1004ha/RaibitServer`, `main`, `~/production-values.yaml`, `~/.config/raibitserver/workload-registry-values.yaml`, `raibit-prod-builder`, `raibitserver-system`, `ghcr.io/jsk1004ha/raibitserver`입니다. registry overlay가 없는 설치에서는 기존 단일 values 동작을 유지합니다. updater는 기존 Kubernetes Secret, registry login, cosign key를 그대로 사용하며 secret 값을 GitHub나 updater config에 복사하지 않습니다.

자동 업데이트를 일시 중지/재개하려면 timer만 제어합니다.

```sh
sudo systemctl disable --now raibitserver-auto-update.timer
sudo systemctl enable --now raibitserver-auto-update.timer
```

Helm 3에서는 `--atomic`, Helm 4에서는 공식 대체 flag인 `--rollback-on-failure --wait=watcher --wait-for-jobs`로 실패한 update를 이전 정상 상태로 되돌리고 준비 상태를 기다립니다. 파싱할 수 없는 버전이나 Helm 3/4 이외 major는 배포 전에 fail-fast합니다. 어떤 경우에도 실패한 실행은 `deployed-sha`를 갱신하지 않으므로 다음 정상 `main` commit이 CI를 통과하면 다시 업데이트됩니다.

## Production 안전 조건

- In-memory store는 production에서 사용하지 않습니다.
- Secret은 sealed row 또는 Kubernetes Secret ref로만 저장합니다.
- 사용자 workload는 privileged/root/hostPath/hostNetwork를 사용할 수 없습니다.
- Image signing과 vulnerability scanning을 release gate에 연결합니다.
- Quota와 audit log가 켜져 있어야 합니다.
- DB/resource provider credential은 tenant request body에서 받지 않습니다.

## 관련 문서

- [아키텍처](../../docs/architecture.md)
- [Cloudflare Tunnel 운영](../../docs/cloudflare-tunnel.md)
- [보안](../../docs/security.md)
- [리소스 프로비저닝](../../docs/provisioning.md)
- [검증 명령](../../docs/verification-commands.md)
- [문제 해결](../../docs/troubleshooting.md)
