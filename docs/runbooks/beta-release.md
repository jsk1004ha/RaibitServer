# Beta release runbook

## Gate A candidate

Before launching, confirm that the task-28 commit is the clean local `HEAD`, its one open A3 pull
request targets the repository default branch, and the approved input snapshot is available at
`<attempt-root>/inputs/approved-draft-input-v1.md`. Provisioning the protected environment,
reviewers, selected `raibit-gate-a-*` TAG rule, immutable tag ruleset, runner, Kubernetes access,
operator selectors, and referenced Secrets is an external maintainer prerequisite.

Run from the candidate checkout:

```sh
node scripts/run-gate-a.mjs \
  --repo jsk1004ha/RaibitServer \
  --scenario happy \
  --attempt-dir <attempt-root>/task-28-workflow
```

The launcher verifies snapshot/contract parity before mutation, derives `HEAD`, finds exactly one
open PR at that SHA and default base, checks the authenticated release actor and read-only policy,
rejects local or remote tag collisions, then pushes one fresh lightweight tag without force. It
discovers the workflow through complete paginated snapshots for at most five minutes and freezes
one attempt-one run ID. It watches for at most the remaining four-hour budget. Run metadata and the
named `production-evidence` artifact are fetched in the finalization path even when the watch exits
nonzero. Candidate tags remain immutable audit references.

Exercise the secret-free negative route with a different UUID and output directory:

```sh
node scripts/run-gate-a.mjs \
  --repo jsk1004ha/RaibitServer \
  --scenario missing-secret \
  --attempt-dir <attempt-root>/task-28-negative
```

Success of this negative assertion is still an ineligible, nonzero Gate A result. Never label it a
passing release check.

Immediately before merging A3, reread the PR and default-branch base. Candidate SHA, head SHA, and
base SHA must equal the launcher receipt. If any changed, rebuild and launch a fresh candidate.
Merge with a merge commit that preserves the approved candidate as a parent; do not squash or
rebase it after evidence collection.

## Final Gate B preparation

Gate B is allowed only after B3 is merged. The operator must separately provision a selected
`raibit-gate-b-*` environment TAG rule and matching immutable tag ruleset. The Gate B tag SHA must
equal the current default-branch head; the workflow rejects a side-branch or merely self-labelled
tag. Use a new UUID, empty evidence directory, and fresh CI run. The protected job selects
`profile=final`; it must regenerate lifecycle and custom-domain evidence under one identity and
must not copy Gate A or earlier domain fragments.

Task 51's required final-profile CLI invocation is:

```sh
RAIBITSERVER_PRODUCTION_EVIDENCE=1 bash scripts/production-evidence-e2e.sh \
  --profile final --attempt-dir <attempt-root>/gate-b
```

The corresponding controlled failure contract is:

```sh
RAIBITSERVER_PRODUCTION_EVIDENCE=1 bash scripts/production-evidence-e2e.sh \
  --profile final --attempt-dir <attempt-root>/gate-b-fault --fault domain-tls
```

Task 51 performs these credentialed runs after merge. Preparing the workflow does not create a
Gate B receipt or establish Beta Ready.

## Failure handling

Treat unavailable policy, authorization, approvals, credentials, environment, runner, provider,
artifact, or timeout as `NOT_RUN` and blocked. Preserve redacted artifacts and cleanup receipts,
record ownership and rollback/restore steps, and repair the prerequisite before creating a fresh
tag and run. Never reuse a run ID, evidence directory, tag nonce, or accepted receipt.
