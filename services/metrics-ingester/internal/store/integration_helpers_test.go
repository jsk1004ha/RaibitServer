//go:build integration

package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/raibitserver/metrics-ingester/internal/ingester"
)

func fixtureStore(t *testing.T) (*Postgres, ingester.Record) {
	t.Helper()
	dsn := os.Getenv("RAIBITSERVER_TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("real PostgreSQL DSN required")
	}
	p, closeDB, err := Open(t.Context(), dsn, Config{MaxOpenConns: 8, MaxIdleConns: 2})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := closeDB(); err != nil {
			t.Error(err)
		}
	})
	ids := make([]string, 4)
	for i := range ids {
		var b [16]byte
		if _, err = rand.Read(b[:]); err != nil {
			t.Fatal(err)
		}
		ids[i] = fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
	}
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO "Organization"(id,name,slug,"updatedAt") VALUES($1,$1,$1,now())`, []any{ids[0]}},
		{`INSERT INTO "Project"(id,"organizationId",name,slug,"updatedAt") VALUES($1,$2,'Project','demo',now())`, []any{ids[1], ids[0]}},
		{`INSERT INTO "Service"(id,"projectId",name,slug,type,"sourceType","updatedAt") VALUES($1,$2,'Web','web','web','image',now())`, []any{ids[2], ids[1]}},
		{`INSERT INTO "Deployment"(id,"serviceId","projectId",status,"imageUrl","desiredSpecSnapshot","snapshotVersion","updatedAt") VALUES($1,$2,$3,'DEPLOYING','registry.test/image:one','{"type":"web"}',1,now())`, []any{ids[3], ids[2], ids[1]}},
	} {
		if _, err = p.db.ExecContext(t.Context(), q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		if _, err := p.db.ExecContext(context.Background(), `DELETE FROM "Organization" WHERE id=$1`, ids[0]); err != nil {
			t.Error(err)
		}
	})
	scope, err := p.Resolve(t.Context(), ids[3])
	if err != nil {
		t.Fatal(err)
	}
	r := ingester.Record{Scope: scope, Namespace: scope.Namespace, ServiceID: scope.ServiceID, DeploymentID: scope.DeploymentID, PodName: "web-pod", PodUID: ids[3], ContainerName: scope.ContainerName, Metric: "cpu", Value: 0.25, Unit: "cores", Timestamp: time.Now().UTC().Add(-time.Second)}
	r.SourceKey = recordKey(r)
	return p, r
}

func recordKey(r ingester.Record) string {
	hash := sha256.Sum256([]byte(r.PodUID + "\x00" + r.Namespace + "\x00" + r.PodName + "\x00" + r.ContainerName + "\x00" + r.Metric + "\x00" + r.Timestamp.UTC().Format(time.RFC3339Nano)))
	return hex.EncodeToString(hash[:])
}

func batchOf(r ...ingester.Record) ingester.Batch {
	return ingester.Batch{Records: r, Limit: 10000, Now: time.Now().UTC()}
}

func count(t *testing.T, db *sql.DB, q string, args ...any) int {
	t.Helper()
	var n int
	if err := db.QueryRowContext(t.Context(), q, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
