package reconciler

import (
	"context"
	"testing"

	"github.com/raibitserver/provisioner/internal/store"
)

type recoveryPreparedStore struct{ *fakeStore }

func (s *recoveryPreparedStore) MarkResourceReady(context.Context, *store.Resource, string, string, string, []string, map[string]any) error {
	return store.ErrRecoveryPrepared
}

func TestRecoveryPreparedResultNeverReportsReady(t *testing.T) {
	// Given an ordinary provisioner whose durable store privately prepared a restore target.
	state := &recoveryPreparedStore{&fakeStore{resource: &store.Resource{ID: "recovery-target", ProjectID: "project", OrganizationID: "org", ProjectSlug: "demo", Name: "db", Slug: "db", Engine: "postgresql", Plan: "shared-small", Status: store.StatusProvisioning, ClaimToken: "claim"}}}
	runner := &fakeRunner{}
	// When the real ordinary reconciliation path reaches its publication hook.
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	// Then runtime preparation truthfully reports PROVISIONING, not READY or an error.
	if err != nil || result == nil || result.Status != store.StatusProvisioning {
		t.Fatalf("prepared result=%v err=%v", result, err)
	}
}
