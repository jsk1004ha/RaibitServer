package store

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/raibitserver/log-ingester/internal/identity"
)

func TestIngestionAdversarialPostgresDeletionRace(t *testing.T) {
	// Given: deletion owns the first parent lock before ingestion can acquire children.
	h := postgresFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	gate, err := h.store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := gate.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
			t.Error(err)
		}
	}()
	var id string
	var pid int
	if err := gate.QueryRowContext(ctx, `SELECT id,pg_backend_pid() FROM "Organization" WHERE id=$1 FOR UPDATE`, h.scope.OrganizationID).Scan(&id, &pid); err != nil {
		t.Fatal(err)
	}
	rows, cursors := h.batch("must not survive")
	done := make(chan error, 1)
	go func() { _, err := h.store.Insert(ctx, rows, cursors); done <- err }()
	blocked := false
	for !blocked {
		if err := h.store.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
	}
	// When: deletion commits while the ingestion worker is visibly queued in PostgreSQL.
	if _, err := gate.ExecContext(ctx, `DELETE FROM "Service" WHERE id=$1`, h.scope.ServiceID); err != nil {
		t.Fatal(err)
	}
	if err := gate.Commit(); err != nil {
		t.Fatal(err)
	}
	err = <-done
	// Then: the post-lock scope check rejects atomically, with no cursor advancement.
	if !errors.Is(err, identity.ErrIdentity) {
		t.Fatalf("deletion race accepted: %v", err)
	}
	assertEmpty(t, h)
	t.Log("actual_pg_lock_wait=true deleted_parent=true rows=0 cursors=0")
}

func TestIngestionAdversarialPostgresRetentionOwnership(t *testing.T) {
	// Given: more than one batch of old rows plus disjoint metric/other cursors.
	h := postgresFixture(t)
	ctx := context.Background()
	cutoff := h.now.Add(-7 * 24 * time.Hour)
	if _, err := h.store.db.ExecContext(ctx, `INSERT INTO "RuntimeLog" (id,"serviceId","podName","containerName",line,timestamp) SELECT $1||'-old-'||g,$1,'pod','web','old',$2 FROM generate_series(1,10002) g`, h.scope.ServiceID, cutoff.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"logs:retention:web", "logs-state:retention:web", "metrics:retention:web:cpu", "unrelated:retention"} {
		if _, err := h.store.db.ExecContext(ctx, `INSERT INTO "IngestionCursor" (key,cursor,"updatedAt") VALUES ($1,'opaque',$2)`, key, cutoff.Add(-time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	// When: the log-only retention worker runs once.
	deleted, err := h.store.DeleteOlderThan(ctx, cutoff)
	if err != nil {
		t.Fatal(err)
	}
	// Then: at most 10,000 rows and only the log-owned cursor prefixes are removed.
	var logs, cursors int
	if err := h.store.db.QueryRowContext(ctx, `SELECT (SELECT COUNT(*) FROM "RuntimeLog" WHERE "serviceId"=$1),(SELECT COUNT(*) FROM "IngestionCursor" WHERE key IN ('metrics:retention:web:cpu','unrelated:retention'))`, h.scope.ServiceID).Scan(&logs, &cursors); err != nil {
		t.Fatal(err)
	}
	if deleted != 10000 || logs != 2 || cursors != 2 {
		t.Fatalf("retention ownership: deleted=%d remaining=%d foreign=%d", deleted, logs, cursors)
	}
	t.Logf("retention_deleted=%d remaining=%d foreign_cursors=%d", deleted, logs, cursors)
}
