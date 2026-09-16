package reconciler

import (
	"context"
	"strings"
	"testing"

	"github.com/raibitserver/orchestrator/internal/health"
	"github.com/raibitserver/orchestrator/internal/store"
)

func TestHealthHappyPreviewUsesCapturedPreviewIdentity(t *testing.T) {
	// Given
	file := healthState(t)
	state := readState(t, file)
	deployment := firstByID(t, state, "deployments", "dep_1")
	deployment["deploymentType"], deployment["pullRequestNumber"] = "preview", 12
	saveHealthState(t, file, state)
	runner := &fakeRunner{stdoutFor: func(cmd string) string {
		return strings.ReplaceAll(healthCommandJSON(cmd), `"name":"web"`, `"name":"pr-12-web-1fee3c968086"`)
	}}
	r := NewServiceReconcilerWithStore(Config{OutputDir: t.TempDir()}, store.NewFileStore(file), runner)
	if _, err := r.RunOnceResult(context.Background()); err != nil {
		t.Fatal(err)
	}
	calls := 0
	r.checker = healthCheckFunc(func(_ context.Context, request health.Request) health.Result {
		calls++
		if !strings.HasPrefix(request.Hostname, "preview--pr-12--") || request.Path != "/ready" {
			t.Fatalf("preview target=%#v", request)
		}
		return health.Result{Status: "HEALTHY"}
	})
	// When
	result, err := r.RunOnceResult(context.Background())
	// Then
	if err != nil || calls != 1 || result.PublicHealthStatus != "HEALTHY" {
		t.Fatalf("preview result=%#v calls=%d err=%v", result, calls, err)
	}
}
