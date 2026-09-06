package kube

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHealthHappyProbesUseCapturedPathPrecedence(t *testing.T) {
	for _, tc := range []struct {
		name                         string
		paths                        map[string]any
		startup, readiness, liveness string
	}{
		{"explicit", map[string]any{"healthCheckPath": "/common", "readinessPath": "/ready", "livenessPath": "/live"}, "/common", "/ready", "/live"},
		{"common", map[string]any{"healthCheckPath": "/common"}, "/common", "/common", "/common"},
		{"readiness", map[string]any{"readinessPath": "/ready"}, "/ready", "/ready", ""},
		{"legacy", map[string]any{"healthCheck": map[string]any{"path": "/legacy"}}, "/legacy", "/legacy", "/legacy"},
		{"explicit clear", map[string]any{"healthCheckPath": nil, "healthCheck": map[string]any{"path": "/stale"}}, "", "", ""},
		{"tcp", nil, "", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Given: each path differs from every fallback.
			spec := workloadSpec("web", "dep-health", tc.paths, nil)
			// When
			plan := NewDeploymentPlan(spec)
			container := workloadContainer(t, plan)
			// Then: Kubernetes readiness alone gates the service endpoints.
			for name, path := range map[string]string{"startupProbe": tc.startup, "readinessProbe": tc.readiness, "livenessProbe": tc.liveness} {
				probe, ok := container[name].(map[string]any)
				if !ok {
					t.Fatalf("missing %s", name)
				}
				if path == "" {
					if _, ok := probe["tcpSocket"]; !ok {
						t.Fatalf("%s must use TCP: %#v", name, probe)
					}
				} else {
					http, ok := probe["httpGet"].(map[string]any)
					if !ok || http["path"] != path {
						t.Fatalf("%s path: %#v, want %s", name, probe, path)
					}
				}
				if probe["timeoutSeconds"] != float64(2) {
					t.Fatalf("unbounded probe: %#v", probe)
				}
			}
		})
	}
}

func workloadContainer(t *testing.T, plan DeploymentPlan) map[string]any {
	t.Helper()
	if !plan.Safe {
		t.Fatalf("unsafe plan: %s", plan.Error)
	}
	for _, manifest := range plan.Manifests {
		if manifest["kind"] != plan.Kind {
			continue
		}
		encoded, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		var object map[string]any
		if err := json.Unmarshal(encoded, &object); err != nil {
			t.Fatal(err)
		}
		spec := object["spec"].(map[string]any)
		if plan.Kind == "CronJob" {
			spec = spec["jobTemplate"].(map[string]any)["spec"].(map[string]any)
		}
		return spec["template"].(map[string]any)["spec"].(map[string]any)["containers"].([]any)[0].(map[string]any)
	}
	t.Fatal("workload missing")
	return nil
}

func TestHealthFailureMatrixNonWebHasNoSynthesizedProbes(t *testing.T) {
	for _, kind := range []string{"private", "worker", "cron", "job"} {
		t.Run(kind, func(t *testing.T) {
			// Given
			spec := workloadSpec(kind, "dep-health", map[string]any{"healthCheckPath": "/health"}, nil)
			// When
			container := workloadContainer(t, NewDeploymentPlan(spec))
			// Then
			for _, name := range []string{"startupProbe", "readinessProbe", "livenessProbe"} {
				if _, ok := container[name]; ok {
					t.Fatalf("%s synthesized %s", kind, name)
				}
			}
		})
	}
}

func TestHealthFailureMatrixRejectsUnsafePaths(t *testing.T) {
	for _, path := range []string{"//evil", "/a?x", "/a#x", "/a\\b", "/%2f", "/%252f", "/a/../b", "/%2e%2e/b", "/%00", "/a b", "/%zz", "/%", "/%2", "/" + strings.Repeat("a", 1024), "/" + strings.Repeat("가", 342)} {
		t.Run(path, func(t *testing.T) {
			// Given
			spec := workloadSpec("web", "dep-health", map[string]any{"readinessPath": path}, nil)
			// When
			plan := NewDeploymentPlan(spec)
			// Then
			if plan.Safe {
				t.Fatalf("unsafe path accepted: %q", path)
			}
		})
	}
}
