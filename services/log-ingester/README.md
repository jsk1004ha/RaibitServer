# Runtime log ingestion

Correlated ingestion requires a version-1 immutable deployment snapshot. The
database resolves Organization → Project → Service → Deployment authority and
the authenticated Kubernetes API verifies the current namespace, Pod UID and
controller chain, expected labels, image, command/args and environment/Secret
reference fingerprint. Secret objects are never read. DEPLOYING, READY and
still-owned FAILED diagnostics are accepted; deleted, cancelled, cleanup and
unverifiable legacy deployments are rejected. A newer preview candidate does
not by itself retire an existing unique preview workload.

The existing v1 hash is unchanged: SHA256(Pod UID, NUL, container, NUL,
RFC3339Nano timestamp, NUL, original source line). The existing adapter's 64KiB
source-line normalization remains hash-compatible; masking examines the full
bounded read before the 16KiB output limit. `logs:<uid>:<container>` stores only
an inclusive RFC3339Nano timestamp. Exact source-key duplicates do not consume
the accepted-new-row budget. The separate `logs-state:<uid>:<container>` cursor
stores bounded nonsecret parser state (`v`, `pem`, optional quote, sequence),
never secret text. Rows, timestamp and compare-and-swap parser state commit in
one transaction after ordered parent locks and a fresh scope/snapshot check.
No Kubernetes network call is performed while database locks are held.

Hard limits: 200 Pods, 10,000 accepted rows, 16MiB accepted bytes/run, 1MiB
source read and 16KiB output line. The deadline includes discovery and owner
lookups. Observations precede neither Pod creation nor the retained interval,
and can be at most 30 seconds in the future. Retention is at most seven days,
deleting at most 10,000 rows/cursors per transaction; cursor cleanup is limited
to `logs:` and `logs-state:`. Bounded or incomplete source windows explicitly
report `source_window_limited`; this is not a lossless historical log pipeline.

Stdout exposes fixed `kind="log"` aggregate observation-present, persistence-lag
and last-success-age gauges; absence is represented by observation-present=0.
No tenant, deployment or Pod values become metric labels. Backend/HTTP errors
never expose raw Kubernetes bodies; all output and database log lines use the
same masking module.

Local qualification uses `scripts/qualify-local.sh <module> <evidence-dir>
<shared-fixture-dir> [test-pattern]` as WSL root. It creates one UUID-named
PostgreSQL database, applies existing migrations 1–13, runs the compiled binary
against authenticated local HTTP fixtures, tests concurrent insertion/deletion
and rollback with `go test -race`, captures hashes/artifacts, then drops only
that database and its native temporary directory. It requires installed Go and
PostgreSQL, not Kubernetes, registry, Docker or cloud credentials. This is LOCAL
qualification; live sentinel evidence remains separate.
