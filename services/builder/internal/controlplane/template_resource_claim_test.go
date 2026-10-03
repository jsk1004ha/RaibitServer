package controlplane

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestFileStoreTemplateResourceGateLeavesJobQueuedUntilEveryExactBindingIsReady(t *testing.T) {
	base := time.Date(2026, 9, 13, 8, 0, 0, 0, time.UTC)
	job := map[string]any{
		"id": "job-template", "type": "build-and-deploy", "status": WorkflowQueued,
		"targetType": "deployment", "targetId": "deployment-template", "attempts": 0, "maxAttempts": 3,
		"runAfter": base.Format(time.RFC3339Nano),
		"payload":  map[string]any{"deploymentId": "deployment-template", "projectId": "project-a", "environmentId": "env-a", "templateResourceIds": []any{"resource-a", "resource-b"}},
	}
	state := map[string]any{
		"projects":     []any{map[string]any{"id": "project-a", "status": "ACTIVE"}},
		"services":     []any{map[string]any{"id": "service-a", "projectId": "project-a", "slug": "web", "status": "CREATED", "environmentId": "env-a", "environmentKind": "prod", "logicalSlug": "web"}},
		"deployments":  []any{map[string]any{"id": "deployment-template", "serviceId": "service-a", "projectId": "project-a", "environmentId": "env-a", "environmentKind": "prod", "logicalSlug": "web", "status": "QUEUED"}},
		"workflowJobs": []any{job},
		"resources": []any{
			map[string]any{"id": "resource-a", "projectId": "project-a", "status": "READY"},
			map[string]any{"id": "resource-b", "projectId": "project-a", "status": "PROVISIONING"},
		},
		"environmentResources": []any{
			map[string]any{"resourceId": "resource-a", "projectId": "project-a", "environmentId": "env-a"},
			map[string]any{"resourceId": "resource-b", "projectId": "project-a", "environmentId": "env-a"},
		},
	}
	store := NewFileStore(writeControlPlaneState(t, state))

	claimed, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{WorkerID: "builder-a", Now: base})
	if err != nil || claimed != nil {
		t.Fatalf("not-ready resource must leave job queued: claimed=%#v err=%v", claimed, err)
	}

	loaded, err := store.loadReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	resources := recordSlice(loaded, "resources")
	resources[1]["status"] = "READY"
	setRecordSlice(loaded, "resources", resources)
	bindings := recordSlice(loaded, "environmentResources")
	bindings[1]["environmentId"] = "foreign-env"
	setRecordSlice(loaded, "environmentResources", bindings)
	if err := store.save(loaded); err != nil {
		t.Fatal(err)
	}
	claimed, err = store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{WorkerID: "builder-a", Now: base})
	if err != nil || claimed != nil {
		t.Fatalf("foreign binding must leave job queued: claimed=%#v err=%v", claimed, err)
	}

	loaded, err = store.loadReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	bindings = recordSlice(loaded, "environmentResources")
	bindings[1]["environmentId"] = "env-a"
	setRecordSlice(loaded, "environmentResources", bindings)
	if err := store.save(loaded); err != nil {
		t.Fatal(err)
	}
	claimed, err = store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{WorkerID: "builder-a", Now: base})
	if err != nil || claimed == nil || claimed.ID != "job-template" {
		t.Fatalf("all exact ready bindings must permit claim: claimed=%#v err=%v", claimed, err)
	}
}

func TestPostgresTemplateResourceGateIsPartOfCandidateClaim(t *testing.T) {
	candidateSQL := strings.SplitN(claimWorkflowJobSQL, "), candidate AS (", 2)[1]
	for _, fragment := range []string{`wj.payload -> 'templateResourceIds'`, `"EnvironmentResource"`, `resource.status`, `resource."projectId" = deployment."projectId"`, `resource_binding."environmentId" = deployment."environmentId"`} {
		if !strings.Contains(candidateSQL, fragment) {
			t.Fatalf("claim SQL lacks template readiness fence %q", fragment)
		}
	}
}

func TestTemplateResourcesRejectMissingMalformedAndForeignDependencies(t *testing.T) {
	for _, name := range []string{"missing list", "null list", "string list", "non-string id", "blank id", "padded id", "missing resource", "foreign project", "foreign environment", "missing environment", "missing binding", "failed resource"} {
		t.Run(name, func(t *testing.T) {
			payload := map[string]any{"deploymentId": "deployment-a", "sourceType": "template", "templateResourceIds": []any{"resource-a"}}
			job := record{"payload": payload}
			deployment := map[string]any{"id": "deployment-a", "projectId": "project-a", "environmentId": "env-a"}
			resource := map[string]any{"id": "resource-a", "projectId": "project-a", "status": "READY"}
			binding := map[string]any{"resourceId": "resource-a", "projectId": "project-a", "environmentId": "env-a"}
			state := map[string]any{"deployments": []any{deployment}, "resources": []any{resource}, "environmentResources": []any{binding}}
			switch name {
			case "missing list":
				delete(payload, "templateResourceIds")
			case "null list":
				payload["templateResourceIds"] = nil
			case "string list":
				payload["templateResourceIds"] = "resource-a"
			case "non-string id":
				payload["templateResourceIds"] = []any{1}
			case "blank id":
				payload["templateResourceIds"] = []any{""}
			case "padded id":
				payload["templateResourceIds"] = []any{" resource-a "}
			case "missing resource":
				state["resources"] = []any{}
			case "foreign project":
				resource["projectId"] = "foreign"
			case "foreign environment":
				binding["environmentId"] = "foreign"
			case "missing environment":
				delete(deployment, "environmentId")
			case "missing binding":
				state["environmentResources"] = []any{}
			case "failed resource":
				resource["status"] = "PROVISION_FAILED"
			}
			if templateResourcesReady(state, job) {
				t.Fatal("invalid template dependency was ready")
			}
		})
	}
}
