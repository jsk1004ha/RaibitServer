# Cloudflare Tunnel 운영 가이드

> RAIBITSERVER에서 Cloudflare Tunnel은 public HTTP/HTTPS 진입점일 뿐입니다. Tunnel은 origin IP를 숨기고 edge 정책을 적용하는 데 유용하지만, RAIBITSERVER의 JWT/RBAC/quota/audit, tenant isolation, secret sealing, NetworkPolicy를 대체하지 않습니다.

## 적용 범위

무료/자체 운영 환경에서는 Cloudflare Universal SSL의 `*.<BASE_DOMAIN>` 한 장으로 모든 generated tenant hostname을 커버할 수 있도록 tenant route를 **base domain 바로 아래 한 개 DNS label**로 평탄화합니다. Cloudflare Tunnel은 `api.<BASE_DOMAIN>`, `console.<BASE_DOMAIN>`, `*.<BASE_DOMAIN>`만 public HTTPS 진입점으로 사용합니다.

중간 wildcard(`test.*.example.com`)나 `*.apps.<BASE_DOMAIN>`처럼 더 깊은 hostname을 생성하지 않습니다.

## 권장 요청 경로

```txt
사용자
  -> Cloudflare DNS/WAF/Access/Cache Rules
     -> Cloudflare Tunnel(cloudflared, outbound-only)
        -> 내부 Kubernetes Ingress Controller
           -> Kubernetes Ingress Host rule
              -> RAIBITSERVER API/Dashboard 또는 tenant Service
```

Cloudflare Tunnel에는 각 tenant service hostname을 직접 나열하지 않습니다.

| Cloudflare hostname | 내부 대상 | 최종 라우팅 주체 |
| --- | --- | --- |
| `api.<BASE_DOMAIN>` | 내부 Kubernetes Ingress Controller | API Ingress |
| `console.<BASE_DOMAIN>` | 내부 Kubernetes Ingress Controller | Dashboard Ingress |
| `*.<BASE_DOMAIN>` | 내부 Kubernetes Ingress Controller | tenant app/preview/console/resource Ingress |

Generated hostname은 모두 한 label 안에 route 종류와 tenant identity를 인코딩합니다.

| 용도 | 예시 |
| --- | --- |
| 서비스 | `apps--gdg-hongik--festival-2026.<BASE_DOMAIN>` |
| 추가 서비스 | `apps--gdg-hongik--festival-2026--api.<BASE_DOMAIN>` |
| Preview | `preview--pr-32--gdg-hongik--festival-2026.<BASE_DOMAIN>` |
| 서비스 콘솔 | `console--gdg-hongik--festival-2026-api.<BASE_DOMAIN>` |
| 리소스 콘솔 | `resources--gdg-hongik--festival-2026-postgres.<BASE_DOMAIN>` |

두 slug 사이의 `--` 경계와 긴 label의 deterministic hash suffix는 유지합니다. 각 generated DNS label은 63자를 넘지 않습니다. 이 구조는 `*.<BASE_DOMAIN>` 하나로 모든 generated tenant route를 커버하므로 Cloudflare 무료 Universal SSL과 호환됩니다.

예시는 [`deploy/production/cloudflare-tunnel.example.yml`](../deploy/production/cloudflare-tunnel.example.yml)을 확인하세요.

## Cloudflare Access 필수 보호면

다음 hostname은 Cloudflare Access self-hosted application으로 보호합니다.

| 보호 대상 | 정책 |
| --- | --- |
| `console.<BASE_DOMAIN>` | 관리자/운영자 IdP group + MFA 권장 |
| `console--*.<BASE_DOMAIN>` | 로그인 사용자 + 조직/운영자 정책. 앱 내부 RBAC는 계속 필수 |
| `resources--*.<BASE_DOMAIN>` | 로그인 사용자 + DB/resource 권한 정책. 앱 내부 `db:*` permission은 계속 필수 |

Dashboard는 server-side token(`RAIBITSERVER_DASHBOARD_TOKEN` 또는 `RAIBITSERVER_TOKEN`)으로 API를 렌더링할 수 있으므로 Cloudflare Access만 믿지 말고 `RAIBITSERVER_DASHBOARD_BASIC_AUTH=<user>:<strong-password>`도 유지합니다. 기존 fail-safe와 동일하게 server token이 있는데 Basic Auth가 없으면 Dashboard public 요청은 503으로 막혀야 합니다.

