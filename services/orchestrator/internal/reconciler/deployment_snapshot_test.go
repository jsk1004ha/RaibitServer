package reconciler

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/raibitserver/orchestrator/internal/store"
)

func TestSnapshotInvalidStoredLineageStopsBeforeKubectl(t *testing.T) {
	// Given: a valid digest would otherwise permit this real-mode apply.
	stateFile := writeState(t, map[string]any{
		"projects":    []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "slug": "demo", "status": "ACTIVE"}},
		"services":    []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "slug": "web", "type": "web", "status": "ACTIVE"}},
		"deployments": []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "IMAGE_READY", "triggerType": "retry", "sourceDeploymentId": "old", "imageUrl": "registry.local/app:release", "imageDigest": "sha256:" + strings.Repeat("a", 64)}},
	})
	runner := &fakeRunner{}
	r := NewServiceReconcilerWithStore(Config{DryRun: false, OutputDir: t.TempDir()}, store.NewFileStore(stateFile), runner)
	// When
	result, err := r.RunOnceResult(context.Background())
	// Then
	if err == nil || result.Status != store.DeploymentStatusFailed || len(runner.commands) != 0 || result.ManifestFile != "" {
		t.Fatalf("invalid snapshot reached execution: result=%#v err=%v commands=%v", result, err, runner.commands)
	}
}

func TestSnapshotLiveParentDeletionStillBlocksReady(t *testing.T) {
	// Given: captured ACTIVE status cannot override a new live tombstone.
	state := map[string]any{
		"projects":    []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "slug": "demo", "status": "ACTIVE"}},
		"services":    []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "slug": "web", "type": "web", "status": "ACTIVE"}},
		"deployments": []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "IMAGE_READY", "snapshotVersion": 1, "desiredSpecSnapshot": map[string]any{"type": "worker", "status": "ACTIVE"}, "imageUrl": "registry.local/app:release", "imageDigest": "sha256:" + strings.Repeat("a", 64)}},
	}
	stateFile := writeState(t, state)
	runner := &fakeRunner{onRun: func(commandText string) {
		if !strings.Contains(commandText, "rollout status") {
			return
		}
		current := readState(t, stateFile)
		firstByID(t, current, "services", "svc_1")["status"] = store.DeletionStatusDeleteRequested
		payload, err := json.Marshal(current)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(stateFile, payload, 0o600); err != nil {
			t.Fatal(err)
		}
	}}
	r := NewServiceReconcilerWithStore(Config{DryRun: false, OutputDir: t.TempDir()}, store.NewFileStore(stateFile), runner)
	// When
	result, err := r.RunOnceResult(context.Background())
	// Then
	if err == nil || result.Status == store.DeploymentStatusReady || firstByID(t, readState(t, stateFile), "deployments", "dep_1")["status"] == store.DeploymentStatusReady {
		t.Fatalf("snapshot resurrected deleted parent: result=%#v err=%v", result, err)
	}
}
