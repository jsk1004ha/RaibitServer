package recoverydb

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func Test_RecoveryImage_checks_every_allowlisted_native_client(t *testing.T) {
	// Given
	dockerfile, err := os.ReadFile("../../recovery-images/db/Dockerfile")
	if err != nil {
		t.Fatalf("read Dockerfile: %v", err)
	}
	contract := string(dockerfile)

	// When / Then
	for _, executable := range []string{"psql", "pg_dump", "pg_restore", "mysql", "mysqldump", "mariadb", "mariadb-dump", "mongosh", "mongodump", "mongorestore"} {
		if !strings.Contains(contract, "command -v "+executable+" ") || !strings.Contains(contract, executable+" --version") {
			t.Fatalf("image does not verify %s", executable)
		}
	}
	for _, required := range []string{"*@sha256:", `rootfs="read-only-required"`, "COPY --from=build --chown=65532:65532 --chmod=0555", `ENTRYPOINT ["/usr/local/bin/raibit-recovery-db"]`} {
		if !strings.Contains(contract, required) {
			t.Fatalf("image contract missing %q", required)
		}
	}
}

func Test_RecoveryImage_builds_helper_from_repository_source_with_pinned_stages(t *testing.T) {
	// Given
	dockerfile, err := os.ReadFile("../../recovery-images/db/Dockerfile")
	if err != nil {
		t.Fatalf("read Dockerfile: %v", err)
	}
	contract := string(dockerfile)
	buildFrom := strings.Index(contract, "FROM --platform=$BUILDPLATFORM ${GO_BUILD_IMAGE} AS build")
	buildArgument := strings.Index(contract[buildFrom+1:], "ARG GO_BUILD_IMAGE")
	buildDigest := strings.Index(contract[buildFrom+1:], `case "$GO_BUILD_IMAGE" in *@sha256:*`)
	runtimeFrom := strings.Index(contract, "FROM ${BASE_IMAGE}")
	runtimeArgument := strings.Index(contract[runtimeFrom+1:], "ARG BASE_IMAGE")
	runtimeDigest := strings.Index(contract[runtimeFrom+1:], `case "$BASE_IMAGE" in *@sha256:*`)

	// When / Then
	if buildFrom < 0 || buildArgument < 0 || buildDigest < 0 || buildArgument > buildDigest || runtimeFrom < 0 || runtimeArgument < 0 || runtimeDigest < 0 || runtimeArgument > runtimeDigest {
		t.Fatalf("digest policy outside stage: build=%d/%d/%d runtime=%d/%d/%d", buildFrom, buildArgument, buildDigest, runtimeFrom, runtimeArgument, runtimeDigest)
	}
	if strings.Count(contract, `[ "${#digest}" -eq 64 ]`) != 2 || strings.Count(contract, `case "$digest" in *[!0-9a-f]*)`) != 2 {
		t.Fatal("builder and runtime digest policies do not require exactly 64 lowercase hex characters")
	}
	for _, required := range []string{
		"COPY services/provisioner/ ./",
		`CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build -trimpath -o /out/raibit-recovery-db ./cmd/raibit-recovery-db`,
		"COPY --from=build",
	} {
		if !strings.Contains(contract, required) {
			t.Fatalf("source build contract missing %q", required)
		}
	}
	if strings.Contains(contract, "bin/raibit-recovery-db-linux-") {
		t.Fatal("Dockerfile still assumes a host-built helper binary")
	}
	for _, source := range []string{"../../go.mod", "../../cmd/raibit-recovery-db/main.go"} {
		if _, err := os.Stat(filepath.Clean(source)); err != nil {
			t.Fatalf("documented repository build context source %q unavailable: %v", source, err)
		}
	}
}

func Test_RecoveryImage_readme_documents_repository_root_build_context(t *testing.T) {
	readme, err := os.ReadFile("../../recovery-images/db/README.md")
	if err != nil {
		t.Fatal(err)
	}
	contract := string(readme)
	for _, required := range []string{"Build from the repository root", "--build-arg GO_BUILD_IMAGE=", "-f services/provisioner/recovery-images/db/Dockerfile", "\n  ."} {
		if !strings.Contains(contract, required) {
			t.Fatalf("README build contract missing %q", required)
		}
	}
}
