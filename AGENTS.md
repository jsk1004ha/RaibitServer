# AGENTS.md — RAIBITSERVER

## Project intent
This repository implements **RAIBITSERVER**: a container-first PaaS + DBaaS + project operations platform for clubs, schools, and small teams.

The target architecture is a **TypeScript-centered monorepo plus Go infrastructure controllers**:

```txt
Product/dashboard/general API      -> TypeScript
Kubernetes/build/runtime control   -> Go
Infrastructure definition          -> Terraform + Helm/Kubernetes manifests
```

## Product invariants
- User workloads always resolve to a container image and Kubernetes-style runtime desired state.
- User Dockerfiles take priority over framework detection/buildpacks/custom defaults.
- Generated tenant URLs use the organization slug as the flat single-label route tenant under the base domain: `apps--<organization>--<project>[--<non-web-service>].raibitserver.app`, `preview--pr-<number>--<organization>--<project>[--<non-web-service>].raibitserver.app`, `console--<organization>--<project>-<service>.raibitserver.app`, and `resources--<organization>--<project>-<resource>.raibitserver.app`.
- Projects are multi-service: web, private service, worker, cron job, one-off job, and managed resources.
- Managed databases/storage/cache/vector/queue are catalog resources, not raw compose containers.
- The API stores desired state; Go infrastructure services reconcile actual state.
- Generated runtime artifacts must use safe defaults: namespace isolation, NetworkPolicy, non-root containers, no privileged/hostPath, resource limits, secret refs, and optional autoscaling.
- Local verification must not require real Kubernetes, registry, database, or cloud credentials.

## Codebase boundaries
- `apps/dashboard`: Next.js product dashboard.
- `apps/api`: NestJS Control Plane API. It handles auth/RBAC/quota/audit and writes desired state to the control-plane DB.
- `apps/cli`: RAIBITSERVER CLI.
- `packages/core`: TypeScript deterministic core for build plans, compose import, resource catalog, domain routing, manifest compilation, security/RBAC/quota, API helpers.
- `packages/*`: shared UI/config/schemas/api-client/sdk.
- `services/orchestrator`: Go Kubernetes reconciler.
- `services/builder`: Go source/image build worker.
- `services/provisioner`: Go DB/storage/resource provider reconciler.
- `infra/*`: Terraform, Helm, CRDs, raw manifests.
- `src/*`: thin TypeScript entrypoints plus JS compatibility wrappers for local commands; core logic must live in `packages/core`.

## Development rules
- Keep behavior deterministic and testable locally.
- Use built-in Node.js APIs in `packages/core` and `src/` unless a dependency is explicitly justified.
- Keep TypeScript product code and Go infra execution code separated by desired-state contracts.
- Do not put long-running build/Kubernetes reconciliation into the dashboard or NestJS request path.
- Never commit real secrets. Mask secret-looking values in logs/API/CLI outputs.
- Prefer small modules and explicit contracts over hidden abstractions.

## Verification
Run before claiming completion:

```sh
npm test
node scripts/check-structure.js
node src/cli.js validate examples/project.json
node src/cli.js manifest examples/project.json >/tmp/raibitserver-manifest.json
node src/cli.js compose examples/docker-compose.yml >/tmp/raibitserver-compose-plan.json
```

If Go is installed, also run syntax/build checks for `services/*`; otherwise report that Go verification was unavailable.

## Documentation
Keep `README.md` aligned with implemented behavior: RAIBITSERVER naming, TypeScript monorepo, Go infra services, API/CLI usage, build/run/test, limitations, and production next steps.
