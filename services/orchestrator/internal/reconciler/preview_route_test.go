package reconciler

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/raibitserver/orchestrator/internal/store"
)

func TestPreviewRoutePromotion_creates_stable_route_after_exact_candidate_health(t *testing.T) {
	// Given
	runtime := map[string]any{"version": 1, "lineageId": "lineage-1", "deploymentId": "candidate", "generation": 2, "lineageVersion": 3, "stableHost": "preview--pr-1--org--demo.example.test", "probeHost": "preview--probe-0123456789abcdef0123456789abcdef.example.test", "namespace": "org-demo", "workloadName": "candidate-web", "serviceName": "candidate-web", "probeIngressName": "candidate-web", "routeName": "preview-route"}
	path := writeState(t, map[string]any{
		"projects":        []any{map[string]any{"id": "project-1", "organizationId": "org-1", "slug": "demo", "status": "ACTIVE"}},
		"services":        []any{map[string]any{"id": "service-1", "projectId": "project-1", "slug": "web", "type": "web", "port": 8080, "status": "ACTIVE"}},
		"previewLineages": []any{map[string]any{"id": "lineage-1", "organizationId": "org-1", "projectId": "project-1", "serviceId": "service-1", "state": "OPEN", "version": 3, "namespace": "org-demo", "routeName": "preview-route", "stableHost": "preview--pr-1--org--demo.example.test", "candidateDeploymentId": "candidate", "candidateGeneration": 2}},
		"deployments":     []any{map[string]any{"id": "candidate", "projectId": "project-1", "serviceId": "service-1", "status": "READY", "publicHealthStatus": "HEALTHY", "deploymentType": "preview", "previewLineageId": "lineage-1", "previewGeneration": 2, "previewRuntime": runtime}},
	})
	created := false
	runner := &fakeRunner{onRun: func(cmd string) {
		if strings.Contains(cmd, " create ") {
			created = true
		}
	}, stdoutFor: func(cmd string) string {
		if !strings.Contains(cmd, "get ingress/preview-route") || !created {
			return ""
		}
		object := previewRouteObject("candidate", 2, "candidate-web", "12")
		raw, _ := json.Marshal(object)
		return string(raw)
	}}
	r := NewServiceReconcilerWithStore(Config{OutputDir: t.TempDir()}, store.NewFileStore(path), runner)

	// When
	result, err := r.RunOnceResult(context.Background())

	// Then
	if err != nil || result.Reason != "preview_route_promote" || !created {
		t.Fatalf("result=%#v created=%v err=%v commands=%#v", result, created, err, runner.commands)
	}
	lineage := firstByID(t, readState(t, path), "previewLineages", "lineage-1")
	if lineage["currentDeploymentId"] != "candidate" || lineage["candidateDeploymentId"] != nil {
		t.Fatalf("lineage=%#v", lineage)
	}
}

