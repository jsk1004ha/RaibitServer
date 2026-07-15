package controlplane

import (
	"strings"
	"testing"
)

func TestPostgresDSNFromEnvRequiresExplicitControlPlaneSelection(t *testing.T) {
	if got := PostgresDSNFromEnv(map[string]string{"DATABASE_URL": "postgresql://app:secret@localhost/db"}); got != "" {
		t.Fatalf("DATABASE_URL alone should not opt the local builder into PostgreSQL store, got %q", got)
	}
	if got := PostgresDSNFromEnv(map[string]string{"RAIBITSERVER_CONTROL_PLANE_STORE": "postgresql", "DATABASE_URL": "postgresql://app:secret@localhost/db"}); got != "postgresql://app:secret@localhost/db" {
		t.Fatalf("expected DATABASE_URL when PostgreSQL store mode is explicit, got %q", got)
	}
	if got := PostgresDSNFromEnv(map[string]string{"RAIBITSERVER_CONTROL_PLANE_DATABASE_URL": "postgresql://cp:secret@localhost/control", "DATABASE_URL": "postgresql://app:secret@localhost/db"}); got != "postgresql://cp:secret@localhost/control" {
		t.Fatalf("expected dedicated control-plane DSN to win, got %q", got)
	}
}

func TestRedactDSNMasksPassword(t *testing.T) {
	redacted := RedactDSN("postgresql://builder:super-secret@localhost:5432/raibitserver?sslmode=disable")
	if strings.Contains(redacted, "super-secret") {
		t.Fatalf("redacted DSN leaked password: %s", redacted)
	}
	if !strings.Contains(redacted, "builder") || !strings.Contains(redacted, "redacted") {
		t.Fatalf("redacted DSN should preserve username and mask password, got %s", redacted)
	}
}

func TestPostgresUpdateAssignmentsAreWhitelistedDeterministicAndMasked(t *testing.T) {
	assignments, args, err := updateAssignments(map[string]any{
		"imageUrl":     "localhost:5000/demo/web:latest",
		"errorMessage": "DATABASE_URL=postgresql://user:secret@localhost/db failed",
	}, deploymentUpdateColumns)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(assignments, ",") != `"errorMessage" = $1,"imageUrl" = $2` {
		t.Fatalf("assignments should be sorted for deterministic SQL, got %#v", assignments)
	}
	if strings.Contains(args[0].(string), "secret") || !strings.Contains(args[0].(string), "DATABASE_URL=****") {
		t.Fatalf("secret-looking update value was not masked: %#v", args[0])
	}
	if _, _, err := updateAssignments(map[string]any{"desiredState": map[string]any{}}, deploymentUpdateColumns); err == nil {
		t.Fatal("expected unsupported update fields to fail closed")
	}
}

func TestPostgresClaimSQLCoversQueuedAndStaleRunningJobs(t *testing.T) {
	normalized := strings.Join(strings.Fields(claimWorkflowJobSQL), " ")
	for _, fragment := range []string{
		`WITH exhausted AS`,
		`wj.attempts >= CASE WHEN wj."maxAttempts" > 0 THEN wj."maxAttempts" ELSE 3 END`,
		`FOR UPDATE SKIP LOCKED LIMIT $5`,
		`status = 'failed'`,
		`payload = jsonb_set`,
		`'{lastError}'`,
		`'{lastErrorSpec}'`,
		`'{failedAt}'`,
		`"lockedBy" = NULL`,
		`"lockedAt" = NULL`,
		`UPDATE "Deployment" AS d`,
		`status = 'BUILD_FAILED'`,
		`"buildFinishedAt"`,
		`"errorCode" = 'BUILD_FAILED'`,
		`"errorMessage" = $6`,
		`UPPER(d.status) IN ('QUEUED', 'BUILDING')`,
		`BTRIM(wj.payload ->> 'deploymentId')`,
		`BTRIM(wj."targetId")`,
		`status = $1`,
		`status = $4`,
		`"lockedAt" <= $3`,
		`wj.attempts < CASE WHEN wj."maxAttempts" > 0 THEN wj."maxAttempts" ELSE 3 END`,
		`FOR UPDATE SKIP LOCKED`,
	} {
		if !strings.Contains(normalized, fragment) {
			t.Fatalf("claim SQL missing %q in %s", fragment, normalized)
		}
	}
}

