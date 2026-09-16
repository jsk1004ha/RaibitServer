package reconciler

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/raibitserver/orchestrator/internal/store"
)

func TestPreviewLifecycleHappy(t *testing.T) {
	// Given: generation one is serving while generation two is still deploying.
	currentRuntime := exactPreviewRuntime("current", 1, 2)
	candidateRuntime := exactPreviewRuntime("candidate", 2, 3)
	path := writeState(t, map[string]any{
		"projects": []any{map[string]any{"id": "project-1", "organizationId": "org-1", "slug": "demo", "status": "ACTIVE"}},
		"services": []any{map[string]any{"id": "service-1", "projectId": "project-1", "slug": "web", "type": "web", "port": 8080, "status": "ACTIVE"}},
		"previewLineages": []any{map[string]any{
			"id": "lineage-1", "organizationId": "org-1", "projectId": "project-1", "serviceId": "service-1", "state": "OPEN", "version": 3,
			"namespace": "org-demo", "routeName": "preview-route", "stableHost": "preview--pr-1--org--demo.example.test",
			"currentDeploymentId": "current", "currentGeneration": 1, "candidateDeploymentId": "candidate", "candidateGeneration": 2,
			"routeObserved": map[string]any{"version": 1, "lineageVersion": 2, "deploymentId": "current", "generation": 1, "namespace": "org-demo", "name": "preview-route", "uid": "route-uid", "resourceVersion": "12", "observedAt": "2026-09-04T00:00:00Z"},
		}},
		"deployments": []any{
			map[string]any{"id": "candidate", "projectId": "project-1", "serviceId": "service-1", "status": store.DeploymentStatusDeploying, "deploymentType": "preview", "previewLineageId": "lineage-1", "previewGeneration": 2, "previewRuntime": candidateRuntime},
			map[string]any{"id": "current", "projectId": "project-1", "serviceId": "service-1", "status": store.DeploymentStatusReady, "publicHealthStatus": "HEALTHY", "deploymentType": "preview", "previewLineageId": "lineage-1", "previewGeneration": 1, "previewRuntime": currentRuntime},
			map[string]any{"id": "foreign-production", "projectId": "project-1", "serviceId": "service-1", "status": store.DeploymentStatusReady, "deploymentType": "production"},
		},
	})
	deletedObjects := map[string]bool{}
	routeCandidate := false
	routeDeleted := false
	runner := &fakeRunner{onRun: func(command string) {
		if strings.Contains(command, " replace ") {
			routeCandidate = true
		}
		if strings.Contains(command, "/ingresses/preview-route") {
			routeDeleted = true
		}
		for _, kind := range []string{"deployments", "services", "ingresses"} {
			for _, deployment := range []string{"candidate", "current"} {
				if strings.Contains(command, "/"+kind+"/"+deployment+"-web") {
					deletedObjects[kind+"/"+deployment+"-web"] = true
				}
			}
		}
	}, stdoutFor: func(command string) string {
		if strings.Contains(command, "get ingress/preview-route") {
			if routeDeleted {
				return ""
			}
			deployment, generation, backend, resourceVersion := "current", 1, "current-web", "12"
			if routeCandidate {
				deployment, generation, backend, resourceVersion = "candidate", 2, "candidate-web", "13"
			}
			return marshalString(t, previewRouteObject(deployment, generation, backend, resourceVersion))
		}
		for _, kind := range []string{"Deployment", "Service", "Ingress"} {
			resource := strings.ToLower(kind)
			plural := resource + "s"
			if kind == "Ingress" {
				plural = "ingresses"
			}
			for _, deployment := range []string{"candidate", "current"} {
				key := plural + "/" + deployment + "-web"
				if strings.Contains(command, "get "+resource+"/"+deployment+"-web") {
					if deletedObjects[key] {
						return ""
					}
					generation := 1
					if deployment == "candidate" {
						generation = 2
					}
					return marshalString(t, exactPreviewObject(kind, deployment, generation))
				}
			}
		}
		return "ok\n"
	}}
	state := store.NewFileStore(path)
	r := NewServiceReconcilerWithStore(Config{OutputDir: t.TempDir()}, state, runner)

	// When: reconciliation runs before candidate health succeeds.
	result, err := r.RunOnceResult(context.Background())

	// Then: the first generation remains current and is not cleaned early.
	if err != nil || result.Reason != "no_reconcile_work" {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	lineage := firstByID(t, readState(t, path), "previewLineages", "lineage-1")
	if lineage["currentDeploymentId"] != "current" || firstByID(t, readState(t, path), "deployments", "current")["status"] != store.DeploymentStatusReady {
		t.Fatalf("lineage=%#v state=%#v", lineage, readState(t, path))
	}

	// Given / When: generation two becomes healthy and the stable route is replaced.
	if _, err := state.UpdateDeployment(context.Background(), "candidate", map[string]any{"status": store.DeploymentStatusReady, "publicHealthStatus": "HEALTHY"}); err != nil {
		t.Fatal(err)
	}
	result, err = r.RunOnceResult(context.Background())

	// Then: promotion atomically swaps the pointer before retiring only prior READY.
	if err != nil || result.Reason != "preview_route_promote" {
		t.Fatalf("result=%#v err=%v commands=%#v", result, err, runner.commands)
	}
	stateAfterPromotion := readState(t, path)
	lineage = firstByID(t, stateAfterPromotion, "previewLineages", "lineage-1")
	if lineage["currentDeploymentId"] != "candidate" || lineage["candidateDeploymentId"] != nil || firstByID(t, stateAfterPromotion, "deployments", "current")["status"] != store.DeploymentStatusCleanupRequested {
		t.Fatalf("promotion was not atomic: %#v", stateAfterPromotion)
	}

	// Given: the control plane closes the lineage and schedules every generation.
	lineage["state"], lineage["version"] = "CLOSED", 4
	lineage["currentDeploymentId"], lineage["currentGeneration"] = nil, nil
	lineage["routeObserved"] = map[string]any{"version": 1, "lineageVersion": 4, "deploymentId": "candidate", "generation": 2, "namespace": "org-demo", "name": "preview-route", "uid": "route-uid", "resourceVersion": "13", "observedAt": "2026-09-04T00:00:01Z"}
	for _, deployment := range []string{"candidate", "current"} {
		row := firstByID(t, stateAfterPromotion, "deployments", deployment)
		row["status"] = store.DeploymentStatusCleanupRequested
		row["previewOwnedObjects"] = exactPreviewInventory(deployment)
	}
	raw, marshalErr := json.Marshal(stateAfterPromotion)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	// When: the route and both owned object inventories are reconciled.
	for range 3 {
		result, err := r.RunOnceResult(context.Background())
		if err != nil {
			t.Fatalf("result=%#v err=%v commands=%#v", result, err, runner.commands)
		}
	}

	// Then: route identity is cleared, both generations are terminal, and foreign production survives.
	finalState := readState(t, path)
	lineage = firstByID(t, finalState, "previewLineages", "lineage-1")
	observed := lineage["routeObserved"].(map[string]any)
	if observed["uid"] != nil || lineage["routeIntent"] != nil || firstByID(t, finalState, "deployments", "candidate")["status"] != store.DeploymentStatusCleanedUp || firstByID(t, finalState, "deployments", "current")["status"] != store.DeploymentStatusCleanedUp || firstByID(t, finalState, "deployments", "foreign-production")["status"] != store.DeploymentStatusReady {
		t.Fatalf("terminal preview cleanup mismatch: %#v", finalState)
	}
	if len(deletedObjects) != 6 || strings.Contains(strings.Join(runner.commands, "\n"), "foreign-production") {
		t.Fatalf("owned deletion set=%#v commands=%#v", deletedObjects, runner.commands)
	}
}

func exactPreviewRuntime(deployment string, generation, lineageVersion int) map[string]any {
	return map[string]any{"version": 1, "lineageId": "lineage-1", "deploymentId": deployment, "generation": generation, "lineageVersion": lineageVersion, "stableHost": "preview--pr-1--org--demo.example.test", "probeHost": "preview--probe-" + deployment + ".example.test", "namespace": "org-demo", "workloadName": deployment + "-web", "serviceName": deployment + "-web", "probeIngressName": deployment + "-web", "routeName": "preview-route"}
}

func exactPreviewInventory(deployment string) []any {
	return []any{
		map[string]any{"group": "apps", "version": "v1", "kind": "Deployment", "namespace": "org-demo", "name": deployment + "-web", "uid": deployment + "-deployment-uid", "resourceVersion": "7"},
		map[string]any{"group": "", "version": "v1", "kind": "Service", "namespace": "org-demo", "name": deployment + "-web", "uid": deployment + "-service-uid", "resourceVersion": "7"},
		map[string]any{"group": "networking.k8s.io", "version": "v1", "kind": "Ingress", "namespace": "org-demo", "name": deployment + "-web", "uid": deployment + "-ingress-uid", "resourceVersion": "7"},
	}
}

func exactPreviewObject(kind, deployment string, generation int) map[string]any {
	apiVersion := "v1"
	if kind == "Deployment" {
		apiVersion = "apps/v1"
	} else if kind == "Ingress" {
		apiVersion = "networking.k8s.io/v1"
	}
	object := map[string]any{"apiVersion": apiVersion, "kind": kind, "metadata": map[string]any{"name": deployment + "-web", "namespace": "org-demo", "uid": deployment + "-" + strings.ToLower(kind) + "-uid", "resourceVersion": "7", "labels": map[string]any{"app.kubernetes.io/managed-by": "raibitserver", "raibitserver.io/project-id": "project-1", "raibitserver.io/service-id": "service-1", "raibitserver.io/deployment-id": deployment, "raibitserver.io/preview-lineage-id": "lineage-1", "raibitserver.io/preview-generation": strconv.Itoa(generation)}}}
	if kind == "Service" {
		object["spec"] = map[string]any{"selector": map[string]any{"app.kubernetes.io/name": deployment + "-web"}}
	} else if kind == "Ingress" {
		object["spec"] = map[string]any{"rules": []any{map[string]any{"host": "preview--probe-" + deployment + ".example.test", "http": map[string]any{"paths": []any{map[string]any{"backend": map[string]any{"service": map[string]any{"name": deployment + "-web"}}}}}}}}
	}
	return object
}
