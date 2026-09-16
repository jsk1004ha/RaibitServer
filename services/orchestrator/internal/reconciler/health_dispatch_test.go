package reconciler

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/raibitserver/orchestrator/internal/health"
	"github.com/raibitserver/orchestrator/internal/store"
)

type healthCheckFunc func(context.Context, health.Request) health.Result

func (check healthCheckFunc) Check(ctx context.Context, request health.Request) health.Result {
	return check(ctx, request)
}

func TestHealthHappyPublicResultPreservesRolloutHistory(t *testing.T) {
	for _, status := range []string{"HEALTHY", "DEGRADED"} {
		t.Run(status, func(t *testing.T) {
			// Given
			r, file, _ := readyHealth(t)
			before := firstByID(t, readState(t, file), "deployments", "dep_1")
			r.checker = healthCheckFunc(func(_ context.Context, request health.Request) health.Result {
				if request.Path != "/ready" || !strings.HasPrefix(request.Hostname, "apps--") {
					t.Fatalf("target=%#v", request)
				}
				checking := firstByID(t, readState(t, file), "deployments", "dep_1")
				if checking["publicHealthStatus"] != "CHECKING" {
					t.Fatalf("not checking: %#v", checking)
				}
				code := ""
				if status == "DEGRADED" {
					code = "PUBLIC_HEALTH_HTTP_STATUS"
				}
				return health.Result{Status: status, FailureCode: code}
			})
			// When
			result, err := r.RunOnceResult(context.Background())
			// Then
			if err != nil || result.PublicHealthStatus != status {
				t.Fatalf("result=%#v err=%v", result, err)
			}
			after := firstByID(t, readState(t, file), "deployments", "dep_1")
			if after["publicHealthStatus"] != status || after["healthCheckedAt"] == nil {
				t.Fatalf("health=%#v", after)
			}
			for _, key := range []string{"status", "deployedAt", "finishedAt", "errorCode", "errorMessage"} {
				if before[key] != after[key] {
					t.Fatalf("health rewrote %s", key)
				}
			}
		})
	}
}

func TestHealthFailureMatrixReplacementFencesBeforeAndAfterHTTP(t *testing.T) {
	for _, phase := range []string{"before", "after", "expired"} {
		for _, field := range []string{"uid", "generation", "readiness"} {
			t.Run(phase+" "+field, func(t *testing.T) {
				// Given
				r, file, runner := readyHealth(t)
				calls := 0
				replaced := phase != "after"
				if phase == "expired" {
					now := time.Now().UTC().Add(181 * time.Second)
					r.now = func() time.Time { return now }
				}
				runner.stdoutFor = func(cmd string) string {
					value := healthCommandJSON(cmd)
					if replaced {
						switch field {
						case "uid":
							value = strings.ReplaceAll(value, "uid-actual", "replacement")
						case "generation":
							value = strings.ReplaceAll(value, ":17", ":18")
						case "readiness":
							value = strings.ReplaceAll(value, `"readyReplicas":1`, `"readyReplicas":0`)
						}
					}
					return value
				}
				r.checker = healthCheckFunc(func(context.Context, health.Request) health.Result {
					calls++
					replaced = true
					return health.Result{Status: "HEALTHY"}
				})
				// When
				_, err := r.RunOnceResult(context.Background())
				// Then
				if err != nil {
					t.Fatal(err)
				}
				if phase != "after" && calls != 0 {
					t.Fatal("stale job made HTTP request")
				}
				row := firstByID(t, readState(t, file), "deployments", "dep_1")
				if row["publicHealthStatus"] != "UNKNOWN" || row["healthCheckedAt"] != nil || row["status"] != "READY" {
					t.Fatalf("stale publication: %#v", row)
				}
			})
		}
	}
}

func TestHealthFailureMatrixExpiredDeadlineDoesNotCallHTTP(t *testing.T) {
	// Given
	r, file, _ := readyHealth(t)
	now := time.Now().UTC().Add(181 * time.Second)
	r.now = func() time.Time { return now }
	r.checker = healthCheckFunc(func(context.Context, health.Request) health.Result {
		t.Fatal("expired job called HTTP")
		return health.Result{}
	})
	// When
	_, err := r.RunOnceResult(context.Background())
	// Then
	if err != nil {
		t.Fatal(err)
	}
	row := firstByID(t, readState(t, file), "deployments", "dep_1")
	if row["publicHealthStatus"] != "DEGRADED" || row["healthFailureCode"] != "PUBLIC_HEALTH_TIMEOUT" {
		t.Fatalf("deadline result=%#v", row)
	}
}

func TestHealthFailureMatrixParentDeletionDuringHTTPDoesNotPublish(t *testing.T) {
	// Given
	r, file, _ := readyHealth(t)
	r.checker = healthCheckFunc(func(context.Context, health.Request) health.Result {
		state := readState(t, file)
		firstByID(t, state, "services", "svc_1")["status"] = "DELETE_REQUESTED"
		encoded, err := json.Marshal(state)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, encoded, 0o600); err != nil {
			t.Fatal(err)
		}
		return health.Result{Status: "HEALTHY"}
	})
	// When
	_, err := r.RunOnceResult(context.Background())
	// Then: cancellation may surface a lost lease, never a health publication.
	if err != nil && !errors.Is(err, store.ErrHealthLeaseLost) {
		t.Fatal(err)
	}
	row := firstByID(t, readState(t, file), "deployments", "dep_1")
	if row["publicHealthStatus"] == "HEALTHY" || row["healthCheckedAt"] != nil {
		t.Fatalf("deleted parent published: %#v", row)
	}
}

func readyHealth(t *testing.T) (*ServiceReconciler, string, *fakeRunner) {
	t.Helper()
	file := healthState(t)
	runner := &fakeRunner{stdoutFor: healthCommandJSON}
	r := NewServiceReconcilerWithStore(Config{OutputDir: t.TempDir()}, store.NewFileStore(file), runner)
	if _, err := r.RunOnceResult(context.Background()); err != nil {
		t.Fatal(err)
	}
	runner.commands = nil
	return r, file, runner
}

func TestHealthFailureMatrixDeadlineAfterHTTPDoesNotReportHealthy(t *testing.T) {
	// Given
	r, file, _ := readyHealth(t)
	var now atomic.Int64
	now.Store(time.Now().UTC().Add(179 * time.Second).UnixNano())
	r.now = func() time.Time { return time.Unix(0, now.Load()).UTC() }
	r.checker = healthCheckFunc(func(context.Context, health.Request) health.Result {
		now.Add(int64(2 * time.Second))
		return health.Result{Status: "HEALTHY"}
	})
	// When
	result, err := r.RunOnceResult(context.Background())
	// Then: the job lease remains valid but the observation deadline has elapsed.
	if err != nil {
		t.Fatal(err)
	}
	if result.PublicHealthStatus != "DEGRADED" {
		t.Fatalf("late result=%#v", result)
	}
	row := firstByID(t, readState(t, file), "deployments", "dep_1")
	if row["publicHealthStatus"] != "DEGRADED" || row["healthFailureCode"] != "PUBLIC_HEALTH_TIMEOUT" {
		t.Fatalf("late publication=%#v", row)
	}
}