func TestPostgresClaimSQLSkipsDeletingServiceAndProjectTargets(t *testing.T) {
	normalized := strings.Join(strings.Fields(claimWorkflowJobSQL), " ")
	for _, fragment := range []string{
		`NOT EXISTS`,
		`FROM "Deployment"`,
		`JOIN "Service"`,
		`JOIN "Project"`,
		`payload ->> 'deploymentId'`,
		`LOWER(BTRIM(wj."targetType")) = 'deployment'`,
		`"targetId"`,
		`DELETE_REQUESTED`,
		`DELETING`,
		`DELETE_FAILED`,
	} {
		if !strings.Contains(normalized, fragment) {
			t.Fatalf("claim SQL missing deletion fence %q in %s", fragment, normalized)
		}
	}
}

func TestPostgresImagePublicationSQLFencesLeaseAndDeletionRace(t *testing.T) {
	lockTarget := strings.Join(strings.Fields(lockImagePublicationTargetSQL), " ")
	for _, fragment := range []string{
		`JOIN "Service"`,
		`JOIN "Project"`,
		`FOR UPDATE OF d, s, p`,
	} {
		if !strings.Contains(lockTarget, fragment) {
			t.Fatalf("publication target lock SQL missing %q in %s", fragment, lockTarget)
		}
	}
	leaseFence := strings.Join(strings.Fields(lockWorkflowLeaseSQL), " ")
	for _, fragment := range []string{`status`, `"lockedBy"`, `attempts`, `FOR UPDATE`} {
		if !strings.Contains(leaseFence, fragment) {
			t.Fatalf("publication lease SQL missing %q in %s", fragment, leaseFence)
		}
	}
}

func TestPostgresBuildStartSQLFencesLeaseAndDeletingParents(t *testing.T) {
	lockTarget := strings.Join(strings.Fields(lockBuildStartTargetSQL), " ")
	for _, fragment := range []string{
		`JOIN "Service"`,
		`JOIN "Project"`,
		`FOR UPDATE OF d, s, p`,
	} {
		if !strings.Contains(lockTarget, fragment) {
			t.Fatalf("build-start target lock SQL missing %q in %s", fragment, lockTarget)
		}
	}
	start := strings.Join(strings.Fields(startBuildSQL), " ")
	for _, fragment := range []string{`status = 'BUILDING'`, `"buildStartedAt"`, `WHERE id = $2`} {
		if !strings.Contains(start, fragment) {
			t.Fatalf("build-start update SQL missing %q in %s", fragment, start)
		}
	}
	leaseFence := strings.Join(strings.Fields(lockWorkflowLeaseSQL), " ")
	for _, fragment := range []string{`status`, `"lockedBy"`, `attempts`, `FOR UPDATE`} {
		if !strings.Contains(leaseFence, fragment) {
			t.Fatalf("build-start lease SQL missing %q in %s", fragment, leaseFence)
		}
	}
}

func TestPostgresClaimSQLOnlySelectsSupportedBuildWorkflowTypes(t *testing.T) {
	normalized := strings.Join(strings.Fields(claimWorkflowJobSQL), " ")
	for _, workflowType := range []string{"build-and-deploy", "preview-deploy", "build", "builder"} {
		if !strings.Contains(normalized, "'"+workflowType+"'") {
			t.Fatalf("claim SQL must include supported build workflow type %q: %s", workflowType, normalized)
		}
	}
	for _, workflowType := range []string{"github-repository-sync", "preview-cleanup"} {
		if strings.Contains(normalized, "'"+workflowType+"'") {
			t.Fatalf("claim SQL must not include unsupported workflow type %q: %s", workflowType, normalized)
		}
	}
	if !strings.Contains(normalized, `type IN (`) {
		t.Fatalf("claim SQL must restrict jobs by type: %s", normalized)
	}
}

func TestPostgresWorkflowUpdatesAreLeaseFenced(t *testing.T) {
	for name, query := range map[string]string{
		"update": updateWorkflowJobSQL,
		"renew":  renewWorkflowLeaseSQL,
	} {
		normalized := strings.Join(strings.Fields(query), " ")
		for _, fragment := range []string{`status = 'running'`, `"lockedBy"`, `attempts`} {
			if !strings.Contains(normalized, fragment) {
				t.Fatalf("%s workflow SQL must fence ownership with %q: %s", name, fragment, normalized)
			}
		}
	}
}