func TestPreviewRoutePromotion_rejects_invalid_trusted_ingress_settings_before_apply(t *testing.T) {
	// Given
	runtime := map[string]any{"version": 1, "lineageId": "lineage-1", "deploymentId": "candidate", "generation": 2, "lineageVersion": 3, "stableHost": "preview--pr-1--org--demo.example.test", "probeHost": "preview--probe-0123456789abcdef0123456789abcdef.example.test", "namespace": "org-demo", "workloadName": "candidate-web", "serviceName": "candidate-web", "probeIngressName": "candidate-web", "routeName": "preview-route"}
	path := writeState(t, map[string]any{
		"projects":        []any{map[string]any{"id": "project-1", "organizationId": "org-1", "slug": "demo", "status": "ACTIVE"}},
		"services":        []any{map[string]any{"id": "service-1", "projectId": "project-1", "slug": "web", "type": "web", "port": 8080, "status": "ACTIVE"}},
		"previewLineages": []any{map[string]any{"id": "lineage-1", "organizationId": "org-1", "projectId": "project-1", "serviceId": "service-1", "state": "OPEN", "version": 3, "namespace": "org-demo", "routeName": "preview-route", "stableHost": "preview--pr-1--org--demo.example.test", "candidateDeploymentId": "candidate", "candidateGeneration": 2}},
		"deployments":     []any{map[string]any{"id": "candidate", "projectId": "project-1", "serviceId": "service-1", "status": "READY", "publicHealthStatus": "HEALTHY", "deploymentType": "preview", "previewLineageId": "lineage-1", "previewGeneration": 2, "previewRuntime": runtime}},
	})
	outputDir := t.TempDir()
	runner := &fakeRunner{stdoutFor: func(cmd string) string {
		if strings.Contains(cmd, "get ingress/preview-route") {
			return ""
		}
		return "ok\n"
	}}
	r := NewServiceReconcilerWithStore(Config{OutputDir: outputDir, IngressCustomHTTPErrors: "404,700"}, store.NewFileStore(path), runner)

	// When
	result, err := r.RunOnceResult(context.Background())

	// Then
	if err == nil || result == nil || strings.Contains(strings.Join(runner.commands, "\n"), " create ") || strings.Contains(strings.Join(runner.commands, "\n"), " replace ") {
		t.Fatalf("invalid trusted ingress settings must reject before apply: result=%#v commands=%#v err=%v", result, runner.commands, err)
	}
	entries, readErr := os.ReadDir(outputDir)
	if readErr != nil || len(entries) != 0 {
		t.Fatalf("invalid trusted ingress settings must not write an apply manifest: entries=%#v err=%v", entries, readErr)
	}
}

func TestPreviewRoutePromotion_replaces_existing_lineage_route_after_resume(t *testing.T) {
	// Given: the lineage still has a healthy candidate and Kubernetes has the
	// lineage-owned route pointing at the previous service, as after a crash.
	runtime := map[string]any{"version": 1, "lineageId": "lineage-1", "deploymentId": "candidate", "generation": 2, "lineageVersion": 3, "stableHost": "preview--pr-1--org--demo.example.test", "probeHost": "preview--probe-0123456789abcdef0123456789abcdef.example.test", "namespace": "org-demo", "workloadName": "candidate-web", "serviceName": "candidate-web", "probeIngressName": "candidate-web", "routeName": "preview-route"}
	path := writeState(t, map[string]any{
		"projects":        []any{map[string]any{"id": "project-1", "organizationId": "org-1", "slug": "demo", "status": "ACTIVE"}},
		"services":        []any{map[string]any{"id": "service-1", "projectId": "project-1", "slug": "web", "type": "web", "port": 8080, "status": "ACTIVE"}},
		"previewLineages": []any{map[string]any{"id": "lineage-1", "organizationId": "org-1", "projectId": "project-1", "serviceId": "service-1", "state": "OPEN", "version": 3, "namespace": "org-demo", "routeName": "preview-route", "stableHost": "preview--pr-1--org--demo.example.test", "candidateDeploymentId": "candidate", "candidateGeneration": 2}},
		"deployments":     []any{map[string]any{"id": "candidate", "projectId": "project-1", "serviceId": "service-1", "status": "READY", "publicHealthStatus": "HEALTHY", "deploymentType": "preview", "previewLineageId": "lineage-1", "previewGeneration": 2, "previewRuntime": runtime}},
	})
	replaced := false
	runner := &fakeRunner{onRun: func(cmd string) {
		if strings.Contains(cmd, " replace ") {
			replaced = true
		}
	}, stdoutFor: func(cmd string) string {
		if !strings.Contains(cmd, "get ingress/preview-route") {
			return ""
		}
		backend := "previous-web"
		resourceVersion := "12"
		if replaced {
			backend, resourceVersion = "candidate-web", "13"
		}
		deployment, generation := "previous", 1
		if replaced {
			deployment, generation = "candidate", 2
		}
		object := previewRouteObject(deployment, generation, backend, resourceVersion)
		raw, _ := json.Marshal(object)
		return string(raw)
	}}
	r := NewServiceReconcilerWithStore(Config{OutputDir: t.TempDir()}, store.NewFileStore(path), runner)

	// When
	result, err := r.RunOnceResult(context.Background())

	// Then
	if err != nil || result.Reason != "preview_route_promote" || !replaced {
		t.Fatalf("result=%#v replaced=%v err=%v commands=%#v", result, replaced, err, runner.commands)
	}
	lineage := firstByID(t, readState(t, path), "previewLineages", "lineage-1")
	if lineage["currentDeploymentId"] != "candidate" || lineage["candidateDeploymentId"] != nil {
		t.Fatalf("lineage=%#v", lineage)
	}
}

