package reconciler

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/raibitserver/orchestrator/internal/health"
	"github.com/raibitserver/orchestrator/internal/store"
)

func TestHealthFailureMatrixFailedReadinessNeverSchedulesPublicHealth(t *testing.T) {
	// Given
	file := healthState(t)
	runner := &fakeRunner{failContains: "rollout status", failure: errors.New("local readiness fixture failed")}
	r := NewServiceReconcilerWithStore(Config{OutputDir: t.TempDir()}, store.NewFileStore(file), runner)
	// When
	_, err := r.RunOnceResult(context.Background())
	// Then
	if err == nil {
		t.Fatal("readiness failure accepted")
	}
	state := readState(t, file)
	if firstByID(t, state, "deployments", "dep_1")["status"] != "FAILED" {
		t.Fatal("rollout failure not durable")
	}
	if jobs, ok := state["workflowJobs"].([]any); ok && len(jobs) > 0 {
		t.Fatalf("unready workload scheduled health: %#v", jobs)
	}
}

func TestHealthFailureMatrixDeletionHasPriorityOverQueuedHealth(t *testing.T) {
	// Given
	r, file, _ := readyHealth(t)
	state := readState(t, file)
	firstByID(t, state, "services", "svc_1")["status"] = "DELETE_REQUESTED"
	saveHealthState(t, file, state)
	r.checker = healthCheckFunc(func(context.Context, health.Request) health.Result {
		t.Fatal("deleting service called HTTP")
		return health.Result{}
	})
	// When
	result, err := r.RunOnceResult(context.Background())
	// Then
	if err != nil || result.Reason != "service_deleted" {
		t.Fatalf("deletion priority result=%#v err=%v", result, err)
	}
}

func TestHealthFailureMatrixHostnameMustMatchGeneratedRoute(t *testing.T) {
	// Given: a public hostname is still invalid unless it is the owned generated route.
	r, file, _ := readyHealth(t)
	state := readState(t, file)
	job := state["workflowJobs"].([]any)[0].(map[string]any)
	job["payload"].(map[string]any)["generatedHost"] = "apps--unowned--route.example.com"
	saveHealthState(t, file, state)
	r.checker = healthCheckFunc(func(context.Context, health.Request) health.Result {
		t.Fatal("unbound hostname called HTTP")
		return health.Result{}
	})
	// When
	_, err := r.RunOnceResult(context.Background())
	// Then
	if err != nil {
		t.Fatal(err)
	}
	row := firstByID(t, readState(t, file), "deployments", "dep_1")
	if row["publicHealthStatus"] != "UNKNOWN" || row["healthCheckedAt"] != nil {
		t.Fatalf("unbound route published: %#v", row)
	}
}

func TestHealthHappyOnlyDeploymentKindsRecordGeneration(t *testing.T) {
	for _, kind := range []string{"private", "worker", "cron", "job"} {
		t.Run(kind, func(t *testing.T) {
			// Given
			file := healthState(t)
			state := readState(t, file)
			firstByID(t, state, "services", "svc_1")["type"] = kind
			saveHealthState(t, file, state)
			r := NewServiceReconcilerWithStore(Config{OutputDir: t.TempDir()}, store.NewFileStore(file), &fakeRunner{stdoutFor: healthCommandJSON})
			// When
			_, err := r.RunOnceResult(context.Background())
			// Then
			if err != nil {
				t.Fatal(err)
			}
			state = readState(t, file)
			row := firstByID(t, state, "deployments", "dep_1")
			if kind == "worker" || kind == "private" {
				if row["observedGeneration"] != float64(17) {
					t.Fatalf("missing actual generation: %#v", row)
				}
			} else if row["observedGeneration"] != nil {
				t.Fatalf("synthetic generation: %#v", row)
			}
			if jobs, ok := state["workflowJobs"].([]any); ok && len(jobs) > 0 {
				t.Fatalf("nonweb job scheduled: %#v", jobs)
			}
		})
	}
}

func saveHealthState(t *testing.T, file string, state map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestHealthHappyRetryReportsCheckingWithoutRolloutFailure(t *testing.T) {
	// Given
	r, file, _ := readyHealth(t)
	before := readState(t, file)["workflowJobs"].([]any)[0].(map[string]any)["payload"].(map[string]any)["absoluteDeadline"]
	r.checker = healthCheckFunc(func(context.Context, health.Request) health.Result {
		return health.Result{Status: "DEGRADED", FailureCode: "PUBLIC_HEALTH_CONNECT_FAILED", Retryable: true}
	})
	// When
	result, err := r.RunOnceResult(context.Background())
	// Then
	if err != nil || result.PublicHealthStatus != "CHECKING" {
		t.Fatalf("retry result=%#v err=%v", result, err)
	}
	state := readState(t, file)
	row := firstByID(t, state, "deployments", "dep_1")
	job := state["workflowJobs"].([]any)[0].(map[string]any)
	if row["status"] != "READY" || row["publicHealthStatus"] != "CHECKING" || row["healthCheckedAt"] != nil || job["status"] != "queued" {
		t.Fatalf("retry state row=%#v job=%#v", row, job)
	}
	if job["payload"].(map[string]any)["absoluteDeadline"] != before {
		t.Fatal("retry extended absolute deadline")
	}
}
