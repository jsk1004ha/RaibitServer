# Database recovery tool image contract

This Dockerfile builds RAIBITSERVER's fixed recovery ABI from repository source and adds it to an engine-specific native-client image. Both `GO_BUILD_IMAGE` and `BASE_IMAGE` must be immutable digest references (`registry/repository@sha256:<64 lowercase hex characters>`); tags and floating bases are rejected.

The selected base is a deliberately complete recovery-tool bundle. The Dockerfile rejects non-digest inputs and fails its build unless every allowlisted client exists and returns version information. One published image may be reused across engine actions; separate per-engine digest publications remain allowed.

| Family | Required clients | Accepted actions |
| --- | --- | --- |
| PostgreSQL | `psql`, `pg_dump`, `pg_restore` | `postgresql-verify`, `postgresql-dump`, `postgresql-restore` |
| MySQL | `mysql`, `mysqldump` | `mysql-verify`, `mysql-dump`, `mysql-restore` |
| MariaDB | `mariadb`, `mariadb-dump` | `mariadb-verify`, `mariadb-dump`, `mariadb-restore` |
| MongoDB | `mongosh`, `mongodump`, `mongorestore` | `mongodb-verify`, `mongodb-dump`, `mongodb-restore` |

The image entrypoint accepts exactly one action from the table. It never accepts a client executable, arbitrary arguments, or a filesystem path.

At runtime the reconciler supplies `RAIBIT_RECOVERY_HOST`, `RAIBIT_RECOVERY_PORT`, `RAIBIT_RECOVERY_DATABASE`, and `RAIBIT_RECOVERY_USERNAME`. The credential is mounted at `/var/run/raibit-recovery/credential`, and a writable memory-backed volume is mounted at `/var/run/raibit-recovery/scratch`. The helper creates private configuration beneath that scratch directory, streams dumps on stdout and restores on stdin, bounds/redacts native stderr, and removes its private files before exiting.

Build from the repository root so the Docker context contains `services/provisioner`. BuildKit supplies `TARGETOS` and `TARGETARCH`; the builder compiles the helper with `CGO_ENABLED=0` and `-trimpath`, so no host-generated binary is required.

```sh
docker build \
  --build-arg GO_BUILD_IMAGE=registry.example/go-builder@sha256:<64-hex-digest> \
  --build-arg BASE_IMAGE=registry.example/recovery-tool-bundle@sha256:<64-hex-digest> \
  -t registry.example/raibit-recovery-db:candidate \
  -f services/provisioner/recovery-images/db/Dockerfile \
  .
```

Push the candidate and use the registry-reported immutable digest in deployment configuration. SQL and MongoDB receipts describe structural verification (engine version, canonical schema/collection descriptor digest, and descriptor count). They do not assert row/document equality. Artifact byte integrity comes from the framed transport receipt and encrypted object readback. The published image itself must also be configured by digest. Helm wiring is intentionally outside this image contract.
