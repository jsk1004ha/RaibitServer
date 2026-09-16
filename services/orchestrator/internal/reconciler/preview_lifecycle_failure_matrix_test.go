package reconciler

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/raibitserver/orchestrator/internal/kube"
	"github.com/raibitserver/orchestrator/internal/store"
)

func TestPreviewLifecycleFailureMatrix(t *testing.T) {
	t.Run("stale route lease cannot promote after lineage version changes", func(t *testing.T) {
		// Given: a healthy candidate has route work at lineage version three.
		path := writeState(t, map[string]any{
			"projects":        []any{map[string]any{"id": "project-1", "organizationId": "org-1", "slug": "demo", "status": "ACTIVE"}},
			"services":        []any{map[string]any{"id": "service-1", "projectId": "project-1", "slug": "web", "type": "web", "port": 8080, "status": "ACTIVE"}},
			"previewLineages": []any{map[string]any{"id": "lineage-1", "organizationId": "org-1", "projectId": "project-1", "serviceId": "service-1", "state": "OPEN", "version": 3, "namespace": "org-demo", "routeName": "preview-route", "stableHost": "preview--pr-1--org--demo.example.test", "currentDeploymentId": "current", "currentGeneration": 1, "candidateDeploymentId": "candidate", "candidateGeneration": 2}},
			"deployments": []any{
				map[string]any{"id": "candidate", "projectId": "project-1", "serviceId": "service-1", "status": store.DeploymentStatusReady, "publicHealthStatus": "HEALTHY", "deploymentType": "preview", "previewLineageId": "lineage-1", "previewGeneration": 2, "previewRuntime": exactPreviewRuntime("candidate", 2, 3)},
				map[string]any{"id": "current", "projectId": "project-1", "serviceId": "service-1", "status": store.DeploymentStatusReady, "deploymentType": "preview", "previewLineageId": "lineage-1", "previewGeneration": 1, "previewRuntime": exactPreviewRuntime("current", 1, 2)},
			},
		})
		mutated := false
		runner := &fakeRunner{onRun: func(command string) {
			if mutated || !strings.Contains(command, "get ingress/preview-route") {
				return
			}
			state := readState(t, path)
			firstByID(t, state, "previewLineages", "lineage-1")["version"] = 4
			raw, err := json.Marshal(state)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, raw, 0o600); err != nil {
				t.Fatal(err)
			}
			mutated = true
		}, stdoutFor: func(command string) string {
			if strings.Contains(command, "get ingress/preview-route") {
				return marshalString(t, previewRouteObject("current", 1, "current-web", "12"))
			}
			return "ok\n"
		}}
		r := NewServiceReconcilerWithStore(Config{OutputDir: t.TempDir()}, store.NewFileStore(path), runner)

		// When: the stale worker attempts to record and apply its intent.
		_, err := r.RunOnceResult(context.Background())

		// Then: the fence rejects promotion before any route mutation or cleanup.
		state := readState(t, path)
		if !errors.Is(err, store.ErrDeploymentLeaseLost) || strings.Contains(strings.Join(runner.commands, "\n"), " replace ") || firstByID(t, state, "previewLineages", "lineage-1")["currentDeploymentId"] != "current" || firstByID(t, state, "deployments", "current")["status"] != store.DeploymentStatusReady {
			t.Fatalf("err=%v commands=%#v state=%#v", err, runner.commands, state)
		}
	})

	tests := []struct {
		name          string
		mutate        func(map[string]any)
		wantCleanedUp bool
	}{
		{name: "foreign tenant labels", mutate: func(object map[string]any) {
			object["metadata"].(map[string]any)["labels"].(map[string]any)["raibitserver.io/project-id"] = "project-foreign"
		}},
		{name: "foreign pull request lineage", mutate: func(object map[string]any) {
			object["metadata"].(map[string]any)["labels"].(map[string]any)["raibitserver.io/preview-lineage-id"] = "lineage-foreign"
		}},
		{name: "foreign deployment binding", mutate: func(object map[string]any) {
			object["metadata"].(map[string]any)["labels"].(map[string]any)["raibitserver.io/deployment-id"] = "deployment-foreign"
		}},
		{name: "replacement UID", mutate: func(object map[string]any) { object["metadata"].(map[string]any)["uid"] = "replacement-uid" }, wantCleanedUp: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Given: cleanup owns one frozen object identity.
			path := writeState(t, map[string]any{
				"projects": []any{map[string]any{"id": "project-1", "organizationId": "org-1", "slug": "demo", "status": "ACTIVE"}},
				"services": []any{map[string]any{"id": "service-1", "projectId": "project-1", "slug": "web", "type": "web", "port": 8080, "status": "ACTIVE"}},
				"deployments": []any{
					map[string]any{"id": "candidate", "projectId": "project-1", "serviceId": "service-1", "status": store.DeploymentStatusCleanupRequested, "deploymentType": "preview", "previewLineageId": "lineage-1", "previewGeneration": 2, "previewRuntime": exactPreviewRuntime("candidate", 2, 3), "previewOwnedObjects": []any{map[string]any{"group": "apps", "version": "v1", "kind": "Deployment", "namespace": "org-demo", "name": "candidate-web", "uid": "candidate-deployment-uid", "resourceVersion": "7"}}},
					map[string]any{"id": "foreign-production", "projectId": "project-1", "serviceId": "service-1", "status": store.DeploymentStatusReady, "deploymentType": "production"},
				},
			})
			object := exactPreviewObject("Deployment", "candidate", 2)
			tt.mutate(object)
			deleted := false
			runner := &fakeRunner{onRun: func(command string) {
				if strings.Contains(command, "delete --raw") {
					deleted = true
				}
			}, stdoutFor: func(command string) string {
				if strings.Contains(command, "get deployment/candidate-web") {
					return marshalString(t, object)
				}
				return "ok\n"
			}}
			r := NewServiceReconcilerWithStore(Config{OutputDir: t.TempDir()}, store.NewFileStore(path), runner)

			// When: cleanup observes a resource outside the frozen ownership tuple.
			result, err := r.RunOnceResult(context.Background())

			// Then: no delete is issued; a replacement UID is skipped and other mismatches fail closed.
			state := readState(t, path)
			status := firstByID(t, state, "deployments", "candidate")["status"]
			if deleted || firstByID(t, state, "deployments", "foreign-production")["status"] != store.DeploymentStatusReady {
				t.Fatalf("deleted=%v state=%#v commands=%#v", deleted, state, runner.commands)
			}
			if tt.wantCleanedUp {
				if err != nil || result.Status != store.DeploymentStatusCleanedUp || status != store.DeploymentStatusCleanedUp {
					t.Fatalf("replacement UID should be preserved and cleanup terminal: result=%#v err=%v state=%#v", result, err, state)
				}
			} else if !errors.Is(err, kube.ErrPreviewObject) || status != store.DeploymentStatusDeploying {
				t.Fatalf("ownership mismatch must fail closed: result=%#v err=%v state=%#v", result, err, state)
			}
		})
	}
}
