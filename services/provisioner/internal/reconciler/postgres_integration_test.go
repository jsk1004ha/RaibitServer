package reconciler

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/provisioner/internal/command"
	"github.com/raibitserver/provisioner/internal/store"
)

func TestPostgresReadyProviderReplacementTransitionsToFailed(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("RAIBITSERVER_TEST_POSTGRES_DSN"))
	if dsn == "" {
		t.Skip("RAIBITSERVER_TEST_POSTGRES_DSN is not configured")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close PostgreSQL integration database: %v", err)
		}
	})
	if err := db.PingContext(ctx); err != nil {
		t.Fatal(err)
	}

	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	organizationID := "uid-health-org-" + suffix
	projectID := "uid-health-project-" + suffix
	resourceID := "uid-health-resource-" + suffix
	providerName := "uid-health-db"
	t.Cleanup(func() {
		if _, err := db.Exec(`DELETE FROM "Organization" WHERE id = $1`, organizationID); err != nil {
			t.Errorf("remove PostgreSQL integration organization %s: %v", organizationID, err)
		}
	})
	desiredState, err := json.Marshal(map[string]any{
		"credentialSecretUID": testCredentialSecretUID,
		"healthManaged":       true,
		"healthStatus":        "HEALTHY",
		"providerIdentity": map[string]any{
			"namespace": "uid-health-tenant",
			"name":      providerName,
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := db.ExecContext(ctx, `INSERT INTO "Organization" (id, name, slug, "updatedAt")
VALUES ($1, 'UID health organization', $1, CURRENT_TIMESTAMP)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO "Project" (id, "organizationId", name, slug, status, "updatedAt")
VALUES ($1, $2, 'UID health project', $1, 'ACTIVE', CURRENT_TIMESTAMP)`, projectID, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO "Resource" (id, "projectId", name, slug, type, engine, provider, plan, region, status,
  "desiredSpec", "desiredState", "connectionSecretName", "updatedAt")
VALUES ($1, $2, 'UID health database', 'uid-health-database', 'database', 'postgresql', 'raibitserver',
  'shared-small', 'local', 'READY', '{"databaseName":"uid_health","storageGb":1}'::jsonb, $3::jsonb,
  $4, CURRENT_TIMESTAMP - interval '1 minute')`, resourceID, projectID, desiredState, providerName+"-connection"); err != nil {
		t.Fatal(err)
	}

	state, closeStore, err := store.OpenPostgresStore(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := closeStore(); err != nil {
			t.Errorf("close provisioner PostgreSQL store: %v", err)
		}
	})
	config := postgresqlLiveConfig(t.TempDir())
	config.HealthInterval = time.Millisecond
	result, reconcileErr := New(config, state, &fakeRunner{secretExists: true, replacementUIDMismatch: true}).RunOnce(ctx)
	if !errors.Is(reconcileErr, command.ErrSecretUIDMismatch) || result == nil || result.Status != store.StatusFailed {
		t.Fatalf("replacement Secret must fail through the real PostgreSQL claim path: result=%#v err=%v", result, reconcileErr)
	}

	var status, healthStatus string
	var failureCount int
	if err := db.QueryRowContext(ctx, `
SELECT status, COALESCE("desiredState"->>'healthStatus', ''),
       COALESCE(("desiredState"->>'healthFailureCount')::integer, 0)
FROM "Resource" WHERE id = $1`, resourceID).Scan(&status, &healthStatus, &failureCount); err != nil {
		t.Fatal(err)
	}
	if status != store.StatusFailed || healthStatus != "UNHEALTHY" || failureCount < healthFailureThreshold {
		t.Fatalf("credential integrity failure was not persisted atomically: status=%q health=%q failures=%d", status, healthStatus, failureCount)
	}
}
