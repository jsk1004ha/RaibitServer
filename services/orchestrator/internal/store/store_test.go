package store

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStaleDeploymentClaimsPreserveCleanupAndRollbackActions(t *testing.T) {
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	for _, action := range []string{DeploymentActionCleanup, DeploymentActionRollback} {
		t.Run(action, func(t *testing.T) {
			path := writeStoreState(t, map[string]any{
				"projects": []any{map[string]any{"id": "project-1", "status": "ACTIVE"}},
				"services": []any{map[string]any{"id": "svc-1", "projectId": "project-1", "status": "READY"}},
				"deployments": []any{map[string]any{
					"id": "dep-1", "serviceId": "svc-1", "projectId": "project-1", "status": DeploymentStatusDeploying,
					"reconcileAction": action, "reconcileLockedBy": "worker-a", "reconcileLockedAt": base.Format(time.RFC3339Nano), "reconcileAttempts": 1,
				}}})
			claimed, err := NewFileStore(path).ClaimNextDeployment(context.Background(), ClaimOptions{WorkerID: "worker-b", Lease: time.Second, Now: base.Add(2 * time.Second)})
			if err != nil {
				t.Fatal(err)
			}
			if claimed == nil || claimed.ReconcileAction != action || claimed.ReconcileLockedBy != "worker-b" || claimed.ReconcileAttempts != 2 {
				t.Fatalf("stale %s claim lost its action or ownership: %#v", action, claimed)
			}
		})
	}
}

func TestDeploymentLeaseRenewalAndAttemptFencing(t *testing.T) {
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	path := writeStoreState(t, map[string]any{
		"projects": []any{map[string]any{"id": "project-1", "status": "ACTIVE"}},
		"services": []any{map[string]any{"id": "svc-1", "projectId": "project-1", "status": "READY"}},
		"deployments": []any{map[string]any{
			"id": "dep-1", "serviceId": "svc-1", "projectId": "project-1", "status": DeploymentStatusCleanupRequested,
		}}})
	state := NewFileStore(path)
	first, err := state.ClaimNextDeployment(context.Background(), ClaimOptions{WorkerID: "worker-a", Lease: 3 * time.Second, Now: base})
	if err != nil || first == nil {
		t.Fatalf("initial claim failed: %#v %v", first, err)
	}
	if first.ReconcileAction != DeploymentActionCleanup {
		t.Fatalf("cleanup request must persist cleanup action: %#v", first)
	}
	if err := state.RenewDeploymentLease(context.Background(), first.Lease(), base.Add(2*time.Second)); err != nil {
		t.Fatalf("lease renewal failed: %v", err)
	}
	if reclaimed, err := state.ClaimNextDeployment(context.Background(), ClaimOptions{WorkerID: "worker-b", Lease: 3 * time.Second, Now: base.Add(4 * time.Second)}); err != nil || reclaimed != nil {
		t.Fatalf("renewed lease must not be reclaimed: %#v %v", reclaimed, err)
	}
	second, err := state.ClaimNextDeployment(context.Background(), ClaimOptions{WorkerID: "worker-b", Lease: 3 * time.Second, Now: base.Add(6 * time.Second)})
	if err != nil || second == nil {
		t.Fatalf("expired lease must be reclaimable: %#v %v", second, err)
	}
	if _, err := state.TransitionDeployment(context.Background(), first.Lease(), map[string]any{"status": DeploymentStatusCleanedUp}); !errors.Is(err, ErrDeploymentLeaseLost) {
		t.Fatalf("stale owner transition must be fenced, got %v", err)
	}
	if _, err := state.TransitionDeployment(context.Background(), second.Lease(), map[string]any{"status": DeploymentStatusCleanedUp}); err != nil {
		t.Fatalf("current owner transition failed: %v", err)
	}
}