func previewRouteObject(deployment string, generation int, backend, resourceVersion string) map[string]any {
	return map[string]any{
		"apiVersion": "networking.k8s.io/v1", "kind": "Ingress",
		"metadata": map[string]any{
			"name": "preview-route", "namespace": "org-demo", "uid": "route-uid", "resourceVersion": resourceVersion,
			"labels": map[string]any{
				"app.kubernetes.io/name": "preview-route", "app.kubernetes.io/managed-by": "raibitserver", "raibitserver.io/managed": "true",
				"raibitserver.io/project-id": "project-1", "raibitserver.io/service-id": "service-1", "raibitserver.io/deployment-id": deployment,
				"raibitserver.io/preview-route": "true", "raibitserver.io/preview-lineage-id": "lineage-1", "raibitserver.io/preview-generation": strconv.Itoa(generation),
				"raibitserver.io/preview-backend-service": backend,
			},
			"annotations": map[string]any{"raibitserver.io/hostname": "preview--pr-1--org--demo.example.test"},
		},
		"spec": map[string]any{
			"rules": []any{
				map[string]any{
					"host": "preview--pr-1--org--demo.example.test",
					"http": map[string]any{
						"paths": []any{
							map[string]any{
								"backend": map[string]any{
									"service": map[string]any{"name": backend},
								},
							},
						},
					},
				},
			},
		},
	}
}

func TestPreviewRouteClose_deletes_exact_observed_uid_and_reopen_race_prevents_delete(t *testing.T) {
	closedState := func() map[string]any {
		return map[string]any{
			"projects": []any{map[string]any{"id": "project-1", "organizationId": "org-1", "slug": "demo", "status": "ACTIVE"}},
			"services": []any{map[string]any{"id": "service-1", "projectId": "project-1", "slug": "web", "type": "web", "port": 8080, "status": "ACTIVE"}},
			"previewLineages": []any{map[string]any{
				"id": "lineage-1", "organizationId": "org-1", "projectId": "project-1", "serviceId": "service-1", "state": "CLOSED", "version": 3,
				"namespace": "org-demo", "routeName": "preview-route", "stableHost": "preview--pr-1--org--demo.example.test",
				"currentDeploymentId": "current", "currentGeneration": 1,
				"routeObserved": map[string]any{"version": 1, "lineageVersion": 3, "deploymentId": "current", "generation": 1, "namespace": "org-demo", "name": "preview-route", "uid": "route-uid", "resourceVersion": "12", "observedAt": "2026-09-04T00:00:00Z"},
			}},
			"deployments": []any{},
		}
	}

	t.Run("closed lineage", func(t *testing.T) {
		path := writeState(t, closedState())
		deleted := false
		runner := &fakeRunner{onRun: func(cmd string) {
			if strings.Contains(cmd, "delete --raw") {
				deleted = true
			}
		}, stdoutFor: func(cmd string) string {
			if !strings.Contains(cmd, "get ingress/preview-route") || deleted {
				return ""
			}
			raw, _ := json.Marshal(previewRouteObject("current", 1, "current-web", "12"))
			return string(raw)
		}}
		r := NewServiceReconcilerWithStore(Config{OutputDir: t.TempDir()}, store.NewFileStore(path), runner)
		result, err := r.RunOnceResult(context.Background())
		if err != nil || result.Reason != "preview_route_clear" || !deleted || !strings.Contains(strings.Join(runner.commands, "\n"), "delete --raw /apis/networking.k8s.io/v1/namespaces/org-demo/ingresses/preview-route -f") {
			t.Fatalf("result=%#v deleted=%v err=%v commands=%#v", result, deleted, err, runner.commands)
		}
	})

	t.Run("reopened lineage", func(t *testing.T) {
		path := writeState(t, closedState())
		reopened := false
		runner := &fakeRunner{onRun: func(cmd string) {
			if !reopened && strings.Contains(cmd, "get ingress/preview-route") {
				state := readState(t, path)
				lineage := firstByID(t, state, "previewLineages", "lineage-1")
				lineage["state"], lineage["version"] = "OPEN", 4
				raw, _ := json.Marshal(state)
				if err := os.WriteFile(path, raw, 0o600); err != nil {
					t.Fatal(err)
				}
				reopened = true
			}
		}, stdoutFor: func(cmd string) string {
			if !strings.Contains(cmd, "get ingress/preview-route") {
				return ""
			}
			raw, _ := json.Marshal(previewRouteObject("current", 1, "current-web", "12"))
			return string(raw)
		}}
		r := NewServiceReconcilerWithStore(Config{OutputDir: t.TempDir()}, store.NewFileStore(path), runner)
		_, err := r.RunOnceResult(context.Background())
		if !errors.Is(err, store.ErrDeploymentLeaseLost) || strings.Contains(strings.Join(runner.commands, "\n"), "delete --raw") {
			t.Fatalf("err=%v commands=%#v", err, runner.commands)
		}
	})
}

