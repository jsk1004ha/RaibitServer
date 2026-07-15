package store

import (
	"context"
	"database/sql"
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
