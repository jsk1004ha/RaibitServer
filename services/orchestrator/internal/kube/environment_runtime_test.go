package kube

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/raibitserver/orchestrator/internal/store"
)

func Test_SpecFromState_isolates_dev_identity_when_binding_is_authoritative(t *testing.T) {
	// Given
	project := &store.Project{ID: "project-1", OrganizationID: "organization-1", OrganizationSlug: "club", Slug: "festival"}
	service := &store.Service{ID: "service-1", ProjectID: project.ID, Name: "dev-85b178c4c8-web", Slug: "dev-85b178c4c8-web", LogicalSlug: "web", EnvironmentID: "env-dev-001", EnvironmentKind: store.EnvironmentKindDev, Type: "web", ImageURL: "registry.example/web:1", Port: 3000, Replicas: 1}
	deployment := &store.Deployment{ID: "deployment-1", ServiceID: service.ID, ProjectID: project.ID, EnvironmentID: service.EnvironmentID, ImageURL: service.ImageURL}

	// When
	spec := SpecFromState(project, service, deployment, "example.test")
	plan := NewDeploymentPlan(spec)

	// Then
	if spec.InvalidReason != "" || spec.Namespace != "rb-dev-84496d3a91688c7528eb" || spec.Name != service.Slug || spec.Host != "dev--club--festival.example.test" {
		t.Fatalf("unexpected dev runtime identity: %#v", spec)
	}
	for _, manifest := range plan.Manifests {
		metadata := manifest["metadata"].(map[string]any)
		labels := metadata["labels"].(map[string]any)
		if labels["raibitserver.io/environment-id"] != service.EnvironmentID || labels["raibitserver.io/environment-kind"] != "dev" {
			t.Fatalf("missing authoritative environment labels on %s", manifest["kind"])
		}
	}
}

func Test_SpecFromState_rejects_preview_namespace_outside_dev_environment(t *testing.T) {
	project := &store.Project{ID: "project-1", OrganizationID: "organization-1", OrganizationSlug: "club", Slug: "festival"}
	service := &store.Service{ID: "service-1", ProjectID: project.ID, Slug: "dev-a8ad78bc87-api", LogicalSlug: "api", EnvironmentID: "env-dev-001", EnvironmentKind: store.EnvironmentKindDev, Type: "web", ImageURL: "registry.example/api:1"}
	runtime, err := json.Marshal(store.PreviewRuntime{Version: 1, LineageID: "lineage-1", DeploymentID: "deployment-1", Generation: 1, LineageVersion: 1, StableHost: "preview--stable.example.test", ProbeHost: "preview--probe.example.test", Namespace: "attacker", WorkloadName: "preview-api", ServiceName: "preview-api", ProbeIngressName: "preview-api", RouteName: "preview-route"})
	if err != nil {
		t.Fatal(err)
	}
	deployment := &store.Deployment{ID: "deployment-1", ServiceID: service.ID, ProjectID: project.ID, EnvironmentID: service.EnvironmentID, PreviewLineageID: "lineage-1", PreviewGeneration: 1, PreviewRuntimeJSON: runtime}

	spec := SpecFromState(project, service, deployment, "example.test")
	if !strings.Contains(spec.InvalidReason, "namespace does not match environment binding") {
		t.Fatalf("expected preview namespace rejection, got %q", spec.InvalidReason)
	}
}

func Test_SpecFromState_rejects_cross_environment_deployment(t *testing.T) {
	// Given
	project := &store.Project{ID: "project-1", OrganizationID: "organization-1", OrganizationSlug: "club", Slug: "festival"}
	service := &store.Service{ID: "service-1", ProjectID: project.ID, Slug: "dev-85b178c4c8-web", LogicalSlug: "web", EnvironmentID: "env-dev-001", EnvironmentKind: store.EnvironmentKindDev, Type: "web"}
	deployment := &store.Deployment{ID: "deployment-1", ServiceID: service.ID, ProjectID: project.ID, EnvironmentID: "env-dev-002"}

	// When
	spec := SpecFromState(project, service, deployment, "example.test")

	// Then
	if !strings.Contains(spec.InvalidReason, "deployment environment does not match service binding") {
		t.Fatalf("expected cross-environment rejection, got %q", spec.InvalidReason)
	}
}

func Test_SpecFromState_rejects_stale_dev_physical_identity(t *testing.T) {
	project := &store.Project{ID: "project-1", OrganizationID: "organization-1", Slug: "festival"}
	service := &store.Service{ID: "service-1", ProjectID: project.ID, Slug: "dev-stale-web", LogicalSlug: "web", EnvironmentID: "env-dev-001", EnvironmentKind: store.EnvironmentKindDev, Type: "web"}
	deployment := &store.Deployment{ID: "deployment-1", ServiceID: service.ID, ProjectID: project.ID, EnvironmentID: service.EnvironmentID}

	spec := SpecFromState(project, service, deployment, "example.test")
	if !strings.Contains(spec.InvalidReason, "physical identity does not match") {
		t.Fatalf("expected stale physical identity rejection, got %q", spec.InvalidReason)
	}
}

func Test_SpecFromState_binds_preview_to_source_dev_environment(t *testing.T) {
	// Given
	project := &store.Project{ID: "project-1", OrganizationID: "organization-1", OrganizationSlug: "club", Slug: "festival"}
	service := &store.Service{ID: "service-1", ProjectID: project.ID, Slug: "dev-a8ad78bc87-api", LogicalSlug: "api", EnvironmentID: "env-dev-001", EnvironmentKind: store.EnvironmentKindDev, Type: "web", ImageURL: "registry.example/api:1"}
	deployment := &store.Deployment{ID: "deployment-1", ServiceID: service.ID, ProjectID: project.ID, EnvironmentID: service.EnvironmentID, DeploymentType: "preview", PullRequestNumber: 32, ImageURL: service.ImageURL}

	// When
	spec := SpecFromState(project, service, deployment, "example.test")

	// Then
	if spec.Host != "preview--pr-32--dev--club--festival--api.example.test" || spec.Namespace != "rb-dev-84496d3a91688c7528eb" {
		t.Fatalf("preview escaped source environment: %#v", spec)
	}
}
