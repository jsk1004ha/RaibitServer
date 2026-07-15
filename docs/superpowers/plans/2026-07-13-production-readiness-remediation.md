# Production Readiness Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Every behavior change follows red-green-refactor.

**Goal:** Close the remaining functional, performance, and security gaps that prevent RAIBITSERVER from exercising its production Go-worker and Helm paths safely.

**Architecture:** Keep the TypeScript control plane as the desired-state authority and make each Go worker claim only its own work, reconcile the matching Kubernetes primitive, and persist observable state transitions. Treat image digests, organization roles, resource credentials, and deletion requests as fail-closed contracts. Keep local verification deterministic and credential-free while adding production-shaped contract tests.

**Tech Stack:** Node.js 24, TypeScript, NestJS, Prisma/PostgreSQL, Next.js, Go, Kubernetes YAML, Helm.

---

### Task 1: Organization-scoped authorization and session revocation

**Files:**
- Modify: `packages/core/src/identity.ts`
- Modify: `packages/core/src/auth.ts`
- Modify: `packages/core/src/persistence.ts`
- Modify: `apps/api/src/auth/rbac.guard.ts`
- Modify: `apps/api/src/modules/auth/auth.controller.ts`
- Modify: `apps/dashboard/lib/request-security.js`
- Test: `tests/security-hardening.test.js`
- Test: `tests/scope-auth.test.js`
- Test: `apps/dashboard/lib/request-security.test.mjs`

- [ ] Add failing tests proving an owner in organization A remains a viewer in organization B, membership role changes revoke existing sessions, logout revokes the current session, and production cannot set the session cookie `Secure=false`.
- [ ] Verify RED with `node --test tests/security-hardening.test.js tests/scope-auth.test.js apps/dashboard/lib/request-security.test.mjs`.
- [ ] Store `rolesByOrganization` in the signed subject, resolve permission against the request target organization, increment `sessionVersion` for membership changes and logout, and force secure production cookies.
- [ ] Verify GREEN with the same focused command and run Core/API/Dashboard typechecks.

Expected subject contract:

```ts
{
  organizationIds: ['org-a', 'org-b'],
  rolesByOrganization: { 'org-a': 'OWNER', 'org-b': 'VIEWER' },
  sessionVersion: 4,
}
```

### Task 2: Builder delivery and supply-chain integrity

**Files:**
- Modify: `services/builder/internal/controlplane/postgres_store.go`
- Modify: `services/builder/internal/worker/builder.go`
- Modify: `services/builder/internal/worker/builder_test.go`
- Modify: `infra/helm/raibitserver/templates/builder-deployment.yaml`
- Modify: `infra/helm/raibitserver/values.yaml`
- Modify: `services/orchestrator/internal/kube/deployment.go`
- Test: `tests/helm-security.test.js`

- [ ] Add failing Go/static tests proving the builder claims only build job types, production always pushes, buildctl exports OCI metadata, a missing real digest fails the job, and mutable production images are rejected.
- [ ] Verify RED with Go package tests when Go is available and Node static contract tests otherwise.
- [ ] Add job-type filtering, registry/push/private Git secret configuration, BuildKit metadata output, registry digest parsing, and fail-closed scan/sign verification commands. Never substitute a deterministic hash for a live digest.
- [ ] Require digest-pinned images in the production orchestrator and configure immutable platform/buildkit image references in Helm values.
- [ ] Verify GREEN with focused Go/static tests and Helm rendering.

Required live outcome:

```text
build -> push -> registry OCI digest -> vulnerability policy -> signature -> IMAGE_READY(repo@sha256:...)
```

### Task 3: Workload-kind parity and deletion reconciliation

**Files:**
- Modify: `services/orchestrator/internal/kube/deployment.go`
- Modify: `services/orchestrator/internal/kube/deployment_test.go`
- Modify: `services/orchestrator/internal/reconciler/reconciler.go`
- Modify: `services/orchestrator/internal/store/postgres_store.go`
- Modify: `packages/core/src/persistence.ts`
- Modify: `prisma/schema.prisma`
- Add migration under: `prisma/migrations/`
- Test: `tests/api-contract-sync.test.js`

- [ ] Add failing tests for `web/private/worker -> Deployment`, `cron -> CronJob`, `job/one-off -> Job`, and project/service/resource deletion remaining in a deleting state until worker cleanup succeeds.
- [ ] Verify RED.
- [ ] Carry service type/schedule/command into the Go store contract, generate the correct Kubernetes kind, use kind-specific readiness, and claim deletion tombstones with `FOR UPDATE SKIP LOCKED`.
- [ ] Replace immediate production hard-delete with `DELETE_REQUESTED -> DELETING -> DELETED`; preserve deterministic local hard-delete only behind local repository behavior.
- [ ] Verify GREEN across Go reconciler tests, Prisma validation, and API contract tests.

### Task 4: Managed resource execution and credential handoff

