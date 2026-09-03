package reconciler

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/raibitserver/provisioner/internal/store"
)

var errProvenanceLeaseLost = errors.New("provenance test claim lease lost")

func provenanceAssertPostgresFence(t *testing.T, db *sql.DB, record []byte) {
	t.Helper()
	// Given an actual persisted resource claim that a competing write invalidates.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	state, closeStore, err := store.OpenPostgresStore(ctx, os.Getenv("RAIBITSERVER_PROVENANCE_POSTGRES_DSN"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := closeStore(); err != nil {
			t.Error(err)
		}
	}()
	if _, err := db.ExecContext(ctx, `UPDATE "Resource" SET "updatedAt"=(clock_timestamp() AT TIME ZONE 'UTC') - interval '10 minutes' WHERE id='provenance-resource'`); err != nil {
		t.Fatal(err)
	}
	resource, err := state.ClaimNextReadyResource(ctx, time.Second)
	if err != nil || resource == nil {
		t.Fatalf("claim=%#v err=%v", resource, err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE "Resource" SET "updatedAt"="updatedAt" + interval '1 second' WHERE id='provenance-resource'`); err != nil {
		t.Fatal(err)
	}
	desired := mergeState(resource.DesiredState, map[string]any{"providerImageProvenance": map[string]any{"image": "forged-stale-image"}})
	// When the stale claim attempts an atomic READY/provenance write.
	err = state.MarkResourceReady(ctx, resource, resource.Provider, resource.ConnectionSecretName, "fixture:5432", nil, desired)
	// Then the actual database rejects both READY and the forged provenance.
	if err == nil {
		t.Fatal("stale PostgreSQL READY claim was accepted")
	}
	var status string
	var persisted []byte
	if err := db.QueryRowContext(ctx, `SELECT status,"desiredState"->'providerImageProvenance' FROM "Resource" WHERE id='provenance-resource'`).Scan(&status, &persisted); err != nil {
		t.Fatal(err)
	}
	if status != "RECONCILING" || !bytes.Equal(record, persisted) {
		t.Fatalf("stale publication changed state: %s %s", status, persisted)
	}
	if err := os.WriteFile(filepath.Join(os.Getenv("RAIBITSERVER_PROVENANCE_FIXTURE_DIR"), "lease-fence-persisted.json"), persisted, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Log("PostgreSQL stale claim rejected READY and preserved original applied provenance")
}

type provenanceFencedStore struct {
	fakeStore
	expired   bool
	failReady bool
}

func (s *provenanceFencedStore) RenewResourceClaim(ctx context.Context, resource *store.Resource) error {
	if s.expired {
		return errProvenanceLeaseLost
	}
	return s.fakeStore.RenewResourceClaim(ctx, resource)
}

func (s *provenanceFencedStore) MarkResourceReady(ctx context.Context, resource *store.Resource, provider, secretName, endpoint string, keys []string, desiredState map[string]any) error {
	if s.expired || s.failReady {
		return errProvenanceLeaseLost
	}
	return s.fakeStore.MarkResourceReady(ctx, resource, provider, secretName, endpoint, keys, desiredState)
}

func TestProvenanceLeaseLossNeverPublishesObservedRecord(t *testing.T) {
	for _, scenario := range []string{"after-apply", "before-ready"} {
		t.Run(scenario, func(t *testing.T) {
			// Given valid workload evidence and a claim that expires before publication.
			resource, config, object := provenanceFixture(t)
			state := &provenanceFencedStore{fakeStore: fakeStore{resource: resource}, failReady: scenario == "before-ready"}
			runner := &provenanceRunner{applied: provenanceJSON(t, object), observed: provenanceJSON(t, object)}
			if scenario == "after-apply" {
				runner.afterApply = func() { state.expired = true }
			}
			// When the reconciler tries to observe and commit READY.
			_, err := New(config, state, runner).RunOnce(context.Background())
			// Then the store's claim fence rejects publication without mutating provenance.
			if !errors.Is(err, errProvenanceLeaseLost) || state.readyTransitions != 0 || state.lastDesiredState["providerImageProvenance"] != nil || resource.DesiredState["providerImageProvenance"] != nil {
				t.Fatalf("unfenced publication: err=%v state=%#v", err, state.lastDesiredState)
			}
		})
	}
}

func TestProvenanceDryRunNeverCreatesOrRewritesEvidence(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(map[bool]string{false: "missing", true: "existing"}[existing], func(t *testing.T) {
			// Given a dry-run with either no evidence or an old opaque record.
			resource, config, _ := provenanceFixture(t)
			config.DryRun = true
			resource.DesiredState = map[string]any{}
			if existing {
				resource.DesiredState["providerImageProvenance"] = map[string]any{"image": "old-record"}
			}
			before := provenanceJSON(t, resource.DesiredState["providerImageProvenance"])
			state := &fakeStore{resource: resource}
			// When the dry-run generates its plan.
			result, err := New(config, state, &fakeRunner{}).RunOnce(context.Background())
			// Then evidence remains exactly as before and the resource remains provisioning.
			if err != nil || result.Status != store.StatusProvisioning || !reflect.DeepEqual(before, provenanceJSON(t, state.lastDesiredState["providerImageProvenance"])) {
				t.Fatalf("dry-run changed provenance: result=%#v err=%v", result, err)
			}
		})
	}
}