func TestPreviewCleanup_unknown_delete_response_rechecks_uid_before_completion(t *testing.T) {
	// Given
	runtime := map[string]any{"version": 1, "lineageId": "lineage-1", "deploymentId": "candidate", "generation": 2, "lineageVersion": 3, "stableHost": "preview--pr-1--org--demo.example.test", "probeHost": "preview--probe-0123456789abcdef0123456789abcdef.example.test", "namespace": "org-demo", "workloadName": "candidate-web", "serviceName": "candidate-web", "probeIngressName": "candidate-web", "routeName": "preview-route"}
	owned := []any{map[string]any{"group": "apps", "version": "v1", "kind": "Deployment", "namespace": "org-demo", "name": "candidate-web", "uid": "owned-uid", "resourceVersion": "7"}}
	path := writeState(t, map[string]any{
		"projects":    []any{map[string]any{"id": "project-1", "organizationId": "org-1", "slug": "demo", "status": "ACTIVE"}},
		"services":    []any{map[string]any{"id": "service-1", "projectId": "project-1", "slug": "web", "type": "web", "port": 8080, "status": "ACTIVE"}},
		"deployments": []any{map[string]any{"id": "candidate", "projectId": "project-1", "serviceId": "service-1", "status": store.DeploymentStatusCleanupRequested, "deploymentType": "preview", "previewLineageId": "lineage-1", "previewGeneration": 2, "previewRuntime": runtime, "previewOwnedObjects": owned}},
	})
	deleted := false
	runner := &fakeRunner{failure: errors.New("connection closed after request"), failContains: "delete --raw", onRun: func(cmd string) {
		if strings.Contains(cmd, "delete --raw") {
			deleted = true
		}
	}, stdoutFor: func(cmd string) string {
		if !strings.Contains(cmd, "get deployment/candidate-web") || deleted {
			return ""
		}
		return `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"candidate-web","namespace":"org-demo","uid":"owned-uid","resourceVersion":"7","labels":{"app.kubernetes.io/managed-by":"raibitserver","raibitserver.io/project-id":"project-1","raibitserver.io/service-id":"service-1","raibitserver.io/deployment-id":"candidate","raibitserver.io/preview-lineage-id":"lineage-1","raibitserver.io/preview-generation":"2"}}}`
	}}
	r := NewServiceReconcilerWithStore(Config{OutputDir: t.TempDir()}, store.NewFileStore(path), runner)

	// When
	result, err := r.RunOnceResult(context.Background())

	// Then
	if err != nil || result.Status != store.DeploymentStatusCleanedUp {
		t.Fatalf("result=%#v err=%v commands=%#v", result, err, runner.commands)
	}
	if !strings.Contains(strings.Join(runner.commands, "\n"), "delete --raw /apis/apps/v1/namespaces/org-demo/deployments/candidate-web -f") {
		t.Fatalf("UID-precondition delete was not used: %#v", runner.commands)
	}
}
