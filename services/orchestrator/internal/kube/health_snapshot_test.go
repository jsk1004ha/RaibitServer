package kube

import (
	"encoding/json"
	"testing"

	"github.com/raibitserver/orchestrator/internal/store"
)

func TestHealthHappyCapturedPathsRemainImmutable(t *testing.T) {
	// Given: live values differ from captured values and cannot override them.
	project := &store.Project{ID: "project-1", OrganizationID: "org-1", Slug: "demo"}
	service := &store.Service{ID: "service-1", ProjectID: project.ID, Type: "web", Slug: "web", HealthCheckPath: "/live-common", LivenessPath: "/live-live", ReadinessPath: "/live-ready", PublicHealthPath: "/live-public", DesiredSpec: map[string]any{"healthCheckPath": "/live-common"}}
	deployment := &store.Deployment{ID: "deployment-1", ServiceID: service.ID, ProjectID: project.ID, SnapshotVersion: 1, DesiredSpecSnapshot: json.RawMessage(`{"type":"web","healthCheckPath":"/captured-common","readinessPath":"/captured-ready","livenessPath":null,"publicHealthPath":"/captured-public"}`)}
	// When
	spec := SpecFromState(project, service, deployment, "example.test")
	// Then
	if spec.HealthCheckPath != "/captured-common" || spec.ReadinessPath != "/captured-ready" || spec.LivenessPath != "" || spec.EffectivePublicHealthPath() != "/captured-public" {
		t.Fatalf("snapshot paths=%#v", spec)
	}
}

func TestHealthFailureMatrixRejectsPublicPathOnNonWeb(t *testing.T) {
	for _, kind := range []string{"private", "worker", "cron", "job"} {
		t.Run(kind, func(t *testing.T) {
			// Given
			spec := workloadSpec(kind, "dep-health", map[string]any{"publicHealthPath": "/health"}, nil)
			// When
			plan := NewDeploymentPlan(spec)
			// Then
			if plan.Safe {
				t.Fatal("nonweb public path accepted")
			}
		})
	}
}

func TestHealthFailureMatrixRejectsConflictingAliases(t *testing.T) {
	// Given
	spec := workloadSpec("web", "dep-health", map[string]any{"healthCheckPath": "/new", "healthCheck": map[string]any{"path": "/old"}}, nil)
	// When
	plan := NewDeploymentPlan(spec)
	// Then
	if plan.Safe {
		t.Fatal("conflicting alias accepted")
	}
}
