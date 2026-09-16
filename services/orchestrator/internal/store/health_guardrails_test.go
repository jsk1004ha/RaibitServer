package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestHealthFileGuardrails(t *testing.T)     { runHealthGuardrails(t, false) }
func TestHealthPostgresGuardrails(t *testing.T) { runHealthGuardrails(t, true) }

func runHealthGuardrails(t *testing.T, postgres bool) {
	t.Run("nullable_health_and_scalar_projection", func(t *testing.T) {
		// Given
		h := newHealthHarness(t, postgres)
		p := h.input.Observation
		h.mutate(t, "Service", p.ServiceID, record{"healthCheckPath": "/common", "readinessPath": "/ready", "livenessPath": "/live", "publicHealthPath": "/public"})
		h.mutate(t, "Deployment", p.DeploymentID, record{"status": "IMAGE_READY", "publicHealthStatus": nil})
		reader, ok := h.HealthStore.(interface {
			GetService(context.Context, string) (*Service, error)
			ClaimNextDeployment(context.Context, ClaimOptions) (*Deployment, error)
		})
		if !ok {
			t.Fatal("missing projection")
		}
		// When
		service, err := reader.GetService(t.Context(), p.ServiceID)
		if err != nil {
			t.Fatal(err)
		}
		deployment, err := reader.ClaimNextDeployment(t.Context(), ClaimOptions{Now: h.input.Now, WorkerID: "projection"})
		// Then
		if err != nil || deployment == nil || deployment.PublicHealthStatus != "UNKNOWN" || service.HealthCheckPath != "/common" || service.ReadinessPath != "/ready" || service.LivenessPath != "/live" || service.PublicHealthPath != "/public" {
			t.Fatalf("projection: %+v %+v %v", service, deployment, err)
		}
	})
	t.Run("crashes_stop_after_three_claims", func(t *testing.T) {
		// Given
		h := newHealthHarness(t, postgres)
		h.ready(t)
		for i := range 3 {
			job := h.claim(t, h.input.Now.Add(time.Duration(i)*30*time.Second))
			if job.Attempts != i+1 {
				t.Fatal("claim attempt mismatch")
			}
		}
		// When
		job, err := h.ClaimNextHealth(t.Context(), ClaimOptions{Now: h.input.Now.Add(90 * time.Second), WorkerID: "fourth"})
		// Then
		if err != nil || job != nil || stringField(h.row(t, "Deployment", h.input.Lease.DeploymentID), "publicHealthStatus") != "UNKNOWN" {
			t.Fatalf("crash budget: %+v %v", job, err)
		}
	})
	t.Run("expired_rollout_cannot_publish", func(t *testing.T) {
		// Given
		h := newHealthHarness(t, postgres)
		h.input.Now = h.input.Now.Add(15 * time.Minute)
		// When
		_, err := h.CompleteRollout(t.Context(), h.input)
		// Then
		if !errors.Is(err, ErrDeploymentLeaseLost) || stringField(h.row(t, "Deployment", h.input.Lease.DeploymentID), "status") != "DEPLOYING" {
			t.Fatalf("expired rollout published: %v", err)
		}
	})
	t.Run("nonpublic_generation_has_no_job", func(t *testing.T) {
		// Given
		h := newHealthHarness(t, postgres)
		h.input.Observation.Public = false
		h.input.Observation.GeneratedHost = ""
		h.input.Observation.EffectivePath = ""
		// When
		d, err := h.CompleteRollout(t.Context(), h.input)
		// Then
		if err != nil || d.ObservedGeneration != 7 || d.PublicHealthStatus != "UNKNOWN" {
			t.Fatalf("nonpublic generation: %+v %v", d, err)
		}
		job, err := h.ClaimNextHealth(t.Context(), ClaimOptions{Now: h.input.Now, WorkerID: "none"})
		if err != nil || job != nil {
			t.Fatal("nonpublic job")
		}
	})
	t.Run("dry_run_generation_is_null", func(t *testing.T) {
		// Given
		h := newHealthHarness(t, postgres)
		h.input.Observation = nil
		// When
		d, err := h.CompleteRollout(t.Context(), h.input)
		// Then
		if err != nil || d.ObservedGeneration != 0 || h.row(t, "Deployment", h.input.Lease.DeploymentID)["observedGeneration"] != nil {
			t.Fatalf("dry generation: %+v %v", d, err)
		}
	})
	t.Run("cancel_resets_same_pending_health", func(t *testing.T) {
		// Given
		h := newHealthHarness(t, postgres)
		h.ready(t)
		job := h.claim(t, h.input.Now)
		// When
		err := h.CancelHealth(t.Context(), job.Lease(), h.input.Now.Add(time.Second))
		// Then
		if err != nil || stringField(h.row(t, "Deployment", h.input.Lease.DeploymentID), "publicHealthStatus") != "UNKNOWN" || stringField(h.row(t, "WorkflowJob", job.ID), "status") != "cancelled" {
			t.Fatalf("cancel: %v", err)
		}
	})
	t.Run("project_finalizer_cancels_orphan", func(t *testing.T) {
		// Given
		h := newHealthHarness(t, postgres)
		h.ready(t)
		job := h.claim(t, h.input.Now)
		p := h.input.Observation
		h.delete(t, "Service", p.ServiceID)
		h.mutate(t, "Project", p.ProjectID, record{"status": "DELETING", "updatedAt": h.input.Now.Format(time.RFC3339Nano)})
		finalizer, ok := h.HealthStore.(interface {
			FinalizeProjectDeletion(context.Context, DeletionLease) error
		})
		if !ok {
			t.Fatal("missing project finalizer")
		}
		// When
		err := finalizer.FinalizeProjectDeletion(t.Context(), DeletionLease{ID: p.ProjectID, ClaimedAt: h.input.Now})
		// Then
		if err != nil || stringField(h.row(t, "WorkflowJob", job.ID), "status") != "cancelled" {
			t.Fatalf("project orphan: %v", err)
		}
	})
}

func TestHealthSnapshotPathsAreCapturedAndCleared(t *testing.T) {
	for _, tc := range []struct {
		snapshot string
		path     string
		valid    bool
	}{
		{`{"type":"web","healthCheckPath":"/captured","readinessPath":"/ready"}`, "/captured", true},
		{`{"type":"web","healthCheckPath":null}`, "", true},
		{`{"type":"web"}`, "", true},
		{`{"type":"web","healthCheck":{"path":"/legacy"}}`, "/legacy", true},
		{`{"type":"web","healthCheckPath":null,"healthCheck":{"path":"/legacy"}}`, "", false},
		{`{"type":"worker","publicHealthPath":"/"}`, "", false},
		{`{"type":"web","readinessPath":"/%2e%2e"}`, "", false},
	} {
		t.Run(tc.snapshot, func(t *testing.T) {
			// Given
			live := &Service{Type: "web", HealthCheckPath: "/live", ReadinessPath: "/live-ready", PublicHealthPath: "/live-public", LivenessPath: "/live-alive"}
			deployment := &Deployment{SnapshotVersion: 1, DesiredSpecSnapshot: json.RawMessage(tc.snapshot)}
			// When
			view, err := deployment.RuntimeService(live)
			// Then
			if !tc.valid {
				if err == nil {
					t.Fatal("invalid health snapshot accepted")
				}
				return
			}
			if err != nil || view.HealthCheckPath != tc.path || view.PublicHealthPath != "" || view.LivenessPath != "" || live.HealthCheckPath != "/live" {
				t.Fatalf("captured paths: %+v %v", view, err)
			}
		})
	}
}
