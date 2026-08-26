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
- service/resource console은 각각 `console--...<BASE_DOMAIN>`, `resources--*.<BASE_DOMAIN>` 형태를 사용합니다.
- Cloudflare Tunnel에는 공개 apex, `api.<BASE_DOMAIN>`, `console.<BASE_DOMAIN>`, `*.<BASE_DOMAIN>`만 두고 최종 tenant Host match는 Kubernetes Ingress가 처리합니다.
- `test.*.<BASE_DOMAIN>` 같은 중간 wildcard나 `*.apps.<BASE_DOMAIN>` 같은 multi-level wildcard route는 사용하지 않습니다.
- 로그인은 중앙 `console.<BASE_DOMAIN>`에서 host-only HttpOnly 세션으로 처리합니다. 부모 도메인 쿠키는 tenant workload에 bearer token을 노출하므로 사용하지 않습니다. `console`, `console--*`, `resources--*`에는 Cloudflare Access와 앱 내부 RBAC를 유지하고, 필요하면 `RAIBITSERVER_DASHBOARD_BASIC_AUTH`를 추가 방어선으로 설정합니다.
- `/api/*`, `/api/*/stream`, `/github/webhooks`, `/api/github/webhooks`는 Cloudflare cache bypass로 둡니다.
- DB/TCP/registry/Kubernetes API/NodePort는 일반 사용자 public tunnel로 노출하지 않습니다.
- origin 서버 방화벽은 public inbound를 닫고 `cloudflared` outbound와 내부 cluster traffic만 허용합니다.

예시 config는 [`cloudflare-tunnel.example.yml`](cloudflare-tunnel.example.yml), 세부 guardrail은 [Cloudflare Tunnel 운영 가이드](../../docs/cloudflare-tunnel.md)를 확인하세요.

## main 자동 production 업데이트

`deploy/production/auto-update.sh`와 `install-auto-update.sh`는 GitHub `main`을 production에 자동 반영하는 서버측 updater입니다. GitHub Actions에 production credential을 저장하거나 public repository에 self-hosted runner를 붙이지 않습니다.

업데이트는 다음 순서로 fail-closed 동작합니다.

```txt
main SHA 변경 감지
→ 그 정확한 SHA의 push CI 확인
→ CI completed/success일 때만 전용 checkout으로 fetch
→ Helm 관리 platform image 7개 build/push
→ 각 image digest cosign 서명
→ production-values.yaml의 digest pin 갱신 후보 생성
→ helm lint/template
→ helm upgrade --install --atomic
→ API/Dashboard rollout 확인
→ 성공한 SHA를 state에 기록
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

성공한 production SHA와 실행 상태는 별도 state 디렉터리에 기록됩니다.

```txt
~/.local/state/raibitserver-auto-update/deployed-sha
~/.local/state/raibitserver-auto-update/last-success.json
```

서버별 non-secret 설정은 설치 시 다음 파일에 생성되며 필요하면 수정할 수 있습니다.

```txt
~/.config/raibitserver/auto-update.env
```

기본값은 `jsk1004ha/RaibitServer`, `main`, `~/production-values.yaml`, `raibit-prod-builder`, `raibitserver-system`, `ghcr.io/jsk1004ha/raibitserver`입니다. updater는 기존 Kubernetes Secret, registry login, cosign key를 그대로 사용하며 secret 값을 GitHub나 updater config에 복사하지 않습니다.

자동 업데이트를 일시 중지/재개하려면 timer만 제어합니다.

```sh
sudo systemctl disable --now raibitserver-auto-update.timer
sudo systemctl enable --now raibitserver-auto-update.timer
```

실패한 update는 `helm --atomic`으로 release를 이전 정상 상태로 되돌리고 `deployed-sha`를 갱신하지 않습니다. 따라서 다음 정상 `main` commit이 CI를 통과하면 다시 업데이트됩니다.

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
