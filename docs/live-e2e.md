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

This gate does not exercise the Go Builder source build, registry push, tenant workload rollout, service URL HTTP 200, runtime log ingestion, preview cleanup, or external custom-domain DNS/TLS/HTTPS. DB-connected dispatcher와 DB credential이 없는 disposable BuildKit executor의 분리 경로는 chart/code에 구현됐지만 실제 cluster mTLS·NetworkPolicy 증거는 아직 이 gate의 성공 범위에 포함되지 않습니다. Private GitHub source는 Git clone용 exact-repository short-lived token broker가 연결되기 전까지 fail-closed입니다.

Go Builder의 live 성공 경로는 현재 구조상 외부에서 접근 가능한 non-private OCI registry, registry 인증, fail-closed scanner database, secret-backed signing key와 signature repository를 요구합니다. Builder는 live 모드에서 localhost/private registry, scan 비활성화, signing 비활성화 또는 signing key 누락을 의도적으로 거부합니다. 따라서 kind 내부 임시 registry나 scan/sign stub으로 성공을 꾸미지 않습니다.

In short, the remaining Builder gate needs an external registry, signing infrastructure, and scanner data that this disposable cluster does not provide.

The live builder now verifies the same digest after signing with `cosign verify
--new-bundle-format=false --check-claims=true --key <public-key-file> <image@digest>`
before atomic IMAGE_READY publication. `RAIBITSERVER_VERIFICATION_KEY` must name
an independent absolute public-key path, never the private signing key. Sign-only
success is not verification. Verification failure, cancellation, deletion or lease
loss prevents publication. Supply-chain results distinguish `signing: signed`
from `verification: verified`; preauthorized imported images are verified without
being signed as platform output. Scanner policy always includes HIGH and CRITICAL,
uses the vulnerability scanner, and explicitly includes unfixed vulnerabilities.
Clone/source preparation is capped at 15 minutes; combined build/push and each
push, scan, sign and verify command are capped at 10 minutes, with tighter configured
timeouts and parent deadlines preserved. The existing default remains 600 seconds.

