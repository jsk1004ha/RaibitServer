# Cloudflare Tunnel 운영 가이드

> RAIBITSERVER에서 Cloudflare Tunnel은 public HTTP/HTTPS 진입점일 뿐입니다. Tunnel은 origin IP를 숨기고 edge 정책을 적용하는 데 유용하지만, RAIBITSERVER의 JWT/RBAC/quota/audit, tenant isolation, secret sealing, NetworkPolicy를 대체하지 않습니다.

## 적용 범위

이 문서는 `*.apps`, `*.preview`, `*.console`, `*.resources` wildcard host를 Cloudflare Tunnel로 공개할 때 필요한 routing, Access, cache/WAF, TCP, origin-bypass guardrail을 정의합니다. Cloudflare는 2026년 5월 기준 ingress hostname wildcard로 `*.example.com` 형태는 지원하지만 `test.*.example.com` 같은 중간 wildcard는 지원하지 않습니다.

## 권장 요청 경로

```txt
사용자
  -> Cloudflare DNS/WAF/Access/Cache Rules
     -> Cloudflare Tunnel(cloudflared, outbound-only)
        -> 내부 Kubernetes Ingress Controller
           -> Kubernetes Ingress Host rule
              -> RAIBITSERVER API/Dashboard 또는 tenant Service
```

Cloudflare Tunnel에는 각 tenant service hostname을 직접 나열하지 않습니다. 다음 zone-level hostname만 tunnel ingress에 둡니다.

| Cloudflare hostname | 내부 대상 | 최종 라우팅 주체 |
| --- | --- | --- |
| `api.<BASE_DOMAIN>` | 내부 Ingress Controller | API Ingress |
| `admin.<BASE_DOMAIN>`, `console.<BASE_DOMAIN>` | 내부 Ingress Controller | Dashboard/Admin Ingress |
| `*.apps.<BASE_DOMAIN>` | 내부 Ingress Controller | tenant app Ingress |
| `*.preview.<BASE_DOMAIN>` | 내부 Ingress Controller | PR preview Ingress |
| `*.console.<BASE_DOMAIN>` | 내부 Ingress Controller | service console Ingress |
| `*.resources.<BASE_DOMAIN>` | 내부 Ingress Controller | resource console/API Ingress |

RAIBITSERVER의 generated app host는 `<user>--<project>.apps.<BASE_DOMAIN>`처럼 wildcard 아래의 단일 DNS label에 user/project를 인코딩하며, 두 slug 사이에는 경계 충돌을 막는 `--` 구분자를 둡니다. Preview는 `pr-<number>-<user>--<project>.preview.<BASE_DOMAIN>`를 사용합니다. `web.project.org.apps.<BASE_DOMAIN>`처럼 여러 label을 쓰면 `*.apps.<BASE_DOMAIN>` 하나로 커버되지 않으므로 사용하지 않습니다.

예시는 [`deploy/production/cloudflare-tunnel.example.yml`](../deploy/production/cloudflare-tunnel.example.yml)을 확인하세요.

## Cloudflare Access 필수 보호면

다음 hostname은 Cloudflare Access self-hosted application으로 보호합니다.

| 보호 대상 | 정책 |
| --- | --- |
| `admin.<BASE_DOMAIN>` | 관리자 IdP group + MFA 권장 |
| `console.<BASE_DOMAIN>` | 관리자/운영자 IdP group + MFA 권장 |
| `*.console.<BASE_DOMAIN>` | 로그인 사용자 + 조직/운영자 정책. 앱 내부 RBAC는 계속 필수 |
| `*.resources.<BASE_DOMAIN>` | 로그인 사용자 + DB/resource 권한 정책. 앱 내부 `db:*` permission은 계속 필수 |

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

- [ ] `cloudflared`가 내부 Ingress Controller만 origin으로 사용한다.
- [ ] Tunnel ingress rule은 `*.apps`, `*.preview`, `*.console`, `*.resources` zone-level wildcard만 사용하고 중간 wildcard를 쓰지 않는다.
- [ ] `admin`, `console`, `*.console`, `*.resources`에 Cloudflare Access 정책이 있다.
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
