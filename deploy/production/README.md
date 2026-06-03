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

- `*.apps.<BASE_DOMAIN>`, `*.preview.<BASE_DOMAIN>`, `*.console.<BASE_DOMAIN>`, `*.resources.<BASE_DOMAIN>`를 내부 Kubernetes Ingress Controller 하나로 보냅니다.
- `<user>-<project>.apps.<BASE_DOMAIN>` 같은 개별 tenant host는 Kubernetes Ingress Host rule이 처리합니다.
- `test.*.<BASE_DOMAIN>` 같은 중간 wildcard는 tunnel rule로 설계하지 않습니다.
- `admin`, `console`, `*.console`, `*.resources`에는 Cloudflare Access를 붙이고, Dashboard 앱의 `RAIBITSERVER_DASHBOARD_BASIC_AUTH`도 유지합니다.
- `/api/*`, `/api/*/stream`, `/github/webhooks`, `/api/github/webhooks`는 Cloudflare cache bypass로 둡니다.
- DB/TCP/registry/Kubernetes API/NodePort는 일반 사용자 public tunnel로 노출하지 않습니다.
- origin 서버 방화벽은 public inbound를 닫고 `cloudflared` outbound와 내부 cluster traffic만 허용합니다.

예시 config는 [`cloudflare-tunnel.example.yml`](cloudflare-tunnel.example.yml), 세부 guardrail은 [Cloudflare Tunnel 운영 가이드](../../docs/cloudflare-tunnel.md)를 확인하세요.

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
