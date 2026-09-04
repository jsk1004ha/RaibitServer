//go:build integration

package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/raibitserver/metrics-ingester/internal/identity"
	"github.com/raibitserver/metrics-ingester/internal/ingester"
)

func TestIngestionHappyReplayConcurrentRestart(t *testing.T) {
	// Given: real migrated PostgreSQL and current pre-READY authority.
	p, r := fixtureStore(t)
	results := make(chan ingester.Persisted, 2)
	errs := make(chan error, 2)
	// When: independent transactions race on exactly the same source sample.
	for range 2 {
		go func() { out, err := p.Insert(t.Context(), batchOf(r)); results <- out; errs <- err }()
	}
	inserted := 0
	for range 2 {
		inserted += (<-results).Inserted
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	// Then: one stored v1 source key, one nanosecond watermark, replay inserts none.
	if inserted != 1 || count(t, p.db, `SELECT count(*) FROM "RuntimeMetric" WHERE "sourceKey"=$1`, r.SourceKey) != 1 {
		t.Fatal("concurrent replay duplicated row")
	}
	var cursor string
	if err := p.db.QueryRowContext(t.Context(), `SELECT cursor FROM "IngestionCursor" WHERE key=$1`, cursorKey(r)).Scan(&cursor); err != nil {
		t.Fatal(err)
	}
	if cursor != r.Timestamp.Format(time.RFC3339Nano) {
		t.Fatal("watermark lost source nanoseconds")
	}
	out, err := p.Insert(t.Context(), batchOf(r))
	if err != nil || out.Inserted != 0 || !out.Newest.IsZero() {
		t.Fatalf("restart replay=%#v err=%v", out, err)
	}
	t.Logf("OBSERVABLE rows=1 watermarks=1 concurrentInserted=%d sourceKey=%s cursor=%s", inserted, r.SourceKey, cursor)
	var observation []byte
	if err := p.db.QueryRowContext(t.Context(), `SELECT jsonb_build_object('records',(SELECT jsonb_agg(to_jsonb(m)) FROM "RuntimeMetric" m WHERE "deploymentId"=$1),'watermarks',(SELECT jsonb_agg(to_jsonb(c)) FROM "IngestionCursor" c WHERE key=$2))`, r.DeploymentID, cursorKey(r)).Scan(&observation); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(os.Getenv("RAIBITSERVER_EVIDENCE_DIR"), "postgres-observation.json"), observation, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestReplayDoesNotConsumeNewRowBudget(t *testing.T) {
	// Given: a previously accepted row plus a new sample.
	p, r := fixtureStore(t)
	if _, err := p.Insert(t.Context(), batchOf(r)); err != nil {
		t.Fatal(err)
	}
	next := r
	next.Timestamp = next.Timestamp.Add(time.Nanosecond)
	next.SourceKey = recordKey(next)
	batch := batchOf(r, next)
	batch.Limit = 1
	// When: replay and new sample share a one-new-row budget.
	out, err := p.Insert(t.Context(), batch)
	// Then: the replay does not starve the new sample.
	if err != nil || out.Inserted != 1 || count(t, p.db, `SELECT count(*) FROM "RuntimeMetric" WHERE "deploymentId"=$1`, r.DeploymentID) != 2 {
		t.Fatalf("budget=%#v err=%v", out, err)
	}
}

func TestRejectedIdentityCannotAdvanceWatermark(t *testing.T) {
	for _, scenario := range []struct{ name, sql string }{
		{"cancel", `UPDATE "Deployment" SET status='CANCELLED' WHERE id=$1`},
		{"cleanup", `UPDATE "Deployment" SET "reconcileAction"='preview-cleanup' WHERE id=$1`},
		{"snapshot", `UPDATE "Deployment" SET "desiredSpecSnapshot"='{"type":"worker"}' WHERE id=$1`},
		{"legacy_snapshot", `UPDATE "Deployment" SET "desiredSpecSnapshot"=NULL,"snapshotVersion"=NULL WHERE id=$1`},
		{"malformed_snapshot", `UPDATE "Deployment" SET "desiredSpecSnapshot"='{"type":"web","env":[]}' WHERE id=$1`},
		{"parent", `UPDATE "Project" SET status='DELETING' WHERE id=(SELECT "projectId" FROM "Deployment" WHERE id=$1)`},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			// Given: authority changed after the source identity was verified.
			p, r := fixtureStore(t)
			if _, err := p.db.ExecContext(t.Context(), scenario.sql, r.DeploymentID); err != nil {
				t.Fatal(err)
			}
			// When: the stale batch reaches the real transaction.
			_, err := p.Insert(t.Context(), batchOf(r))
			// Then: both records and watermarks remain absent.
			if !errors.Is(err, identity.ErrIdentity) || count(t, p.db, `SELECT count(*) FROM "RuntimeMetric" WHERE "deploymentId"=$1`, r.DeploymentID) != 0 || count(t, p.db, `SELECT count(*) FROM "IngestionCursor" WHERE key=$1`, cursorKey(r)) != 0 {
				t.Fatalf("stale identity committed err=%v", err)
			}
		})
	}
}

func TestInsertFailureRollsBackRecordsAndWatermarks(t *testing.T) {
	// Given: a constraint will reject the second insert after the first is staged.
	p, r := fixtureStore(t)
	next := r
	next.Metric = "memory"
	next.Unit = "bytes"
	next.SourceKey = recordKey(next)
	if _, err := p.db.ExecContext(t.Context(), `ALTER TABLE "RuntimeMetric" ADD CONSTRAINT task19_reject_memory CHECK(metric <> 'memory')`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := p.db.ExecContext(context.Background(), `ALTER TABLE "RuntimeMetric" DROP CONSTRAINT task19_reject_memory`); err != nil {
			t.Error(err)
		}
	})
	// When: one record fails inside the atomic batch.
	_, err := p.Insert(t.Context(), batchOf(r, next))
	// Then: the preceding record and all cursor updates roll back.
	if err == nil || count(t, p.db, `SELECT count(*) FROM "RuntimeMetric" WHERE "deploymentId"=$1`, r.DeploymentID) != 0 || count(t, p.db, `SELECT count(*) FROM "IngestionCursor" WHERE key IN ($1,$2)`, cursorKey(r), cursorKey(next)) != 0 {
		t.Fatal("partial atomic batch escaped")
	}
}