**Files:**
- Modify: `services/provisioner/internal/reconciler/reconciler.go`
- Add focused provider compiler files under: `services/provisioner/internal/provider/`
- Modify: `services/provisioner/internal/store/postgres_store.go`
- Modify: `packages/core/src/persistence.ts`
- Modify: `packages/core/src/env-injection.ts`
- Test: `services/provisioner/internal/reconciler/reconciler_test.go`
- Test: `tests/db-resource-beta.test.js`

- [ ] Add failing tests proving supported beta engines produce executable Kubernetes primitives, unsupported providers fail explicitly, READY requires provider workload readiness and a real Secret, attach rejects non-READY resources, and delete removes provider objects before final DB deletion.
- [ ] Verify RED.
- [ ] Make the provisioner the concrete controller for the supported local beta providers, generate credentials with `crypto/rand`, create provider-owned Kubernetes Secrets, persist only secret references/public endpoints, and reconcile deletion. Do not store deterministic placeholders as live credentials.
- [ ] Verify GREEN with Go tests and Node resource lifecycle tests.

Supported beta execution matrix:

```text
postgresql/mysql/mariadb/mongodb/redis/valkey -> StatefulSet + Service + Secret
object-storage/vector/queue -> provider-specific Deployment/StatefulSet + Service + Secret
unsupported external provider -> FAILED(provider_not_configured)
```

### Task 5: Reproducible production packaging

**Files:**
- Add: `apps/api/Dockerfile`
- Add: `apps/dashboard/Dockerfile`
- Add Dockerfiles for Go workers under their service directories
- Add Helm templates for API/Dashboard Services, Ingress/TLS, Dashboard Deployment, migration Job, CRDs, probes, disruption budgets, and optional autoscaling
- Modify: `infra/helm/raibitserver/values.yaml`
- Modify: `.github/workflows/ci.yml`
- Test: `tests/helm-security.test.js`

- [ ] Add failing static/render tests for all product images, mandatory existingSecret keys, `NODE_ENV=production`, Service/Ingress/TLS, migrations, probes, CRDs, non-root security, and immutable image references.
- [ ] Verify RED.
- [ ] Add multi-stage product Dockerfiles and complete the Helm release without embedding credentials.
- [ ] Verify GREEN with Dockerfile structure checks, Helm lint/template, and CI YAML parsing.

### Task 6: Queue, query, quota, and SSE scalability

**Files:**
- Modify: `prisma/schema.prisma`
- Add migration under: `prisma/migrations/`
- Modify: `packages/core/src/persistence.ts`
- Modify: `apps/api/src/raibitserver.service.ts`
- Modify: `apps/api/src/modules/deployments/deployments.controller.ts`
- Modify Go worker mains and PostgreSQL stores
- Test: `tests/performance-boundaries.test.js`

- [ ] Add failing tests for claim-query indexes, deployment keyset pagination, a single quota snapshot per request, cursor deltas using `(timestamp,id)`, bounded SSE connection lifetime/backpressure, queue draining before idle backoff, and configured DB pool limits.
- [ ] Verify RED.
- [ ] Add composite/partial indexes, DB count/aggregate quota queries, bounded pagination, delta-only SSE payloads, bounded drain loops, and pool configuration.
- [ ] Verify GREEN with performance contracts, typechecks, and Go tests.

### Task 7: Observability and production-path verification

**Files:**
- Implement: `services/log-ingester/cmd/log-ingester/main.go`
- Implement: `services/metrics-ingester/cmd/metrics-ingester/main.go`
- Modify: `openapi/raibitserver.yaml`
- Modify: `scripts/dev-e2e.mjs`
- Modify: `.github/workflows/ci.yml`
- Test: `tests/api-contract-sync.test.js`
- Test: `tests/e2e-mode.test.js`

- [ ] Add failing tests proving log/metrics ingesters poll or watch Kubernetes and persist bounded data, OpenAPI documents new health/snapshot/overview/pagination routes, and live E2E deploys the actual Helm release and waits for Go-worker state transitions.
- [ ] Verify RED.
- [ ] Implement bounded ingestion/retention, synchronize OpenAPI, and make the live scenario exercise PostgreSQL + Helm + builder + orchestrator + provisioner rather than the TypeScript direct executor.
- [ ] Verify GREEN with contract tests; live external execution remains an explicit credential/tool-dependent gate.

### Final verification

- [ ] Run `node --test` with Node 24 and require zero failures.
- [ ] Run Core/API/CLI/Dashboard typechecks and Dashboard production build.
- [ ] Run Prisma validate/generate and dependency audit.
- [ ] Run repository structure and required CLI smoke commands.
- [ ] Run `go test ./...`, `go vet ./...`, and `go build ./...` for every Go service when Go is available.
- [ ] Run Helm lint/template and inspect rendered security fields.
- [ ] Run `git diff --check` and complete a final spec review followed by a code-quality review.

No commits are created unless the user explicitly requests them; the Lore commit protocol applies if that authorization is later given.
