# syntax=docker/dockerfile:1.7
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG BASE_IMAGE
ARG TARGETARCH
RUN case "${BASE_IMAGE}" in *@sha256:[0-9a-f][0-9a-f]*) ;; *) exit 64 ;; esac \
    && command -v psql >/dev/null \
    && command -v pg_dump >/dev/null \
    && command -v pg_restore >/dev/null \
    && command -v mysql >/dev/null \
    && command -v mysqldump >/dev/null \
    && command -v mariadb >/dev/null \
    && command -v mariadb-dump >/dev/null \
    && command -v mongosh >/dev/null \
    && command -v mongodump >/dev/null \
    && command -v mongorestore >/dev/null \
    && psql --version >/dev/null \
    && pg_dump --version >/dev/null \
    && pg_restore --version >/dev/null \
    && mysql --version >/dev/null \
    && mysqldump --version >/dev/null \
    && mariadb --version >/dev/null \
    && mariadb-dump --version >/dev/null \
    && mongosh --version >/dev/null \
    && mongodump --version >/dev/null \
    && mongorestore --version >/dev/null
COPY --chmod=0555 bin/raibit-recovery-db-linux-${TARGETARCH} /usr/local/bin/raibit-recovery-db

USER 65532:65532
ENTRYPOINT ["/usr/local/bin/raibit-recovery-db"]