For Helm, `builder.verification.existingSecret` and `builder.verification.key`
select a read-only public-key projection in the release namespace. If omitted,
the builder reuses `security.imageVerification.trustRoot.existingSecret/key` only
when `trustRoot.namespace` equals the release namespace. A foreign admission trust
namespace requires an explicitly provisioned local projection; the chart does not
copy Secrets. Operators must put the same approved public trust key in both
locations. The chart does not prove their contents equal, derive a key from the
signing key, or change admission/preflight authority or the frozen operator-input
contract. Local command-fixture tests prove worker gating, not actual signature,
registry or Kubernetes execution. The command flags follow the
[pinned Cosign v3.0.6 options](https://github.com/sigstore/cosign/blob/v3.0.6/cmd/cosign/cli/options/verify.go)
and [Sigstore verification contract](https://docs.sigstore.dev/cosign/verifying/verify/).

이 누락 범위는 전체 애플리케이션 lifecycle Closed Beta gate의 잔여 조건입니다. 현재 `pnpm e2e:live` 성공은 Helm control-plane reconciliation gate 통과를 뜻하며, source build → registry push → workload deploy → HTTP 200 → runtime log → preview cleanup 전체 통과를 뜻하지 않습니다.

## Production evidence contract (L1 / L2 / L3)

`raibitserver.production-evidence/v1` keeps local (`local`, L1), disposable kind
(`cluster`, L2), and credentialed (`lifecycle`, `resources`, `operations`, L3)
observations separate. `train-a` requires all five; `final` additionally requires
`domains` L3. Neither legacy script creates L3 fragments. Every observation must
bind the same UUIDv4 run, environment fingerprint, source commit, migration,
operator-input fingerprint, approved input digest, operator-contract digest and
tenant identifiers. PASS assertions and cleanup are mandatory. Four-hour expiry,
future observations, mixed identities, reused directories/fragments, missing or
modified artifacts, raw secrets, FAIL and NOT_RUN all fail closed.

```sh
node scripts/production-evidence/preflight.mjs --contract
node scripts/verify-production-evidence.mjs --profile train-a /run/UUID/manifest.json
node scripts/verify-production-evidence.mjs --profile final /run/UUID/manifest.json
node scripts/verify-production-evidence.mjs --fragment resources /run/UUID/manifest.json
```

`--fragment resources|domains` and `component` profile can succeed only as
component validation; the JSON result always has `releaseEligible=false`.
An eligible full manifest is a contract decision, not proof that this repository
has already completed a credentialed release. No L3 execution is claimed by the
tests. Artifact producers must be trusted and the evidence directory access
controlled; hashes detect drift, not deliberate fabrication by its owner.

Train A Gate A는 그때의 정확한 후보 SHA와 credentialed lifecycle 증거에만 묶이며
Train B 구현의 개발 선행 조건일 뿐입니다. 최종 Gate B는 B3가 merge된 뒤 그 최종 SHA에서
새 run ID와 빈 evidence directory로 `final` profile을 다시 실행해야 생성됩니다. Gate A나
component/domain receipt를 Gate B 필드에 복사할 수 없으며, Gate B가 아직 없거나 하나라도
`NOT_RUN`이면 현재 문서·로컬 테스트 상태를 Beta Ready로 표시하지 않습니다.

The committed `test-fixtures/contracts/operator-inputs-v1.json` contains exactly
the eight approved non-secret selector names and typed reference bindings, never
selector values or Secret contents. Existing Helm bindings use
`kind=helm-existingSecret`, `namespace`, `existingSecret`, and `keys`. Planned
scanner/backup worker bindings use `kind=worker-secretKeyRef`, `namespace`, and
`secretKeyRef={name,key,optional:false}`; they are **not existing Helm wiring**.
Unbound/missing credentials yield NOT_RUN. `preflight.mjs` exports the same parser
used locally and in CI. A metadata-only adapter may check Secret UID and key
availability; no Secret values are returned. The scaffold performs no provider
operations and cannot produce live PASS. Future resource/domain runners own
their actual probes and cleanup, not a generic mega-script.

Runtime needs only the committed contract, not `.omo` or the source draft.
Offline approval parity (before any Secret adapter call) is explicit:

```sh
node scripts/production-evidence/preflight.mjs --approved-input /approved/approved-draft-input-v1.md
```

Both Gate A and Gate B bind the literal approved snapshot SHA-256
`0EC3728F53E872561F78D2A4849EBB11C037FF65529439AD5E55DAD49EB9AEE2`.
Digest checking occurs on bytes before decoding; no mutable-draft fallback exists.

The committed happy sample is timestamped component-only fixture evidence:

```sh
node scripts/verify-production-evidence.mjs tests/fixtures/production-evidence/pass-v1/manifest.json
node scripts/verify-production-evidence.mjs tests/fixtures/production-evidence/fail-identity-mismatch/manifest.json
```

The happy sample intentionally expires after four hours and then exits 1 with
`stale_state`; the identity-mismatch sample exits 1 with only `identity_mismatch`.
Create a fresh sample in an **existing, operator-owned scratch parent** (the command
creates a new UUID child and refuses reuse), then verify the printed manifest path:

```sh
node scripts/production-evidence/run-component.mjs --sample resources /owned/scratch
node scripts/verify-production-evidence.mjs /owned/scratch/PRINTED-UUID/manifest.json
```

To repeat the exact committed-sample happy command after expiry, replace only
`pass-v1/manifest.json` and `pass-v1/assertions.json` with that generated pair and
record the regeneration separately. Never relabel it as live evidence. Unit tests
generate fresh specimens independently; no path exception or fixture clock bypass
exists in the verifier. Test scratch directories are removed in test cleanup.

## Existing kind CI

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
