//go:build integration

package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/metrics-ingester/internal/identity"
	"github.com/raibitserver/metrics-ingester/internal/ingester"
	"github.com/raibitserver/metrics-ingester/internal/kube"
)

func TestIdentityRecheckAfterUnlockedKubernetesRequest(t *testing.T) {
	// Given: mutation at the HTTP boundary after DB resolution.
	p, r := fixtureStore(t)
	f := newHTTPFixture(r)
	mutated := false
	f.BeforeServe = func() {
		f.mu.Lock()
		last := f.paths[len(f.paths)-1]
		f.mu.Unlock()
		if !strings.HasSuffix(last, "/deployments/"+r.Scope.WorkloadName) {
			return
		}
		tx, err := p.db.BeginTx(t.Context(), nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer tx.Rollback()
		var id string
		for _, target := range []struct{ table, id string }{{"Organization", r.Scope.OrganizationID}, {"Project", r.Scope.ProjectID}, {"Service", r.ServiceID}, {"Deployment", r.DeploymentID}} {
			if err = tx.QueryRowContext(t.Context(), `SELECT id FROM "`+target.table+`" WHERE id=$1 FOR UPDATE NOWAIT`, target.id).Scan(&id); err != nil {
				t.Error("DB transaction held across Kubernetes request", err)
				return
			}
		}
		if _, err = tx.ExecContext(t.Context(), `UPDATE "Deployment" SET status='CANCELLED' WHERE id=$1`, r.DeploymentID); err != nil {
			t.Error(err)
			return
		}
		if err = tx.Commit(); err != nil {
			t.Error(err)
			return
		}
		mutated = true
	}
	f.server(t)
	source, err := kube.NewFromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	// When: a valid HTTP identity reaches an authority changed while reading Kubernetes.
	_, err = ingester.New(ingester.Config{}, source, p).RunOnce(t.Context(), time.Now().UTC())
	// Then: no parent lock spanned HTTP, and the transaction rejects changed lifecycle.
	if !mutated || !errors.Is(err, identity.ErrIdentity) || count(t, p.db, `SELECT count(*) FROM "RuntimeMetric" WHERE "deploymentId"=$1`, r.DeploymentID) != 0 {
		t.Fatalf("lifecycle recheck mutated=%t err=%v", mutated, err)
	}
	f.BeforeServe = nil
	f.capture(t)
}

func TestParentFirstLocksSerializeLifecycleRace(t *testing.T) {
	// Given: a parent mutation holds the service lock while ingestion starts.
	p, r := fixtureStore(t)
	gate, err := p.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Rollback()
	if _, err = gate.ExecContext(t.Context(), `UPDATE "Service" SET status='DELETING' WHERE id=$1`, r.ServiceID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := p.Insert(ctx, batchOf(r)); done <- err }()
	// Observe the real PostgreSQL lock wait, rather than guessing with sleeps.
	for {
		var waiting int
		if err = p.db.QueryRowContext(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%Service%FOR UPDATE%'`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if ctx.Err() != nil {
			t.Fatal(ctx.Err())
		}
	}
	var parentID string
	err = p.db.QueryRowContext(ctx, `SELECT id FROM "Organization" WHERE id=$1 FOR UPDATE NOWAIT`, r.Scope.OrganizationID).Scan(&parentID)
	if err == nil {
		t.Fatal("ingestion did not acquire organization before service")
	}
	// When: the concurrent lifecycle transition commits.
	if err = gate.Commit(); err != nil {
		t.Fatal(err)
	}
	// Then: the waiting ingester rechecks after locking, rejects, and persists nothing.
	if err = <-done; !errors.Is(err, identity.ErrIdentity) || count(t, p.db, `SELECT count(*) FROM "IngestionCursor" WHERE key=$1`, cursorKey(r)) != 0 {
		t.Fatalf("parent race err=%v", err)
	}
	t.Log("OBSERVABLE PostgreSQL service lock wait=1 organization NOWAIT denied=1 stale batch rows=0 cursors=0")
}

func TestFailedAndServingPreviewRemainObservable(t *testing.T) {
	for _, status := range []string{"DEPLOYING", "READY", "FAILED"} {
		t.Run(status, func(t *testing.T) {
			// Given: current lifecycle plus a newer preview candidate that does not request cleanup.
			p, r := fixtureStore(t)
			if _, err := p.db.ExecContext(t.Context(), `UPDATE "Deployment" SET status=$2,"deploymentType"='preview',"pullRequestNumber"=42 WHERE id=$1`, r.DeploymentID, status); err != nil {
				t.Fatal(err)
			}
			if _, err := p.db.ExecContext(t.Context(), `INSERT INTO "Deployment"(id,"serviceId","projectId",status,"deploymentType","pullRequestNumber","updatedAt") VALUES($1,$2,$3,'DEPLOYING','preview',42,now())`, r.DeploymentID+"-new", r.ServiceID, r.Scope.ProjectID); err != nil {
				t.Fatal(err)
			}
			// When: resolving the still-owned prior preview.
			scope, err := p.Resolve(t.Context(), r.DeploymentID)
			// Then: readiness/newer-candidate filters do not erase its diagnostic identity.
			if err != nil || !strings.HasPrefix(scope.WorkloadName, "pr-42-web-") {
				t.Fatalf("preview denied %#v %v", scope, err)
			}
		})
	}
}
