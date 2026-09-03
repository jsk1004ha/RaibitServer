package store_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/provisioner/internal/provider"
	"github.com/raibitserver/provisioner/internal/store"
)

func TestResourceCapabilityClaim(t *testing.T) {
	dsn := os.Getenv("RAIBITSERVER_TEST_POSTGRES_DSN")
	if dsn == "" {
		if os.Getenv("RAIBITSERVER_REQUIRE_POSTGRES_TESTS") == "1" {
			t.Fatal("RAIBITSERVER_TEST_POSTGRES_DSN is required")
		}
		t.Skip("NOT_RUN: requires disposable PostgreSQL fixture")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	suffix := fmt.Sprintf("task13-%d", time.Now().UnixNano())
	if _, err := db.ExecContext(ctx, `INSERT INTO "Organization" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,NOW())`, suffix); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := db.Exec(`DELETE FROM "Organization" WHERE id=$1`, suffix); err != nil {
			t.Error(err)
		}
	})
	if _, err := db.ExecContext(ctx, `INSERT INTO "Project" (id,"organizationId",name,slug,status,"updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE',NOW())`, suffix); err != nil {
		t.Fatal(err)
	}
	image := "registry.example.test/postgresql@sha256:" + strings.Repeat("a", 64)
	cases := []struct{ name, engine, intent, environment, image string }{
		{"preview", "postgresql", "preview-plan", "local", image},
		{"legacy", "postgresql", "", "", ""},
		{"unsupported", "qdrant", "live-provision", "local", image},
		{"sqlite", "sqlite", "live-provision", "local", ""},
		{"release", "postgresql", "live-provision", "release", image},
		{"missing-image", "mysql", "live-provision", "local", image},
	}
	for _, row := range cases {
		// Given forged or unavailable pending rows written by an old/hostile producer.
		execution := map[string]string{"intent": row.intent, "environment": row.environment, "image": row.image}
		state, err := json.Marshal(map[string]map[string]string{"resourceExecution": execution})
		if err != nil {
			t.Fatal(err)
		}
		id := suffix + "-" + row.name
		if _, err := db.ExecContext(ctx, `INSERT INTO "Resource" (id,"projectId",name,slug,type,engine,provider,plan,region,status,"desiredState","updatedAt") VALUES ($1,$2,$1,$1,'database',$3,'dedicated-local','shared-small','local','PROVISIONING',$4::jsonb,NOW())`, id, suffix, row.engine, state); err != nil {
			t.Fatal(err)
		}
	}
	state, closeStore, err := store.OpenPostgresStore(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := closeStore(); err != nil {
			t.Error(err)
		}
	}()
	for _, environment := range []string{"", "invalid"} {
		state.ConfigureResourceClaims(environment, map[string]string{"postgresql": image})
		if claimed, err := state.ClaimNextResource(ctx, time.Minute, 0); err == nil || claimed != nil {
			t.Fatalf("untrusted environment accepted: %q", environment)
		}
	}
	releaseImages, err := provider.EligibleResourceImages("release", map[string]string{"postgresql": image})
	if err != nil {
		t.Fatal(err)
	}
	state.ConfigureResourceClaims("release", releaseImages)
	if claimed, err := state.ClaimNextResource(ctx, time.Minute, 0); err != nil || claimed != nil {
		t.Fatalf("release claim must be unavailable: %v %v", claimed, err)
	}
	eligible, err := provider.EligibleResourceImages("local", map[string]string{"postgresql": image})
	if err != nil {
		t.Fatal(err)
	}
	state.ConfigureResourceClaims("local", eligible)
	// When the actual PostgreSQL selector and update run.
	claimed, err := state.ClaimNextResource(ctx, time.Minute, 0)
	// Then none of the unavailable rows was claimed or modified.
	if err != nil || claimed != nil {
		t.Fatalf("unavailable rows claimed: %v %v", claimed, err)
	}
	var changed int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM "Resource" WHERE "projectId"=$1 AND (status<>'PROVISIONING' OR "updatedAt"<>"createdAt")`, suffix).Scan(&changed); err != nil {
		t.Fatal(err)
	}
	if changed != 0 {
		t.Fatalf("unavailable rows mutated: %d", changed)
	}
	// Given one eligible local live request, then exactly it is claimable.
	execution, err := json.Marshal(map[string]map[string]string{"resourceExecution": {"intent": "live-provision", "environment": "local", "image": image}})
	if err != nil {
		t.Fatal(err)
	}
	id := suffix + "-eligible"
	if _, err := db.ExecContext(ctx, `INSERT INTO "Resource" (id,"projectId",name,slug,type,engine,provider,plan,region,status,"desiredState","updatedAt") VALUES ($1,$2,$1,$1,'database','postgresql','dedicated-local','shared-small','local','PROVISIONING',$3::jsonb,NOW())`, id, suffix, execution); err != nil {
		t.Fatal(err)
	}
	claimed, err = state.ClaimNextResource(ctx, time.Minute, 0)
	if err != nil || claimed == nil || claimed.ID != id || claimed.Status != store.StatusReconciling {
		t.Fatalf("eligible claim failed: %#v %v", claimed, err)
	}
	t.Logf("CLAIM_OUTCOME rejected=%d accepted=1 status=%s", len(cases), claimed.Status)
}
