# 검증 명령 매트릭스

> 변경을 완료했다고 말하기 전에, 변경 영역에 맞는 가장 작은 검증부터 실행하고 결과를 확인합니다.

## 기본 로컬 acceptance

Production-risk hardening 또는 공통 코드 변경 후 우선 실행합니다. 이 명령들은 cloud credential, live Kubernetes cluster, GitHub secret을 요구하지 않습니다.

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm prisma:validate
node src/cli.js validate examples/project.json
node src/cli.js manifest examples/project.json >/tmp/raibitserver-manifest.json
node src/cli.js compose examples/docker-compose.yml >/tmp/raibitserver-compose-plan.json
node src/cli.js provision-plan examples/project.json >/tmp/raibitserver-provision-plan.json
node src/cli.js k8s-apply examples/project.json >/tmp/raibitserver-k8s-apply.json
pnpm e2e:dry
```

Go가 설치되어 있으면 CI와 같은 loop를 실행합니다.

```sh
for dir in services/builder services/orchestrator services/provisioner services/log-ingester services/metrics-ingester; do
  test -f "$dir/go.mod"
  (cd "$dir" && go test ./... && go build ./...)
done
```

## 변경 영역별 집중 검증

### Go builder/orchestrator/provisioner workers

```sh
node --test tests/go-builder-worker.test.js tests/go-orchestrator-reconciler.test.js
for dir in services/builder services/orchestrator services/provisioner; do
  (cd "$dir" && go test ./... && go build ./...)
done
```

Production control-plane store처럼 Go package가 바뀌면 변경 package 옆에 package-level test를 추가합니다.

### Live E2E bootstrap과 CI workflow contract

```sh
node --test tests/e2e-mode.test.js tests/local-e2e.test.js tests/live-helm-e2e.test.js tests/ci-cli-smoke.test.js
pnpm e2e:dry
```

Docker/kind/kubectl/Helm/Go side effect를 의도할 때만 live Helm reconciliation gate를 실행합니다. 스크립트가 disposable cluster의 생성과 정리를 담당하므로 `pnpm dev:up`/`pnpm dev:down`은 필요하지 않습니다.

```sh
pnpm e2e:live
```

이 명령은 API migration/health, 관리형 PostgreSQL Provisioner, Orchestrator deletion을 검증합니다. Go Builder source build/registry push/signing, tenant workload HTTP 200, runtime log, preview cleanup은 별도 전체 앱 lifecycle evidence가 필요합니다.

### TypeScript control plane, API, auth, GitHub, workflow jobs

```sh
node --test \
  tests/project-service-deployment-builder-beta.test.js \
  tests/api-store.test.js \
  tests/api-contract-sync.test.js \
  tests/api-contract-github-resource-console.test.js \
  tests/domain-router.test.js \
  tests/db-resource-beta.test.js \
  tests/auth-env-github.test.js \
  tests/scope-auth.test.js \
  tests/workflow-jobs.test.js
node --test tests/go-orchestrator-reconciler.test.js
pnpm --filter @raibitserver/api typecheck
pnpm --filter @raibitserver/api test
```

### Build, manifest, resource provider, security policy

```sh
node --test \
  tests/build-strategy.test.js \
  tests/manifest-compiler.test.js \
  tests/compose-importer.test.js \
  tests/domain-router.test.js \
  tests/resource-providers.test.js \
  tests/db-resource-beta.test.js \
  tests/security-rbac-quota.test.js
pnpm --filter @raibitserver/core test
pnpm --filter @raibitserver/core typecheck
```

### CLI, Prisma, OpenAPI, infrastructure manifests

```sh
node --test tests/ci-cli-smoke.test.js
pnpm prisma:validate
pnpm prisma:generate
node -e "import('yaml').then(({default:YAML})=>{const fs=require('node:fs'); YAML.parse(fs.readFileSync('openapi/raibitserver.yaml','utf8')); for (const f of ['infra/k8s/appservice-crd.yaml','infra/operators/manageddatabase-crd.yaml','infra/operators/managedresources-crd.yaml']) YAML.parse(fs.readFileSync(f,'utf8')); console.log('yaml-ok')})"
```

Helm이 설치되어 있으면 추가로 실행합니다.

```sh
helm template raibitserver infra/helm/raibitserver >/tmp/raibitserver-helm.yaml
```

### Dashboard와 app package

```sh
pnpm --filter @raibitserver/dashboard typecheck
pnpm --filter @raibitserver/dashboard lint
pnpm --filter @raibitserver/cli typecheck
```

## Known coverage gaps

- `pnpm lint`는 현재 `git diff --check`와 `node scripts/check-structure.js`를 실행하며, 모든 package의 full ESLint가 아닙니다.
- root `pnpm typecheck`는 `packages/core`, `apps/api`, `apps/cli`, `apps/dashboard`를 중심으로 검증합니다.
- `pnpm e2e:live`는 CI의 bounded kind/Helm job에도 포함되지만 전체 앱 lifecycle gate는 아닙니다. 로컬 기본 proof는 계속 `pnpm e2e:dry`입니다.
- Go service validation은 root script가 아니라 수동/CI loop입니다.
