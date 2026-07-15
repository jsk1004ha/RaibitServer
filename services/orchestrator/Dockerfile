FROM golang:1.26.5-bookworm@sha256:18aedc16aa19b3fd7ded7245fc14b109e054d65d22ed53c355c899582bbb2113 AS build
WORKDIR /src
COPY services/orchestrator/go.mod services/orchestrator/go.sum ./
RUN go mod download
COPY services/orchestrator/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -buildvcs=false -mod=readonly -trimpath -ldflags="-s -w -buildid=" -o /out/orchestrator ./cmd/orchestrator

FROM registry.k8s.io/kubectl:v1.34.1@sha256:59bafa07ff3a6d4b417e7633ddb9d79a9606ca98bf64bac080b3e65748669250 AS kubectl
FROM gcr.io/distroless/static-debian12:nonroot@sha256:b7bb25d9f7c31d2bdd1982feb4dafcaf137703c7075dbe2febb41c24212b946f AS runtime
COPY --from=build --chown=65532:65532 /out/orchestrator /orchestrator
COPY --from=kubectl --chown=65532:65532 /bin/kubectl /usr/local/bin/kubectl
ENV PATH=/usr/local/bin:/usr/bin:/bin
USER 65532:65532
ENTRYPOINT ["/orchestrator"]