func TestFileStoreDeletionClaimsAndFinalizersAreFenced(t *testing.T) {
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	path := writeStoreState(t, map[string]any{
		"projects":    []any{map[string]any{"id": "project-1", "organizationId": "org-1", "slug": "demo", "status": DeletionStatusDeleteRequested, "updatedAt": base.Format(time.RFC3339Nano)}},
		"services":    []any{map[string]any{"id": "svc-1", "projectId": "project-1", "slug": "web", "status": DeletionStatusDeleting, "updatedAt": base.Format(time.RFC3339Nano)}},
		"deployments": []any{map[string]any{"id": "dep-1", "serviceId": "svc-1", "projectId": "project-1", "status": "CANCELLED"}},
	})
	state := NewFileStore(path)
	service, err := state.ClaimNextServiceDeletion(context.Background(), ClaimOptions{Lease: time.Second, Now: base.Add(2 * time.Second)})
	if err != nil || service == nil || service.Status != DeletionStatusDeleting || !service.UpdatedAt.Equal(base.Add(2*time.Second)) {
		t.Fatalf("stale service deletion claim failed: %#v %v", service, err)
	}
	if err := state.FinalizeServiceDeletion(context.Background(), service.DeletionLease()); err != nil {
		t.Fatalf("service finalization failed: %v", err)
	}
	project, err := state.ClaimNextProjectDeletion(context.Background(), ClaimOptions{Lease: time.Second, Now: base.Add(3 * time.Second)})
	if err != nil || project == nil {
		t.Fatalf("child-free project deletion claim failed: %#v %v", project, err)
	}
	if err := state.FinalizeProjectDeletion(context.Background(), project.DeletionLease()); err != nil {
		t.Fatalf("project finalization failed: %v", err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(contents), `"svc-1"`) || strings.Contains(string(contents), `"project-1"`) {
		t.Fatalf("finalized tombstones remain in state: %s", contents)
	}
}

func TestFileStoreDeletionLeaseRenewalFencesStaleOwners(t *testing.T) {
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	path := writeStoreState(t, map[string]any{
		"projects": []any{
			map[string]any{"id": "project-1", "organizationId": "org-1", "slug": "demo", "status": DeletionStatusDeleteRequested, "updatedAt": base.Format(time.RFC3339Nano)},
			map[string]any{"id": "project-2", "organizationId": "org-1", "slug": "empty", "status": DeletionStatusDeleteRequested, "updatedAt": base.Format(time.RFC3339Nano)},
		},
		"services": []any{
			map[string]any{"id": "svc-1", "projectId": "project-1", "slug": "web", "status": DeletionStatusDeleteRequested, "updatedAt": base.Format(time.RFC3339Nano)},
		},
		"deployments": []any{},
		"resources":   []any{},
	})
	state := NewFileStore(path)

	service, err := state.ClaimNextServiceDeletion(context.Background(), ClaimOptions{Lease: time.Second, Now: base.Add(time.Second)})
	if err != nil || service == nil {
		t.Fatalf("claim service deletion: service=%#v error=%v", service, err)
	}
	staleServiceLease := service.DeletionLease()
	serviceLease, err := state.RenewServiceDeletionLease(context.Background(), staleServiceLease, base.Add(2*time.Second))
	if err != nil {
		t.Fatalf("renew service deletion lease: %v", err)
	}
	if err := state.FinalizeServiceDeletion(context.Background(), staleServiceLease); !errors.Is(err, ErrDeletionLeaseLost) {
		t.Fatalf("stale service owner must be fenced, got %v", err)
	}
	if err := state.FinalizeServiceDeletion(context.Background(), serviceLease); err != nil {
		t.Fatalf("renewed service owner must finalize: %v", err)
	}

	project, err := state.ClaimNextProjectDeletion(context.Background(), ClaimOptions{Lease: time.Second, Now: base.Add(3 * time.Second)})
	if err != nil || project == nil {
		t.Fatalf("claim project deletion: project=%#v error=%v", project, err)
	}
	staleProjectLease := project.DeletionLease()
	projectLease, err := state.RenewProjectDeletionLease(context.Background(), staleProjectLease, base.Add(4*time.Second))
	if err != nil {
		t.Fatalf("renew project deletion lease: %v", err)
	}
	if err := state.FinalizeProjectDeletion(context.Background(), staleProjectLease); !errors.Is(err, ErrDeletionLeaseLost) {
		t.Fatalf("stale project owner must be fenced, got %v", err)
	}
	if err := state.FinalizeProjectDeletion(context.Background(), projectLease); err != nil {
		t.Fatalf("renewed project owner must finalize: %v", err)
	}
}

func TestFileStoreBlocksDeploymentClaimAndReadyTransitionDuringParentDeletion(t *testing.T) {
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	path := writeStoreState(t, map[string]any{
		"projects":    []any{map[string]any{"id": "project-1", "status": "ACTIVE"}},
		"services":    []any{map[string]any{"id": "svc-1", "projectId": "project-1", "status": DeletionStatusDeleteRequested}},
		"deployments": []any{map[string]any{"id": "dep-1", "serviceId": "svc-1", "projectId": "project-1", "status": DeploymentStatusImageReady}},
	})
	state := NewFileStore(path)
	if claimed, err := state.ClaimNextDeployment(context.Background(), ClaimOptions{Now: base}); err != nil || claimed != nil {
		t.Fatalf("deployment beneath deleting service must not be claimed: %#v %v", claimed, err)
	}

	path = writeStoreState(t, map[string]any{
		"projects":    []any{map[string]any{"id": "project-1", "status": "ACTIVE"}},
		"services":    []any{map[string]any{"id": "svc-1", "projectId": "project-1", "status": "READY"}},
		"deployments": []any{map[string]any{"id": "dep-1", "serviceId": "svc-1", "projectId": "project-1", "status": DeploymentStatusImageReady}},
	})
	state = NewFileStore(path)
	claimed, err := state.ClaimNextDeployment(context.Background(), ClaimOptions{WorkerID: "worker-a", Now: base})
	if err != nil || claimed == nil {
		t.Fatalf("active parent deployment claim failed: %#v %v", claimed, err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(contents, &raw); err != nil {
		t.Fatal(err)
	}
	raw["services"].([]any)[0].(map[string]any)["status"] = DeletionStatusDeleting
	payload, _ := json.Marshal(raw)
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := state.TransitionDeployment(context.Background(), claimed.Lease(), map[string]any{"status": DeploymentStatusReady}); !errors.Is(err, ErrParentDeletionRequested) {
		t.Fatalf("READY transition must be fenced after a parent tombstone, got %v", err)
	}
}

func TestFileStoreLoadsOrganizationSlug(t *testing.T) {
	path := writeStoreState(t, map[string]any{
		"organizations": []any{map[string]any{"id": "organization-cuid", "slug": "gdg-hongik"}},
		"projects":      []any{map[string]any{"id": "project-1", "organizationId": "organization-cuid", "slug": "festival-2026", "status": "ACTIVE"}},
	})
	state := NewFileStore(path)
	project, err := state.GetProject(context.Background(), "project-1")
	if err != nil || project.OrganizationSlug != "gdg-hongik" {
		t.Fatalf("file store must resolve organization slug: %#v %v", project, err)
	}
}

func writeStoreState(t *testing.T, state map[string]any) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state.json")
	payload, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
