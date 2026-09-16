package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPostgresDeletionLeaseUsesStoredTimestamp(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("RAIBITSERVER_TEST_POSTGRES_DSN"))
	if dsn == "" {
		t.Skip("RAIBITSERVER_TEST_POSTGRES_DSN is not configured")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := sql.Open(postgresDriverName, dsn)
	if err != nil {
		t.Fatalf("open PostgreSQL test database: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("ping PostgreSQL test database: %v", err)
	}

	statements := []string{
		`CREATE TEMP TABLE "Project" (
            id text PRIMARY KEY,
            "organizationId" text NOT NULL,
            name text NOT NULL,
            slug text NOT NULL,
            status text NOT NULL,
            "deletionRequestedAt" timestamp(3),
            "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" timestamp(3) NOT NULL
        )`,
		`CREATE TEMP TABLE "Service" ("projectId" text NOT NULL)`,
		`CREATE TEMP TABLE "Resource" ("projectId" text NOT NULL)`,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("create isolated PostgreSQL fixture: %v", err)
		}
	}

	claimNow := time.Date(2026, time.July, 13, 1, 2, 3, 987654321, time.UTC)
	if _, err := db.ExecContext(ctx, `
INSERT INTO "Project" (id, "organizationId", name, slug, status, "deletionRequestedAt", "updatedAt")
VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		"precision-project", "precision-org", "Precision project", "precision-project",
		DeletionStatusDeleteRequested, claimNow.Add(-time.Minute), claimNow.Add(-time.Minute)); err != nil {
		t.Fatalf("seed PostgreSQL deletion fixture: %v", err)
	}

	store := NewPostgresStore(db)
	project, err := store.ClaimNextProjectDeletion(ctx, ClaimOptions{Now: claimNow, Lease: 15 * time.Minute})
	if err != nil || project == nil {
		t.Fatalf("claim PostgreSQL project deletion: project=%#v error=%v", project, err)
	}
	if project.UpdatedAt.Equal(claimNow) {
		t.Fatal("claim must use PostgreSQL's millisecond-normalized timestamp, not the nanosecond input")
	}
	if remainder := project.UpdatedAt.Nanosecond() % int(time.Millisecond); remainder != 0 {
		t.Fatalf("expected a TIMESTAMP(3) lease, got %s", project.UpdatedAt.Format(time.RFC3339Nano))
	}
	staleLease := project.DeletionLease()
	renewAt := claimNow.Add(time.Minute + 123*time.Microsecond)
	renewedLease, err := store.RenewProjectDeletionLease(ctx, staleLease, renewAt)
	if err != nil {
		t.Fatalf("renew PostgreSQL project deletion lease: %v", err)
	}
	if renewedLease.ClaimedAt.Equal(renewAt) || renewedLease.ClaimedAt.Nanosecond()%int(time.Millisecond) != 0 {
		t.Fatalf("renewal must return PostgreSQL's normalized timestamp: input=%s stored=%s", renewAt.Format(time.RFC3339Nano), renewedLease.ClaimedAt.Format(time.RFC3339Nano))
	}
	if err := store.FinalizeProjectDeletion(ctx, staleLease); !errors.Is(err, ErrDeletionLeaseLost) {
		t.Fatalf("stale deletion lease must be fenced after renewal, got %v", err)
	}
	if err := store.FinalizeProjectDeletion(ctx, renewedLease); err != nil {
		t.Fatalf("finalize with database-normalized deletion lease: %v", err)
	}

	var remaining int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM "Project" WHERE id = $1`, project.ID).Scan(&remaining); err != nil {
		t.Fatalf("query finalized PostgreSQL project: %v", err)
	}
	if remaining != 0 {
		t.Fatalf("expected finalized project to be deleted, got %d rows", remaining)
	}
}

