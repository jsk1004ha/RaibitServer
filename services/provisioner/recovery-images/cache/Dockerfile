# syntax=docker/dockerfile:1.7

ARG GO_BUILD_IMAGE
FROM ${GO_BUILD_IMAGE} AS build
ARG GO_BUILD_IMAGE
WORKDIR /src
ENV CGO_ENABLED=0
COPY services/provisioner/ ./
RUN case "$GO_BUILD_IMAGE" in *@sha256:*) exit 0 ;; *) exit 1 ;; esac
RUN ["go", "build", "-trimpath", "-o", "/out/raibit-recovery-cache", "./cmd/raibit-recovery-cache"]

ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG BASE_IMAGE
RUN set -eu; case "$BASE_IMAGE" in *@sha256:*) ;; *) exit 1 ;; esac; for binary in redis-cli redis-check-rdb redis-server valkey-cli valkey-check-rdb valkey-server; do command -v "$binary" >/dev/null; done; redis-cli --help 2>&1 | grep -F -- '--rdb' >/dev/null; valkey-cli --help 2>&1 | grep -F -- '--rdb' >/dev/null; redis-cli --version 2>&1 | grep -i -F redis >/dev/null; valkey-cli --version 2>&1 | grep -i -F valkey >/dev/null; redis-server --version 2>&1 | grep -i -F redis >/dev/null; valkey-server --version 2>&1 | grep -i -F valkey >/dev/null
COPY --from=build --chown=65532:65532 /out/raibit-recovery-cache /usr/local/bin/raibit-recovery-cache
LABEL io.raibitserver.recovery.rootfs="read-only-required"
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/raibit-recovery-cache"]
