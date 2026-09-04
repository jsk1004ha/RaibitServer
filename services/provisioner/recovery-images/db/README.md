# Database recovery tool image contract

This Dockerfile adds RAIBITSERVER's fixed recovery ABI to an engine-specific native-client image. The build input `BASE_IMAGE` must be an immutable digest reference (`registry/repository@sha256:<64 hex characters>`); tags and floating bases are not release inputs.

The selected base is a deliberately complete recovery-tool bundle. The Dockerfile rejects non-digest inputs and fails its build unless every allowlisted client exists and returns version information. One published image may be reused across engine actions; separate per-engine digest publications remain allowed.

| Family | Required clients | Accepted actions |
| --- | --- | --- |
| PostgreSQL | `psql`, `pg_dump`, `pg_restore` | `postgresql-verify`, `postgresql-dump`, `postgresql-restore` |
| MySQL | `mysql`, `mysqldump` | `mysql-verify`, `mysql-dump`, `mysql-restore` |
| MariaDB | `mariadb`, `mariadb-dump` | `mariadb-verify`, `mariadb-dump`, `mariadb-restore` |
| MongoDB | `mongosh`, `mongodump`, `mongorestore` | `mongodb-verify`, `mongodb-dump`, `mongodb-restore` |

The image entrypoint accepts exactly one action from the table. It never accepts a client executable, arbitrary arguments, or a filesystem path.

At runtime the reconciler supplies `RAIBIT_RECOVERY_HOST`, `RAIBIT_RECOVERY_PORT`, `RAIBIT_RECOVERY_DATABASE`, and `RAIBIT_RECOVERY_USERNAME`. The credential is mounted at `/var/run/raibit-recovery/credential`, and a writable memory-backed volume is mounted at `/var/run/raibit-recovery/scratch`. The helper creates private configuration beneath that scratch directory, streams dumps on stdout and restores on stdin, bounds/redacts native stderr, and removes its private files before exiting.

Example build (the binary is cross-compiled separately with `CGO_ENABLED=0`):

```sh
docker build \
  --build-arg BASE_IMAGE=registry.example/recovery-tool-bundle@sha256:<64-hex-digest> \
  --build-arg TARGETARCH=amd64 \
  -t registry.example/raibit-recovery-db:candidate \
  services/provisioner/recovery-images/db
```

Push the candidate and use the registry-reported immutable digest in deployment configuration. SQL and MongoDB receipts describe structural verification (engine version, canonical schema/collection descriptor digest, and descriptor count). They do not assert row/document equality. Artifact byte integrity comes from the framed transport receipt and encrypted object readback. The published image itself must also be configured by digest. Helm wiring is intentionally outside this image contract.
