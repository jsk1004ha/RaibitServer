# Metrics ingester LOCAL contract

The worker treats metrics labels only as lookup hints. It resolves the organization,
project, service and deployment through PostgreSQL, requires snapshot version 1,
and verifies the current Pod, namespace and exact controller chain via authenticated
Kubernetes GETs. Current DEPLOYING, READY and still-owned FAILED diagnostics are
allowed; cancelled/deleting/cleanup-requested identities are rejected. A newer
preview alone does not retire a still-owned previous preview.

Container name, image, command, args and canonical environment/Secret references
must match the immutable snapshot and controller-injected release identity. No
Secret API or secret-value lookup is used. Parent-first database locks recheck the
authority after Kubernetes reads; no database transaction spans network requests.

The v1 source key remains unprefixed SHA256 of `podUid NUL namespace NUL podName NUL
container NUL metric NUL RFC3339Nano(timestamp)`. The existing `IngestionCursor`
table stores disjoint `metrics:<podUid>:<container>:<cpu|memory>` nanosecond
watermarks. New records and watermark updates commit atomically. Replay or an
older current snapshot inserts nothing, and duplicate rows do not consume the
accepted-new-row budget. This is current-snapshot ingestion, not a promise of
historical metrics recovery.

Defaults remain 500 Pods / 10000 accepted samples / 20 seconds per run, with a
16 MiB cumulative HTTP byte budget and 1 MiB per HTTP object. Discovery and owner
reads share the deadline. Samples are finite nonnegative CPU cores or memory
bytes, no earlier than Pod creation, no more than 30 seconds in the future, and
within the configured retention (at most 30 days). Retention deletes at most
10000 rows/cursors per call and only cleans this worker's `metrics:` cursor
prefix; locked refreshed cursors are skipped.

Fixed-cardinality stdout observations report kind=metric, observation presence,
lag at successful persistence, and age since the process last observed successful
persistence (`-1` means never). Error output uses bounded reason codes, never raw
Kubernetes response bodies, DSNs or workload dimensions. Last-success state is
process-local and deliberately absent after a restart until a new observation.

Local qualification (no cluster, registry, Docker or cloud credentials):

```sh
bash services/metrics-ingester/test-local.sh ABSOLUTE_EVIDENCE_DIRECTORY ABSOLUTE_SHARED_FIXTURE_DIRECTORY
```

The runner uses a new UUID-named PostgreSQL database through the local peer socket,
applies the repository's existing migrations 1–13, runs native build/vet/race
tests and real authenticated HTTP/process scenarios, captures hashes and cleans
up its database. It never changes database roles, passwords or server settings.
The shared fixture directory is supplied by the composition owner; fixture bytes
are consumed read-only.
