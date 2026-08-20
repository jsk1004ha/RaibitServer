FROM golang:1.26.5-bookworm@sha256:18aedc16aa19b3fd7ded7245fc14b109e054d65d22ed53c355c899582bbb2113 AS build
WORKDIR /src
COPY services/builder/go.mod services/builder/go.sum ./
RUN go mod download
COPY services/builder/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -buildvcs=false -mod=readonly -trimpath -ldflags="-s -w -buildid=" -o /out/builder ./cmd/builder

FROM moby/buildkit:v0.30.0-rootless@sha256:d76eb1caecac5733ef7553c1e90a1b21f1bb218cd1142d3553de0747b4a14ba9 AS buildkit
FROM aquasec/trivy:0.70.0@sha256:be1190afcb28352bfddc4ddeb71470835d16462af68d310f9f4bca710961a41e AS trivy
FROM ghcr.io/sigstore/cosign/cosign:v3.0.6@sha256:de9c65609e6bde17e6b48de485ee788407c9502fa08b8f4459f595b21f56cd00 AS cosign

FROM debian:bookworm-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df AS runtime
# Bootstrap the TLS trust store from the digest-pinned build stage before
# contacting snapshot.debian.org over HTTPS.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN rm -f /etc/apt/sources.list.d/debian.sources && \
    printf '%s\n' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260701T000000Z bookworm main' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20260701T000000Z bookworm-security main' \
      > /etc/apt/sources.list && \
    apt-get -o Acquire::Check-Valid-Until=false update && \
    apt-get install --yes --no-install-recommends ca-certificates git && \
    rm -rf /var/lib/apt/lists/*
COPY --from=build /out/builder /usr/local/bin/raibitserver-builder
COPY --from=buildkit /usr/bin/buildctl /usr/local/bin/buildctl
COPY --from=trivy /usr/local/bin/trivy /usr/local/bin/trivy
COPY --from=cosign /ko-app/cosign /usr/local/bin/cosign
ENV HOME=/tmp
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/raibitserver-builder"]
