FROM golang:1.26.5-bookworm@sha256:18aedc16aa19b3fd7ded7245fc14b109e054d65d22ed53c355c899582bbb2113 AS build
WORKDIR /src
COPY services/metrics-ingester/go.mod services/metrics-ingester/go.sum ./
RUN go mod download
COPY services/metrics-ingester/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -buildvcs=false -mod=readonly -trimpath -ldflags="-s -w -buildid=" -o /out/metrics-ingester ./cmd/metrics-ingester

FROM gcr.io/distroless/static-debian12:nonroot@sha256:b7bb25d9f7c31d2bdd1982feb4dafcaf137703c7075dbe2febb41c24212b946f AS runtime
COPY --from=build --chown=65532:65532 /out/metrics-ingester /metrics-ingester
USER 65532:65532
ENTRYPOINT ["/metrics-ingester"]
