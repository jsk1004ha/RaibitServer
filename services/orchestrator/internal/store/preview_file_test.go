package store

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPreviewRoutePromotion_swaps_pointer_and_only_retires_prior_ready(t *testing.T) {
	// Given
	path := writePreviewState(t, map[string]any{
		"previewLineages": []any{map[string]any{"id": "lineage-1", "organizationId": "org-1", "projectId": "project-1", "serviceId": "service-1", "state": PreviewStateOpen, "version": 3, "namespace": "org-demo", "routeName": "preview-route", "stableHost": "preview--pr-1--org--demo.example.test", "candidateDeploymentId": "candidate", "candidateGeneration": 2, "currentDeploymentId": "current", "currentGeneration": 1}},
		"deployments": []any{
			map[string]any{"id": "candidate", "projectId": "project-1", "serviceId": "service-1", "status": DeploymentStatusReady, "publicHealthStatus": "HEALTHY", "previewLineageId": "lineage-1", "previewGeneration": 2},
			map[string]any{"id": "current", "projectId": "project-1", "serviceId": "service-1", "status": DeploymentStatusReady, "publicHealthStatus": "HEALTHY", "previewLineageId": "lineage-1", "previewGeneration": 1},
			map[string]any{"id": "foreign", "projectId": "project-1", "serviceId": "service-1", "status": DeploymentStatusReady},
		},
	})
	state := NewFileStore(path)
	at := time.Date(2026, 9, 4, 1, 2, 3, 0, time.UTC)
	work, err := state.ClaimNextPreviewRoute(context.Background(), ClaimOptions{WorkerID: "worker-1", Lease: time.Minute, Now: at})
	if err != nil || work == nil {
		t.Fatalf("claim=%#v err=%v", work, err)
	}
	intent := PreviewRouteIntent{Version: 1, LineageVersion: 3, Operation: PreviewPromote, DeploymentID: "candidate", Generation: 2, Token: work.Lease.Token, Namespace: "org-demo", Name: "preview-route"}
	if err := state.SetPreviewRouteIntent(context.Background(), work.Lease, intent); err != nil {
		t.Fatal(err)
	}

	// When
	err = state.CompletePreviewRoute(context.Background(), work.Lease, PreviewRouteObserved{Version: 1, LineageVersion: 3, DeploymentID: "candidate", Generation: 2, Namespace: "org-demo", Name: "preview-route", UID: "route-uid", ResourceVersion: "12", ObservedAt: at.Add(time.Second)})

	// Then
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	var got map[string]any
	_ = json.Unmarshal(raw, &got)
	lineage := got["previewLineages"].([]any)[0].(map[string]any)
	deployments := got["deployments"].([]any)
	if lineage["currentDeploymentId"] != "candidate" || lineage["candidateDeploymentId"] != nil || deployments[1].(map[string]any)["status"] != DeploymentStatusCleanupRequested || deployments[2].(map[string]any)["status"] != DeploymentStatusReady {
		t.Fatalf("state=%#v", got)
	}
}

func TestPreviewHealthCurrent_uses_candidate_and_current_slots_not_newest_attempt(t *testing.T) {
	// Given
	state := map[string]any{
		"previewLineages": []any{map[string]any{"id": "lineage-1", "state": PreviewStateOpen, "version": 3, "candidateDeploymentId": "candidate", "candidateGeneration": 2, "currentDeploymentId": "current", "currentGeneration": 1}},
		"services":        []any{map[string]any{"id": "service-1", "projectId": "project-1", "status": "ACTIVE"}},
		"projects":        []any{map[string]any{"id": "project-1", "status": "ACTIVE"}},
		"deployments": []any{
			previewHealthDeployment("current", 1, 11, "2026-09-04T00:00:00Z"),
			previewHealthDeployment("candidate", 2, 12, "2026-09-04T00:01:00Z"),
		},
	}

	// When / Then
	for _, deploymentID := range []string{"current", "candidate"} {
		if !currentFileObservation(state, HealthObservation{DeploymentID: deploymentID, ProjectID: "project-1", ServiceID: "service-1", RolloutAttempt: 1, ObservedGeneration: map[string]int{"current": 11, "candidate": 12}[deploymentID]}) {
			t.Fatalf("slot %s was incorrectly treated as stale", deploymentID)
		}
	}
}

func previewHealthDeployment(id string, generation, observedGeneration int, createdAt string) map[string]any {
	return map[string]any{
		"id": id, "projectId": "project-1", "serviceId": "service-1", "status": DeploymentStatusReady, "deploymentType": "preview",
		"previewLineageId": "lineage-1", "previewGeneration": generation, "reconcileAttempts": 1, "observedGeneration": observedGeneration, "createdAt": createdAt,
		"previewRuntime": map[string]any{"version": 1, "lineageId": "lineage-1", "deploymentId": id, "generation": generation, "lineageVersion": 3, "stableHost": "preview--pr-1--org--demo.example.test", "probeHost": "preview--probe-0123456789abcdef0123456789abcdef.example.test", "namespace": "org-demo", "workloadName": id + "-web", "serviceName": id + "-web", "probeIngressName": id + "-web", "routeName": "preview-route"},
	}
}

func writePreviewState(t *testing.T, state map[string]any) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state.json")
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