func TestPostgresSnapshotQualification(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("RAIBITSERVER_SNAPSHOT_POSTGRES_DSN"))
	if dsn == "" {
		t.Skip("RAIBITSERVER_SNAPSHOT_POSTGRES_DSN is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := sql.Open(postgresDriverName, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := NewPostgresStore(db)
	// Given: an isolated database with the authoritative migrations already applied.
	for _, statement := range []string{
		`INSERT INTO "Organization" (id,name,slug,"updatedAt") VALUES ('snapshot-org','Snapshot','snapshot-org',CURRENT_TIMESTAMP)`,
		`INSERT INTO "Project" (id,"organizationId",name,slug,"updatedAt") VALUES ('snapshot-project','snapshot-org','Snapshot','snapshot-project',CURRENT_TIMESTAMP)`,
		`INSERT INTO "Service" (id,"projectId",name,slug,type,"sourceType",port,"updatedAt") VALUES ('snapshot-service','snapshot-project','web','web','web','image',3000,CURRENT_TIMESTAMP)`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	captured := `{"type":"worker","port":8081,"replicas":2,"command":["captured"],"env":{"MODE":"captured"},"status":"ACTIVE","id":"forged"}`
	for _, tc := range []struct {
		name     string
		snapshot string
		version  int
		lineaged bool
		valid    bool
	}{
		{"captured", captured, 1, true, true},
		{"legacy", "", 0, false, true},
		{"unknown-version", captured, 99, true, false},
		{"missing-lineaged", "", 0, true, false},
		{"null-lineaged", "null", 1, true, false},
		{"malformed", "[]", 1, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			trigger, sourceID, retryID := "manual", "", ""
			if tc.lineaged {
				trigger, sourceID, retryID = "ReTrY", "source", "retry-source"
			}
			if _, err := db.ExecContext(ctx, `INSERT INTO "Deployment" (id,"serviceId","projectId",status,"triggerType","desiredSpecSnapshot","snapshotVersion","sourceDeploymentId","retryOfDeploymentId","updatedAt") VALUES ($1,'snapshot-service','snapshot-project','IMAGE_READY',$2,NULLIF($3,'')::jsonb,NULLIF($4,0),NULLIF($5,''),NULLIF($6,''),CURRENT_TIMESTAMP)`, tc.name, trigger, tc.snapshot, tc.version, sourceID, retryID); err != nil {
				t.Fatal(err)
			}
			if _, err := db.ExecContext(ctx, `UPDATE "Service" SET port=9000,"desiredSpec"='{"command":["mutated"],"env":{"MODE":"mutated"}}'::jsonb WHERE id='snapshot-service'`); err != nil {
				t.Fatal(err)
			}
			// When: the real claim, lease and transition return paths decode PostgreSQL rows.
			claimed, err := s.ClaimNextDeployment(ctx, ClaimOptions{WorkerID: "snapshot-worker", Now: time.Now().UTC()})
			if err != nil || claimed == nil || claimed.ID != tc.name {
				t.Fatalf("claim: deployment=%#v err=%v", claimed, err)
			}
			live, err := s.GetService(ctx, "snapshot-service")
			if err != nil {
				t.Fatal(err)
			}
			view, viewErr := claimed.RuntimeService(live)
			if tc.valid {
				port := 8081
				if !tc.lineaged {
					port = 9000
				}
				if viewErr != nil || view.Port != port || view.ID != "snapshot-service" {
					t.Fatalf("runtime projection: view=%#v err=%v", view, viewErr)
				}
			} else if !errors.Is(viewErr, ErrDeploymentSnapshot) {
				t.Fatalf("invalid snapshot accepted: %v", viewErr)
			}
			stale := claimed.Lease()
			stale.Attempt++
			if err := s.RenewDeploymentLease(ctx, stale, time.Now().UTC()); !errors.Is(err, ErrDeploymentLeaseLost) {
				t.Fatalf("stale renew accepted: %v", err)
			}
			if _, err := s.TransitionDeployment(ctx, stale, map[string]any{"status": DeploymentStatusReady}); !errors.Is(err, ErrDeploymentLeaseLost) {
				t.Fatalf("stale transition accepted: %v", err)
			}
			if err := s.RenewDeploymentLease(ctx, claimed.Lease(), time.Now().UTC()); err != nil {
				t.Fatal(err)
			}
			updated, err := s.TransitionDeployment(ctx, claimed.Lease(), map[string]any{"status": DeploymentStatusFailed})
			if err != nil {
				t.Fatal(err)
			}
			// Then: nullable metadata, v1 JSON, lineage and lease fences survive both reads.
			for _, row := range []*Deployment{claimed, updated} {
				if row.SnapshotVersion != tc.version || row.SourceDeploymentID != sourceID || row.RetryOfDeploymentID != retryID || row.TriggerType != trigger || row.ReconcileAttempts != 1 {
					t.Fatalf("metadata mismatch: %#v", row)
				}
				if tc.snapshot != "" && !json.Valid(row.DesiredSpecSnapshot) {
					t.Fatal("stored JSON snapshot lost")
				}
			}
		})
	}
	// Given: a captured ACTIVE snapshot precedes a live parent tombstone.
	if _, err := db.ExecContext(ctx, `INSERT INTO "Deployment" (id,"serviceId","projectId",status,"desiredSpecSnapshot","snapshotVersion","updatedAt") VALUES ('deletion','snapshot-service','snapshot-project','IMAGE_READY',$1::jsonb,1,CURRENT_TIMESTAMP)`, captured); err != nil {
		t.Fatal(err)
	}
	claimed, err := s.ClaimNextDeployment(ctx, ClaimOptions{WorkerID: "deletion-worker", Now: time.Now().UTC()})
	if err != nil || claimed == nil {
		t.Fatalf("claim before deletion: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE "Service" SET status='DELETE_REQUESTED' WHERE id='snapshot-service'`); err != nil {
		t.Fatal(err)
	}
	// When / Then: live deletion vetoes READY and later claims, regardless of snapshot.
	if _, err := s.TransitionDeployment(ctx, claimed.Lease(), map[string]any{"status": DeploymentStatusReady}); !errors.Is(err, ErrDeploymentLeaseLost) {
		t.Fatalf("deleted parent accepted READY: %v", err)
	}
	deleting, err := s.ParentsDeleting(ctx, "snapshot-project", "snapshot-service")
	if err != nil || !deleting {
		t.Fatalf("parent tombstone hidden: %v", err)
	}
	next, err := s.ClaimNextDeployment(ctx, ClaimOptions{WorkerID: "other", Now: time.Now().UTC().Add(time.Hour)})
	if err != nil || next != nil {
		t.Fatalf("deleted parent accepted claim: deployment=%#v err=%v", next, err)
	}
}
