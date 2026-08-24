FROM golang:1.25-alpine AS build
WORKDIR /src
COPY services/registry-broker/go.mod ./go.mod
COPY services/registry-broker/main.go ./main.go
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/registry-broker .

FROM scratch
COPY --from=build /out/registry-broker /registry-broker
USER 65532:65532
ENTRYPOINT ["/registry-broker"]
