# 보안 정책

> RAIBITSERVER는 사용자 workload와 secret, DB console, 로그가 기본적으로 안전한 경계 안에서 동작하도록 제한합니다.

## 목적

이 문서는 runtime workload 정책, secret 저장/마스킹, DB console guard, 로컬 검증 범위를 설명합니다.

## Workload security

Runtime workload policy는 다음을 차단합니다.

- privileged container
- root user 실행
- hostPath
- hostNetwork
- hostPID/hostIPC escape
- capability 추가
- writable non-`/tmp` mount
- service account token automount
- `RuntimeDefault`가 아닌 seccomp
- hard resource safety cap 누락

생성 manifest는 다음을 포함합니다.

- restricted pod/container security context
- NetworkPolicy
- resource requests/limits
- dropped capabilities
- no service account token mount
- PodDisruptionBudget 지원
- HPA 지원

## Dashboard session cookies

- 로그인 세션은 `__Host-raibitserver_session`에만 저장합니다. 모든 환경에서 `Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax`를 사용하며 `Domain`을 지정하지 않습니다. 세션의 `Secure` 속성은 설정으로 끌 수 없습니다.
- 구형 `raibitserver_session`은 인증에 사용하거나 새 세션으로 자동 전환하지 않습니다. 방문·로그인·로그아웃 시 구형 host-only 쿠키를 명시적으로 만료시키므로 적용 후 다시 로그인해야 합니다. 다른 도메인/경로에 남은 구형 쿠키도 인증에는 무시됩니다.
- 동일한 새 세션 이름이 중복되거나 값이 잘못된 요청은 인증하지 않습니다. tenant sibling이 부모 `Domain`으로 새 이름을 주입하는 것은 브라우저의 `__Host-` 규칙으로 차단됩니다.
- 브라우저 인증 개발 환경도 HTTPS를 사용하세요. HTTP 전용 일반 개발 도메인에서 접두사를 제거하거나 구형 쿠키로 돌아가는 fallback은 없습니다.

## Secret security

- `.env` upload는 일반 값과 secret-looking key를 분리합니다.
- Secret 값은 `ENCRYPTION_KEY` 또는 `RAIBITSERVER_SECRET_ENCRYPTION_KEY`로 AES-256-GCM sealing합니다.
- 로컬 개발 fallback은 dev/test 전용입니다.
- API snapshot과 log는 secret-looking key/value를 masking합니다.
- CLI auth-token command는 token 발급 목적상 예외이며, 그 외 출력은 masking합니다.

### 여러 줄 로그와 복구 작업 정리

- Go 수집기와 TypeScript 저장 경로는 소스별 PEM·따옴표 상태를 이어서 적용합니다. PostgreSQL에서는 마스킹된 로그와 비밀값을 포함하지 않는 파서 상태를 같은 트랜잭션으로 저장합니다.
- 이전 상태가 없거나 수집 위치와 맞지 않거나 입력이 잘려 상태를 복원할 수 없으면 해당 소스 내용을 보수적으로 가립니다. 따라서 일부 로그가 `****`만 표시될 수 있습니다. 마스킹을 끄거나 원문을 출력하는 방식으로 해결하지 마세요.
- URL의 비밀 쿼리값은 쉼표·세미콜론 뒤까지 가립니다. `--key`, `-key`, 접두·접미사가 붙은 비밀 환경변수도 같은 보호 대상입니다.
- 복구 작업의 DELETE 접수는 실행 종료를 뜻하지 않습니다. Job과 해당 UID의 Pod가 사라졌음을 확인하기 전에는 네트워크 정책, 자격증명 스냅샷, 복구 권한을 해제하지 않습니다. 삭제나 확인에 실패하면 보호 장치를 유지하고 오류를 반환합니다.

## DB console guard

- destructive SQL은 explicit confirmation이 필요합니다.
- viewer role은 read-only query만 실행할 수 있습니다.
- provider-owned connection만 사용하고 request-supplied URL은 무시합니다.
- SQLite는 filesystem-opening statement를 실행 전에 차단합니다.

## Edge / Tunnel security

- Cloudflare Tunnel은 origin IP 은닉과 edge policy 적용 수단이며, RAIBITSERVER의 JWT/RBAC/quota/audit/tenant isolation을 대체하지 않습니다.
- `*.apps`, `*.preview`, `*.console`, `*.resources` tunnel wildcard는 내부 Kubernetes Ingress Controller로만 보내고 Kubernetes Ingress가 Host 기반 라우팅을 담당합니다.
- `admin`, `console`, `*.console`, `*.resources`는 Dashboard의 HttpOnly JWT 세션과 앱 내부 RBAC로 보호하고, Cloudflare Access/MFA를 추가 방어선으로 사용합니다.
- `/api/*`, SSE stream, GitHub webhook은 cache bypass를 적용하고, webhook은 HMAC 검증을 계속 앱에서 수행합니다.
- DB/TCP/registry/Kubernetes API/NodePort는 public tunnel에 열지 않고, 운영자 접근은 WARP/private network/SSH bastion으로 분리합니다.
- origin bypass를 막기 위해 production firewall은 직접 inbound를 닫고 `cloudflared` outbound와 내부 cluster traffic만 허용합니다.

## 검증

```sh
pnpm test
node --test tests/security-rbac-quota.test.js
pnpm e2e:dry
```

변경 범위가 manifest compiler나 resource provider에 닿으면 [검증 명령 매트릭스](verification-commands.md)의 해당 섹션도 실행합니다.

## 관련 문서

- [승인과 쿼터](quota.md)
- [Cloudflare Tunnel 운영](cloudflare-tunnel.md)
- [DB Console](db-console.md)
- [리소스 프로비저닝](provisioning.md)