## API, SSE, webhook cache/WAF 규칙

Cloudflare zone rules는 Tunnel로 공개한 hostname에도 적용됩니다. RAIBITSERVER API, SSE log stream, GitHub webhook에는 다음 edge rule을 둡니다.

| Path | Cache | WAF/rate limit |
| --- | --- | --- |
| `/api/*` | bypass | JWT/RBAC 유지, IP+path 기준 rate limit |
| `/api/*/stream` | bypass | SSE가 끊기지 않게 buffering/cache 변형 금지 |
| `/github/webhooks`, `/api/github/webhooks` | bypass | HMAC 실패는 앱에서 거부. WAF false positive가 확인된 managed rule만 path-scoped skip |

Webhook에는 Cloudflare Access 사용자 로그인을 붙이지 않습니다. 대신 RAIBITSERVER의 `RAIBITSERVER_GITHUB_WEBHOOK_SECRET`/`GITHUB_WEBHOOK_SECRET` HMAC 검증, delivery dedupe, audit log를 유지합니다.

## DB/TCP 공개 금지

Cloudflare Tunnel의 HTTP/HTTPS public hostname은 tenant 앱과 control-plane HTTP에만 사용합니다. PostgreSQL/MySQL/Redis 같은 DB 포트를 일반 사용자용 public tunnel로 열지 않습니다.

- 사용자 DB UI: RAIBITSERVER API를 통한 mediated DB/resource console만 사용합니다.
- 운영자 DB 접속: WARP private network, Access for Infrastructure/SSH bastion, 또는 별도 VPN으로 분리합니다.
- Registry, Kubernetes API, provider admin endpoint도 public tunnel 대상이 아닙니다.

## Origin bypass 차단

Tunnel이 있어도 origin port가 인터넷에 열려 있으면 공격자는 Cloudflare를 우회할 수 있습니다. production 서버/클러스터는 다음을 만족해야 합니다.

- API/Dashboard process는 `127.0.0.1` 또는 cluster-internal Service로만 bind합니다.
- NodePort, ingress controller, registry, API `3000`, DB/Redis/provider port를 public internet에 열지 않습니다.
- 서버 방화벽은 inbound를 기본 차단하고, `cloudflared` outbound와 관리용 SSH/VPN/Access 경로만 허용합니다.
- SSH는 Cloudflare Access, WARP/private network, 또는 별도 bastion으로 제한합니다.

## Go-live checklist

- [ ] `cloudflared`가 내부 Kubernetes Ingress Controller의 HTTPS/websecure endpoint만 origin으로 사용한다.
- [ ] generated tenant hostname이 모두 `*.<BASE_DOMAIN>` 한 단계 아래에 있다.
- [ ] Tunnel ingress rule은 `api.<BASE_DOMAIN>`, `console.<BASE_DOMAIN>`, `*.<BASE_DOMAIN>`와 catch-all만 사용한다.
- [ ] `console`, `console--*`, `resources--*`에 Cloudflare Access 정책이 있다.
- [ ] `RAIBITSERVER_DASHBOARD_BASIC_AUTH`가 production secret으로 설정되어 있다.
- [ ] `/api/*`, `/api/*/stream`, `/github/webhooks`, `/api/github/webhooks` cache bypass rule이 있다.
- [ ] WAF skip은 webhook false positive가 증명된 rule/path에만 최소 범위로 둔다.
- [ ] tenant apps/API에는 Cloudflare rate limiting이 있고, 앱 내부 JWT/RBAC/quota/audit이 켜져 있다.
- [ ] DB/TCP/registry/Kubernetes API/NodePort는 public tunnel 또는 public firewall에 열려 있지 않다.

## 근거 문서

- Cloudflare Tunnel configuration file wildcard 제한: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/
- Cloudflare Access policies: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/
- Cloudflare Cache Rules bypass: https://developers.cloudflare.com/cache/how-to/cache-rules/settings/
- Cloudflare WAF skip options: https://developers.cloudflare.com/waf/custom-rules/skip/options/
- Cloudflare Tunnel published application protocols/TCP caveat: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/
- Cloudflare Tunnel firewall model: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/
