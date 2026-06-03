package reconciler

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/orchestrator/internal/command"
	"github.com/raibitserver/orchestrator/internal/store"
)

func TestRunOnceHonorsContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	r := NewServiceReconciler(Config{DryRun: true})
	if _, err := r.RunOnceResult(ctx); err != context.Canceled {
		t.Fatalf("expected context cancellation, got %v", err)
	}
}

func TestRunOnceDryRunCompletesWithoutExternalSideEffects(t *testing.T) {
	r := NewServiceReconciler(Config{DryRun: true})
	result, err := r.RunOnceResult(context.Background())
	if err != nil {
		t.Fatalf("expected dry-run reconcile to complete: %v", err)
	}
	if result.Processed != 0 || result.Reason != "no-control-plane-store" {
		t.Fatalf("unexpected dry-run result: %#v", result)
	}
}

func TestRunOnceAppliesImageReadyDeploymentAndPersistsReadyState(t *testing.T) {
	stateFile := writeState(t, map[string]any{
		"projects": []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "name": "Demo", "slug": "demo"}},
		"services": []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "web", "slug": "web", "type": "web", "port": 8080}},
		"deployments": []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "IMAGE_READY", "deploymentType": "production", "imageUrl": "registry.local/demo/web:abc123", "imageDigest": "sha256:abc123"}},
	})
	runner := &fakeRunner{}
	r := NewServiceReconcilerWithStore(Config{DryRun: true, OutputDir: t.TempDir(), BaseDomain: "test.local", Timeout: time.Minute}, store.NewFileStore(stateFile), runner)
	result, err := r.RunOnceResult(context.Background())
	if err != nil {
		t.Fatalf("RunOnceResult failed: %v", err)
	}
	if result.Status != store.DeploymentStatusReady || result.ManifestFile == "" {
		t.Fatalf("unexpected result: %#v", result)
	}
	manifest, err := os.ReadFile(result.ManifestFile)
	if err != nil {
		t.Fatal(err)
	}
	text := string(manifest)
	if !strings.Contains(text, "registry.local/demo/web:abc123") || !strings.Contains(text, "NetworkPolicy") || !strings.Contains(text, "Ingress") || !strings.Contains(text, "org-1-demo.apps.test.local") {
		t.Fatalf("manifest missing expected workload pieces: %s", text)
	}
	state := readState(t, stateFile)
	deployment := firstByID(t, state, "deployments", "dep_1")
	if deployment["status"] != store.DeploymentStatusReady {
		t.Fatalf("deployment not ready: %#v", deployment)
	}
	logs := marshalString(t, state["runtimeLogs"])
	if !strings.Contains(logs, "kubectl apply") || !strings.Contains(logs, "rollout status") {
		t.Fatalf("runtime logs missing kubectl commands: %s", logs)
	}
	events := marshalString(t, state["deploymentEvents"])
	if !strings.Contains(events, "rollout.ready") {
		t.Fatalf("deployment events missing rollout.ready: %s", events)
	}
}

func TestRunOnceCleansPreviewDeployment(t *testing.T) {
	stateFile := writeState(t, map[string]any{
		"projects": []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "name": "Demo", "slug": "demo"}},
		"services": []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "web", "slug": "web", "type": "web", "port": 8080}},
		"deployments": []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "PREVIEW_CLEANUP_REQUESTED", "deploymentType": "preview", "pullRequestNumber": 42, "imageUrl": "registry.local/demo/web:pr42"}},
	})
	runner := &fakeRunner{}
	r := NewServiceReconcilerWithStore(Config{DryRun: true, OutputDir: t.TempDir(), BaseDomain: "test.local"}, store.NewFileStore(stateFile), runner)
	result, err := r.RunOnceResult(context.Background())
	if err != nil {
		t.Fatalf("cleanup failed: %v", err)
	}
	if result.Status != store.DeploymentStatusCleanedUp || !strings.Contains(strings.Join(result.Commands, "\n"), "kubectl delete") {
		t.Fatalf("unexpected cleanup result: %#v", result)
	}
	manifest, err := os.ReadFile(result.ManifestFile)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(manifest), "pr-42-web") || !strings.Contains(string(manifest), "pr-42-org-1-demo.preview.test.local") || !strings.Contains(string(manifest), "raibitserver.io/preview") {
		t.Fatalf("preview cleanup manifest must target isolated preview workload: %s", string(manifest))
	}
	deployment := firstByID(t, readState(t, stateFile), "deployments", "dep_1")
	if deployment["status"] != store.DeploymentStatusCleanedUp {
		t.Fatalf("deployment not cleaned up: %#v", deployment)
	}
}

type fakeRunner struct{}

func (f *fakeRunner) Run(ctx context.Context, spec command.Command, dryRun bool, timeout time.Duration) (command.Result, error) {
	return command.Result{Command: command.CommandString(spec), DryRun: dryRun, ExitCode: 0, Stdout: "ok\n"}, nil
}

func writeState(t *testing.T, state map[string]any) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state.json")
	bytes, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, bytes, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func readState(t *testing.T, path string) map[string]any {
	t.Helper()
	bytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err := json.Unmarshal(bytes, &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func firstByID(t *testing.T, state map[string]any, key, id string) map[string]any {
	t.Helper()
	for _, item := range state[key].([]any) {
		row, ok := item.(map[string]any)
		if ok && row["id"] == id {
			return row
		}
	}
	t.Fatalf("%s %s not found", key, id)
	return nil
}

func marshalString(t *testing.T, value any) string {
	t.Helper()
	bytes, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(bytes)
}
