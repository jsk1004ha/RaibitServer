# 로컬 E2E

> `pnpm e2e:dry`는 실제 cloud, registry, Kubernetes, GitHub secret 없이 RAIBITSERVER의 핵심 계약을 검증하는 기본 proof입니다.

## 목적

로컬 개발자와 CI가 외부 부작용 없이 control-plane, API, quota, DB console, preview, worker dry-run artifact를 확인할 수 있게 합니다.

## 실행 명령

```sh
pnpm install --frozen-lockfile
pnpm dev:up
pnpm dev:seed
pnpm e2e:dry
pnpm dev:down
```

증거 파일은 `.raibitserver-work/e2e-report.json`에 저장됩니다.

## 검증하는 것

`pnpm e2e:dry`는 다음 흐름을 확인합니다.

1. API handler와 example app 시작
2. `NON_CLUB` pending 사용자 차단
3. 관리자 승인과 quota 설정
4. project/service/SQLite resource 생성
5. SQLite DB console query 실행
6. deployment와 PR preview deployment queue 생성
7. build/runtime log와 deployment event 저장
8. build, Kubernetes, provisioning dry-run artifact compile

## side effect 경계

Dry mode는 다음 작업을 실제로 수행하지 않습니다.

- Docker build/push
- registry push
- Kubernetes cluster 생성 또는 `kubectl apply`
- cloud/provider resource 생성
- 실제 GitHub webhook/network 호출

실제 local cluster smoke test가 필요할 때만 [Live E2E](live-e2e.md)를 사용합니다.

## 호환 alias

| 명령 | 의미 |
| --- | --- |
| `pnpm dev-up` | `pnpm dev:up` |
| `pnpm dev-e2e` | `pnpm dev:e2e` dry path |
| `pnpm dev-down` | `pnpm dev:down` |
| `pnpm dev:e2e:dry` | deterministic dry proof |
| `pnpm dev:e2e:live` | `pnpm e2e:live:helm` kind/Helm reconciliation gate alias |

## 실패 시 확인할 것

- Node.js 24+와 pnpm 11.1.2 사용 여부
- `.raibitserver-work/e2e-report.json`의 failed step
- `.raibitserver-work/local-stack.json`의 로컬 도구 감지 결과
- [문제 해결 문서](troubleshooting.md)

## 관련 문서

- [Live E2E](live-e2e.md)
- [검증 명령](verification-commands.md)
- [문제 해결](troubleshooting.md)
