# syntax=docker/dockerfile:1.7

ARG GO_BUILD_IMAGE
FROM --platform=$BUILDPLATFORM ${GO_BUILD_IMAGE} AS build
ARG GO_BUILD_IMAGE
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY services/provisioner/ ./
RUN set -eu; digest="${GO_BUILD_IMAGE##*@sha256:}"; case "$GO_BUILD_IMAGE" in *@sha256:*) ;; *) exit 64 ;; esac; [ "${#digest}" -eq 64 ]; case "$digest" in *[!0-9a-f]*) exit 64 ;; esac
RUN CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build -trimpath -o /out/raibit-recovery-db ./cmd/raibit-recovery-db

ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG BASE_IMAGE
RUN set -eu; digest="${BASE_IMAGE##*@sha256:}"; case "$BASE_IMAGE" in *@sha256:*) ;; *) exit 64 ;; esac; [ "${#digest}" -eq 64 ]; case "$digest" in *[!0-9a-f]*) exit 64 ;; esac \
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
COPY --from=build --chown=65532:65532 --chmod=0555 /out/raibit-recovery-db /usr/local/bin/raibit-recovery-db

LABEL io.raibitserver.recovery.rootfs="read-only-required"
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/raibit-recovery-db"]
