# Live kind / Helm reconciliation gate

> `pnpm e2e:live`는 disposable kind cluster에 실제 Helm chart를 설치해 control-plane의 migration, API, Provisioner, Orchestrator 실행 경계를 검증하는 side-effecting gate입니다.

## 실행 명령

```sh
pnpm e2e:live
```

정확한 이름의 canonical command는 `pnpm e2e:live:helm`이며, `pnpm e2e:live`와 `pnpm dev:e2e:live`는 모두 이 명령을 호출합니다. 기존 TypeScript 실행기인 `scripts/dev-e2e.mjs`는 `pnpm e2e:dry`와 `pnpm dev:e2e:dry` 전용입니다.

`pnpm e2e:live` 자체가 명시적인 side-effecting 명령이므로 별도의 `RAIBITSERVER_EXECUTE=1`은 필요하지 않습니다. 스크립트는 전용 cluster를 만들고 성공·실패와 관계없이 종료 시 삭제합니다. 같은 이름의 cluster가 이미 있으면 덮어쓰지 않고 실패합니다.

## 사전 요구사항

- Bash
- 실행 중인 Docker daemon
- `kind`
- `kubectl`
- Helm
- `curl`
- Go toolchain
- `base64`

스크립트는 필요한 도구를 먼저 확인하고, 하나라도 없으면 이미지 build나 cluster 생성 전에 non-zero로 종료합니다. k3d는 현재 이 게이트의 대체 실행기가 아닙니다.

## 현재 검증 범위

게이트는 다음 증거를 실제 프로세스와 Kubernetes API에서 확인합니다.

1. API, Orchestrator, Provisioner production image를 repository Dockerfile로 build합니다.
2. digest-pinned PostgreSQL image와 platform image를 disposable kind cluster에 load합니다.
3. 실제 Helm chart를 설치하고 Prisma migration hook이 완료됐는지 PostgreSQL에서 확인합니다.
4. API deployment rollout과 `/api/health` 응답을 확인합니다.
5. Provisioner가 PostgreSQL Resource row를 claim해 tenant namespace, PVC, StatefulSet, immutable credential Secret을 만들고 인증된 `SELECT 1` 및 주기 health reconciliation을 완료하는지 확인합니다.
6. credential Secret UID를 저장하고, 같은 이름으로 교체된 Secret을 UID fence가 거부하는지 확인합니다.
7. 실제 PostgreSQL을 대상으로 Builder의 exhausted final-attempt reaper, Orchestrator deletion lease timestamp 정밀도, Provisioner의 교체된 credential Secret UID fence 회귀를 실행합니다.
8. Orchestrator가 `DELETE_REQUESTED` Project를 claim해 tenant namespace와 DB row를 삭제하고 `dryRun=false`, `project_deleted` 로그를 남기는지 확인합니다.

성공 시 마지막 줄에 아래 범위를 명시한 PASS 메시지가 출력됩니다. 이 스크립트는 `.raibitserver-work/live-e2e-report.json`을 만들지 않으며, 종료 코드와 cluster/DB/Kubernetes assertion이 증거입니다.

## 현재 포함하지 않는 범위

This gate does not exercise the Go Builder source build, registry push, tenant workload rollout, service URL HTTP 200, runtime log ingestion, or preview cleanup. DB-connected dispatcher와 DB credential이 없는 disposable BuildKit executor의 분리 경로는 chart/code에 구현됐지만 실제 cluster mTLS·NetworkPolicy 증거는 아직 이 gate의 성공 범위에 포함되지 않습니다. Private GitHub source는 Git clone용 exact-repository short-lived token broker가 연결되기 전까지 fail-closed입니다.

Go Builder의 live 성공 경로는 현재 구조상 외부에서 접근 가능한 non-private OCI registry, registry 인증, fail-closed scanner database, secret-backed signing key와 signature repository를 요구합니다. Builder는 live 모드에서 localhost/private registry, scan 비활성화, signing 비활성화 또는 signing key 누락을 의도적으로 거부합니다. 따라서 kind 내부 임시 registry나 scan/sign stub으로 성공을 꾸미지 않습니다.

In short, the remaining Builder gate needs an external registry, signing infrastructure, and scanner data that this disposable cluster does not provide.

이 누락 범위는 전체 애플리케이션 lifecycle Closed Beta gate의 잔여 조건입니다. 현재 `pnpm e2e:live` 성공은 Helm control-plane reconciliation gate 통과를 뜻하며, source build → registry push → workload deploy → HTTP 200 → runtime log → preview cleanup 전체 통과를 뜻하지 않습니다.

## CI

- `.github/workflows/ci.yml`의 `live-helm-e2e` job이 일반 CI에서 pinned kind/kubectl/Helm/Go 도구로 같은 스크립트를 실행합니다.
- `.github/workflows/live-e2e.yml`은 `workflow_dispatch`로 같은 public command인 `pnpm e2e:live`를 수동 실행합니다.
- 두 job 모두 유한 timeout을 사용합니다.

## 문제 해결

- Docker 연결 실패: Docker daemon이 실행 중인지 확인합니다.
- 기존 cluster 충돌: `kind get clusters`로 확인하거나 `RAIBITSERVER_LIVE_E2E_CLUSTER`에 새 이름을 지정합니다.
- Helm/worker 실패: 실패 시 출력되는 control-plane 및 provider namespace resource/log diagnostics를 확인합니다.
- 로컬에서 kind 실행이 불가능하면 `bash -n scripts/live-helm-e2e.sh`와 정적 회귀 테스트만 통과했다고 전체 live gate 성공으로 간주하지 않습니다.

## 관련 문서

- [로컬 dry E2E](local-e2e.md)
- [검증 명령](verification-commands.md)
- [베타 출시 기준](beta-criteria.md)
- [문제 해결](troubleshooting.md)
