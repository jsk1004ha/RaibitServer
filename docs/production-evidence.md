# Production evidence

RAIBITSERVER separates local checks from credentialed release evidence. `pnpm e2e:live` remains the bounded, credential-free kind/Helm gate. It is not L3 production evidence and cannot make a release eligible.

## Protected workflow

`.github/workflows/production-evidence.yml` runs only from immutable release tags. Gate A uses
`raibit-gate-a-<full-candidate-sha>-<happy|missing-secret>-<uuid>` and the run title
`Gate A | <tag>`. The later final profile uses a fresh
`raibit-gate-b-<full-merged-b3-sha>-<uuid>` tag and `Gate B | <tag>`; it cannot reuse a Gate A run, receipt, tag, or evidence directory.

The `preflight` job has no environment and no `secrets` expression. It validates the tag, commit,
push event, committed operator contract, workflow blob, and attempt-one CI identity. The
`missing-secret` route uses the committed fixture with only the signing Secret reference absent.
Its expected result is a nonzero job with `missing_secret_ref`, `NOT_RUN`, `testOnly=true`,
`releaseEligible=false`, and a cleanup receipt showing zero resources created or remaining.
The protected live job is skipped for that route.

Only the happy route attaches `raibit-production-evidence`. The environment supplies the approved
input bytes, kubeconfig, normalized Secret-reference metadata, and the eight non-secret selectors.
The runner validates referenced Kubernetes Secrets by metadata and required key names; it does not
copy their data into evidence. The existing Helm configuration mounts the approved signing Secret
at `/var/run/secrets/raibitserver/signing/cosign.key` and the trust Secret at
`/var/run/secrets/raibitserver/verification/cosign.pub`. `COSIGN_PASSWORD` belongs only to the
signer child process. Missing bindings or credentials produce `NOT_RUN`; there is no fallback key.

The environment must have a selected TAG deployment rule for the invoked gate. Gate A requires
`raibit-gate-a-*`. Gate B requires a separately provisioned `raibit-gate-b-*` rule; the workflow
does not widen Gate A policy. Repository tag rulesets must restrict creation to the approved release
identity and forbid update and deletion. The launcher only reads these settings and never modifies
repository or environment policy.

## CI invocation receipt

`scripts/production-evidence/lib/ci-invocation.mjs` records the rich
`raibitserver.ci-invocation/v1` receipt. Its nested `execution` projection has exactly:

```json
{
  "repository": "owner/repository",
  "ref": "refs/tags/raibit-gate-a-...",
  "sourceCommitSha": "40-lowercase-hex",
  "runId": "decimal-string",
  "runAttempt": 1,
  "workflowRef": "owner/repository/.github/workflows/production-evidence.yml@refs/tags/...",
  "workflowSha": "40-lowercase-hex",
  "event": "push"
}
```

Historical verification uses `parseCiExecutionContext(storedReceipt.execution)`. It must not read
the verifier process's current GitHub environment. Rich verification additionally binds the tag
nonce, candidate SHA, workflow path/blob SHA, run ID, attempt, and creation time. Distinct final
runs require distinct independently frozen CI receipts.

## Evidence interpretation

The workflow uploads redacted artifacts even after a failed watch or live run. Downloadable output
is diagnostic until the evidence verifier accepts the exact CI invocation, profile, immutable
identity, fragment set, cleanup, and manifest. `FAIL`, `NOT_RUN`, fixtures, test-only results,
missing cleanup, reruns, or stale/mismatched identities never authorize Beta Ready.

No production run, tag push, credential read, signature, Kubernetes operation, or GitHub policy
change is performed by local fixture tests.
