package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/log-ingester/internal/identity"
	"github.com/raibitserver/log-ingester/internal/ingester"
)

type harness struct {
	store *Postgres
	scope identity.Scope
	now   time.Time
}

func postgresFixture(t *testing.T) harness {
	t.Helper()
	dsn := os.Getenv("RAIBITSERVER_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set RAIBITSERVER_TEST_DATABASE_URL for real PostgreSQL qualification")
	}
	ctx := context.Background()
	state, closeDB, err := Open(ctx, dsn, Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := closeDB(); err != nil {
			t.Error(err)
		}
	})
	id := "log-" + strings.ToLower(strings.ReplaceAll(t.Name(), "/", "-"))
	for _, query := range []string{
		`INSERT INTO "Organization" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,CURRENT_TIMESTAMP)`,
		`INSERT INTO "Project" (id,"organizationId",name,slug,"updatedAt") VALUES ($1,$1,$1,'project',CURRENT_TIMESTAMP)`,
		`INSERT INTO "Service" (id,"projectId",name,slug,type,"sourceType","updatedAt") VALUES ($1,$1,'web','web','web','image',CURRENT_TIMESTAMP)`,
		`INSERT INTO "Deployment" (id,"serviceId","projectId",status,"deploymentType","imageUrl","desiredSpecSnapshot","snapshotVersion","updatedAt") VALUES ($1,$1,$1,'DEPLOYING','production','registry.test/app:tag','{"type":"web"}',1,CURRENT_TIMESTAMP)`,
	} {
		if _, err := state.db.ExecContext(ctx, query, id); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		if _, err := state.db.ExecContext(context.Background(), `DELETE FROM "Organization" WHERE id=$1`, id); err != nil {
			t.Error(err)
		}
	})
	scope, err := state.Resolve(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return harness{store: state, scope: scope, now: time.Now().UTC().Truncate(time.Second)}
}

func (h harness) batch(line string) ([]ingester.Record, []ingester.CursorUpdate) {
	uid := h.scope.DeploymentID
	sum := sha256.Sum256([]byte(uid + "\x00web\x00" + h.now.Format(time.RFC3339Nano) + "\x00" + line))
	key := hex.EncodeToString(sum[:])
	return []ingester.Record{{Scope: h.scope, SourceKey: key, ServiceID: h.scope.ServiceID, DeploymentID: h.scope.DeploymentID, PodName: "pod", PodUID: uid, ContainerName: "web", Line: line, Level: "info", Timestamp: h.now}}, []ingester.CursorUpdate{{Scope: h.scope, Key: "logs:" + uid + ":web", Cursor: h.now, State: `{"v":1,"pem":false,"sequence":1}`}}
}

func assertEmpty(t *testing.T, h harness) {
	t.Helper()
	var rows, cursors int
	err := h.store.db.QueryRowContext(context.Background(), `SELECT (SELECT COUNT(*) FROM "RuntimeLog" WHERE "serviceId"=$1),(SELECT COUNT(*) FROM "IngestionCursor" WHERE key=$2 OR key=$3)`, h.scope.ServiceID, "logs:"+h.scope.DeploymentID+":web", "logs-state:"+h.scope.DeploymentID+":web").Scan(&rows, &cursors)
	if err != nil || rows != 0 || cursors != 0 {
		t.Fatalf("atomic rollback violated: rows=%d cursors=%d err=%v", rows, cursors, err)
	}
}

func TestIngestionAdversarialPostgresLifecycleRecheck(t *testing.T) {
	for _, test := range []struct{ name, query string }{
		{"cancelled", `UPDATE "Deployment" SET status='CANCELLED' WHERE id=$1`},
		{"cleanup", `UPDATE "Deployment" SET "reconcileAction"='cleanup' WHERE id=$1`},
		{"snapshot_changed", `UPDATE "Deployment" SET "desiredSpecSnapshot"='{"type":"worker"}' WHERE id=$1`},
		{"parent_deleting", `UPDATE "Project" SET "deletionRequestedAt"=CURRENT_TIMESTAMP WHERE id=$1`},
	} {
		t.Run(test.name, func(t *testing.T) {
			// Given: a scope was verified before a control-plane lifecycle change.
			h := postgresFixture(t)
			rows, cursors := h.batch("ready")
			if _, err := h.store.db.ExecContext(context.Background(), test.query, h.scope.DeploymentID); err != nil {
				t.Fatal(err)
			}
			// When / Then: the persistence transaction rechecks rather than trusting the old scope.
			_, err := h.store.Insert(context.Background(), rows, cursors)
			if !errors.Is(err, identity.ErrIdentity) {
				t.Fatalf("recheck not denied: %v", err)
			}
			assertEmpty(t, h)
		})
	}
}

func TestIngestionAdversarialPostgresInsertRollback(t *testing.T) {
	// Given: an actual database constraint fails after the first row of a batch.
	h := postgresFixture(t)
	first, cursors := h.batch("first")
	second, _ := h.batch("second")
	if _, err := h.store.db.ExecContext(context.Background(), `ALTER TABLE "RuntimeLog" ADD CONSTRAINT task19_log_failure CHECK(line <> 'second')`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := h.store.db.ExecContext(context.Background(), `ALTER TABLE "RuntimeLog" DROP CONSTRAINT task19_log_failure`); err != nil {
			t.Error(err)
		}
	})
	// When: the batch attempts both rows and its cursor/state updates.
	_, err := h.store.Insert(context.Background(), append(first, second...), cursors)
	// Then: no first-row partial commit or cursor/state survives.
	if err == nil {
		t.Fatal("constraint failure expected")
	}
	assertEmpty(t, h)
}

func TestIngestionHappyPostgresConcurrentDeduplication(t *testing.T) {
	// Given: two workers hold the same pre-transaction source state.
	h := postgresFixture(t)
	rows, cursors := h.batch("ready")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := make(chan struct{})
	results := make(chan error, 2)
	for range 2 {
		go func() { <-start; _, err := h.store.Insert(ctx, rows, cursors); results <- err }()
	}
	// When: both transactions contend on the actual parent/source locks.
	close(start)
	success, conflict := 0, 0
	for range 2 {
		err := <-results
		if err == nil {
			success++
		} else if errors.Is(err, ingester.ErrCursorConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	// Then: exactly one row and one atomic continuation win.
	var count int
	if err := h.store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM "RuntimeLog" WHERE "serviceId"=$1`, h.scope.ServiceID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 || success != 1 || conflict != 1 {
		t.Fatalf("dedupe race: rows=%d wins=%d conflicts=%d", count, success, conflict)
	}
	t.Logf("actual_pg_race rows=%d committed=%d cursor_conflict=%d", count, success, conflict)
}
