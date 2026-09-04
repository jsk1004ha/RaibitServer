package recoverydb

import (
	"os"
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
	for _, required := range []string{"*@sha256:", "COPY --chmod=0555", `ENTRYPOINT ["/usr/local/bin/raibit-recovery-db"]`} {
		if !strings.Contains(contract, required) {
			t.Fatalf("image contract missing %q", required)
		}
	}
}

func Test_RecoveryImage_redeclares_digest_policy_in_build_stage(t *testing.T) {
	// Given
	dockerfile, err := os.ReadFile("../../recovery-images/db/Dockerfile")
	if err != nil {
		t.Fatalf("read Dockerfile: %v", err)
	}
	contract := string(dockerfile)
	from := strings.Index(contract, "FROM ${BASE_IMAGE}")
	stageArgument := strings.Index(contract[from+1:], "ARG BASE_IMAGE")
	digestPolicy := strings.Index(contract[from+1:], `case "${BASE_IMAGE}" in *@sha256:`)
	tagFailure := strings.Index(contract[from+1:], `*) exit 64`)

	// When / Then
	if from < 0 || stageArgument < 0 || digestPolicy < 0 || tagFailure < 0 || stageArgument > digestPolicy || digestPolicy > tagFailure {
		t.Fatalf("BASE_IMAGE digest-pass/tag-fail policy is outside build stage: from=%d arg=%d digest=%d tag=%d", from, stageArgument, digestPolicy, tagFailure)
	}
}
