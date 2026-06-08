# Preview Deployment

> PR preview는 pull request 단위로 임시 배포 URL을 만들고, PR 종료 시 cleanup workflow로 정리하는 기능입니다.

## URL 패턴

```txt
pr-<number>-<user>--<project>.preview.<BASE_DOMAIN>
```

서비스 실행 URL은 `<user>--<project>.apps.<BASE_DOMAIN>`이고, preview URL도 같은 boundary-safe user--project label 앞에 PR 번호를 붙입니다. Kubernetes workload 이름은 계속 service 단위로 분리합니다.

## 생성 흐름

1. GitHub `pull_request` 이벤트가 들어옵니다.
2. `opened`, `synchronize`, `reopened` 이벤트는 `PREVIEW` deployment를 queue합니다.
3. RAIBITSERVER는 preview deployment record, workflow job, preview URL을 생성합니다.
4. Workflow payload에는 `pr-<number>-<service>` Kubernetes workload plan, namespace, ingress host, cleanup selector가 들어갑니다.
5. Builder/orchestrator가 preview build와 apply를 처리합니다.
6. Dashboard/API/CLI에서 preview 상태와 로그를 조회합니다.

Preview workload는 production workload와 이름이 다릅니다. 예를 들어 service `web`, PR `42`는 `web`이 아니라 `pr-42-web` Deployment/Service/Ingress로 컴파일되어 production rollout과 cleanup을 침범하지 않습니다.

## Cleanup 흐름

- `closed` 이벤트는 preview cleanup job을 queue합니다.
- cleanup은 `pr-<number>-<service>` workload selector로 preview Kubernetes object만 idempotent하게 정리해야 합니다.
- 이미 정리된 preview에 대해 cleanup이 재실행되어도 성공으로 처리합니다.

## 로컬 검증

`pnpm e2e:dry`는 실제 GitHub credential 없이 push fixture, pull request opened/synchronize/reopened fixture, closed cleanup fixture로 preview deployment record, workflow job, URL, workload name 생성을 확인합니다.

## 관련 문서

- [GitHub App 연동](github-app.md)
- [워크플로 작업](workflows.md)
- [Live E2E](live-e2e.md)
