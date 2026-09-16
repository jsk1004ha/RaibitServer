package reconciler

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/raibitserver/orchestrator/internal/store"
)

func TestHealthHappyRolloutEnqueuesSeparateUnknownObservation(t *testing.T) {
	// Given: the command fixture reports an actual owned generation unrelated to attempt=1.
	file := healthState(t)
	runner := &fakeRunner{stdoutFor: healthCommandJSON}
	r := NewServiceReconcilerWithStore(Config{OutputDir: t.TempDir()}, store.NewFileStore(file), runner)
	// When
	result, err := r.RunOnceResult(context.Background())
	// Then
	if err != nil || result.Status != "READY" {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	state := readState(t, file)
	row := firstByID(t, state, "deployments", "dep_1")
	if row["observedGeneration"] != float64(17) || row["publicHealthStatus"] != "UNKNOWN" {
		t.Fatalf("health initialization: %#v", row)
	}
	jobs, ok := state["workflowJobs"].([]any)
	if !ok || len(jobs) != 1 {
		t.Fatalf("atomic health job missing: %#v", state["workflowJobs"])
	}
	job := jobs[0].(map[string]any)
	if job["type"] != "public-health-observe" || job["status"] != "queued" {
		t.Fatalf("wrong health job: %#v", job)
	}
}

func TestHealthFailureMatrixUnownedGenerationPreventsReady(t *testing.T) {
	// Given
	file := healthState(t)
	runner := &fakeRunner{stdoutFor: func(cmd string) string { return strings.ReplaceAll(healthCommandJSON(cmd), "dep_1", "other-owner") }}
	r := NewServiceReconcilerWithStore(Config{OutputDir: t.TempDir()}, store.NewFileStore(file), runner)
	// When
	result, err := r.RunOnceResult(context.Background())
	// Then
	if err == nil || result == nil || result.Status != "FAILED" {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	row := firstByID(t, readState(t, file), "deployments", "dep_1")
	if row["status"] == "READY" || row["observedGeneration"] != nil {
		t.Fatalf("unowned observation persisted: %#v", row)
	}
}

func TestHealthHappyDryRunNeverObservesOrEnqueues(t *testing.T) {
	// Given
	file := healthState(t)
	runner := &fakeRunner{}
	r := NewServiceReconcilerWithStore(Config{DryRun: true, OutputDir: t.TempDir()}, store.NewFileStore(file), runner)
	// When
	_, err := r.RunOnceResult(context.Background())
	// Then
	if err != nil {
		t.Fatal(err)
	}
	state := readState(t, file)
	row := firstByID(t, state, "deployments", "dep_1")
	if row["observedGeneration"] != nil {
		t.Fatalf("dryrun observed generation: %#v", row)
	}
	for _, cmd := range runner.commands {
		if strings.Contains(cmd, "get deployment/") {
			t.Fatalf("dryrun queried actual generation: %s", cmd)
		}
	}
	if jobs, ok := state["workflowJobs"].([]any); ok && len(jobs) != 0 {
		t.Fatalf("dryrun queued health: %#v", jobs)
	}
}

func healthState(t *testing.T) string {
	t.Helper()
	return writeState(t, map[string]any{
		"projects":    []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "slug": "demo", "status": "ACTIVE"}},
		"services":    []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "slug": "web", "type": "web", "status": "ACTIVE", "desiredSpec": map[string]any{"readinessPath": "/ready"}}},
		"deployments": []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "IMAGE_READY", "imageUrl": "registry.local/app:release", "imageDigest": "sha256:" + strings.Repeat("a", 64)}},
	})
}

func healthCommandJSON(cmd string) string {
	if !strings.Contains(cmd, "get deployment/") {
		return "ok"
	}
	row := map[string]any{"apiVersion": "apps/v1", "kind": "Deployment", "metadata": map[string]any{"namespace": "org-1--demo", "name": "web", "uid": "uid-actual", "generation": 17, "labels": map[string]string{"app.kubernetes.io/managed-by": "raibitserver", "raibitserver.io/project-id": "prj_1", "raibitserver.io/service-id": "svc_1", "raibitserver.io/deployment-id": "dep_1"}}, "spec": map[string]any{"replicas": 1}, "status": map[string]any{"observedGeneration": 17, "replicas": 1, "updatedReplicas": 1, "readyReplicas": 1, "availableReplicas": 1}}
	raw, err := json.Marshal(row)
	if err != nil {
		panic(err)
	}
	return string(raw)
}
