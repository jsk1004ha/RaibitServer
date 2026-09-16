//go:build integration

package store

import (
	"context"
	"testing"
	"time"
)

func TestRetentionBoundAndCursorPrefix(t *testing.T) {
	// Given: more than one retention batch and independently owned log cursors.
	p, r := fixtureStore(t)
	before := time.Now().UTC().Add(-30 * 24 * time.Hour)
	if _, err := p.db.ExecContext(t.Context(), `INSERT INTO "RuntimeMetric"(id,"serviceId","deploymentId","podName","containerName",metric,value,unit,"sourceKey",timestamp) SELECT $1||g,$2,$3,'pod','web','cpu',1,'cores',$1||g,$4::timestamp - interval '1 day' FROM generate_series(1,10001) g`, r.PodUID, r.ServiceID, r.DeploymentID, before); err != nil {
		t.Fatal(err)
	}
	keys := []string{"metrics:expired:" + r.PodUID, "logs:keep:" + r.PodUID, "metrics:locked:" + r.PodUID}
	for _, key := range keys {
		if _, err := p.db.ExecContext(t.Context(), `INSERT INTO "IngestionCursor"(key,cursor,"updatedAt") VALUES($1,'old',$2)`, key, before.Add(-time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := p.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(t.Context(), `UPDATE "IngestionCursor" SET "updatedAt"=now() WHERE key=$1`, keys[2]); err != nil {
		t.Fatal(err)
	}
	// When: retention overlaps a watermark refresh holding its row lock.
	deleted, err := p.DeleteOlderThan(t.Context(), before)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	// Then: only 10000 expired rows and this ingester's unlocked expired cursor vanish.
	remaining := count(t, p.db, `SELECT count(*) FROM "RuntimeMetric" WHERE "deploymentId"=$1`, r.DeploymentID)
	expired := count(t, p.db, `SELECT count(*) FROM "IngestionCursor" WHERE key=$1`, keys[0])
	protected := count(t, p.db, `SELECT count(*) FROM "IngestionCursor" WHERE key IN ($1,$2)`, keys[1], keys[2])
	if deleted != 10000 || remaining != 1 || expired != 0 || protected != 2 {
		t.Fatalf("retention: deleted=%d remaining=%d expired=%d protected=%d", deleted, remaining, expired, protected)
	}
	if _, err = p.db.ExecContext(context.Background(), `DELETE FROM "IngestionCursor" WHERE key IN ($1,$2)`, keys[1], keys[2]); err != nil {
		t.Fatal(err)
	}
	t.Log("OBSERVABLE deleted=10000 remaining=1 foreignLogCursor=1 refreshedMetricCursor=1")
}
