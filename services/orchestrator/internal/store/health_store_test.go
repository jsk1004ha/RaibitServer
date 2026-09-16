package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func healthFixture(t *testing.T) (*FileStore, RolloutCompletion) {
	t.Helper()
	at := time.Date(2026, 9, 3, 10, 0, 0, 0, time.UTC)
	s := NewFileStore(filepath.Join(t.TempDir(), "state.json"))
	state := map[string]any{}
	setRecordSlice(state, "projects", []record{{"id": "p", "status": "ACTIVE"}})
	setRecordSlice(state, "services", []record{{"id": "s", "projectId": "p", "type": "web", "status": "ACTIVE"}})
	setRecordSlice(state, "deployments", []record{{"id": "d", "projectId": "p", "serviceId": "s", "status": "DEPLOYING", "reconcileLockedBy": "rollout", "reconcileLockedAt": at.Format(time.RFC3339Nano), "reconcileAttempts": 2, "reconcileAction": "apply", "createdAt": at.Format(time.RFC3339Nano)}})
	if err := s.save(state); err != nil {
		t.Fatal(err)
	}
	return s, RolloutCompletion{Lease: DeploymentLease{DeploymentID: "d", WorkerID: "rollout", Attempt: 2, Action: "apply"}, Now: at, ImageURL: "registry/app@sha256:abc", Observation: &HealthObservation{ProjectID: "p", ServiceID: "s", DeploymentID: "d", RolloutAttempt: 2, Namespace: "tenant-p", WorkloadName: "web", WorkloadUID: "uid-1", ObservedGeneration: 7, GeneratedHost: "apps--org--project.raibitserver.app", EffectivePath: "/ready", Public: true}}
}

func TestHealthFileReadyAtomicAndIdempotent(t *testing.T) {
	// Given
	s, complete := healthFixture(t)
	// When
	first, err := s.CompleteRollout(context.Background(), complete)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.CompleteRollout(context.Background(), complete)
	// Then
	if err != nil || first.Status != "READY" || first.ObservedGeneration != 7 {
		t.Fatalf("ready result: %+v %v", first, err)
	}
	state, err := s.loadReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	jobs := recordSlice(state, "workflowJobs")
	d := findRecord(recordSlice(state, "deployments"), "d")
	if len(jobs) != 1 || stringField(d, "reconcileLockedBy") != "" || stringField(d, "publicHealthStatus") != "UNKNOWN" {
		t.Fatalf("atomic READY/job: %+v", state)
	}
}

func TestHealthFileRetryReclaimAndFence(t *testing.T) {
	// Given
	s, complete := healthFixture(t)
	ctx := context.Background()
	if _, err := s.CompleteRollout(ctx, complete); err != nil {
		t.Fatal(err)
	}
	job, err := s.ClaimNextHealth(ctx, ClaimOptions{Now: complete.Now, WorkerID: "a"})
	if err != nil || job == nil {
		t.Fatalf("claim: %v", err)
	}
	// When: crashed worker expires; its replacement owns a new attempt.
	next, err := s.ClaimNextHealth(ctx, ClaimOptions{Now: complete.Now.Add(30 * time.Second), WorkerID: "b"})
	if err != nil || next == nil {
		t.Fatalf("reclaim: %v", err)
	}
	err = s.FinishHealth(ctx, HealthCompletion{Lease: job.Lease(), Now: complete.Now.Add(31 * time.Second), Status: "HEALTHY"})
	// Then
	if !errors.Is(err, ErrHealthLeaseLost) || next.Attempts != 2 || !next.Payload.AbsoluteDeadline.Equal(complete.Now.Add(180*time.Second)) {
		t.Fatalf("fence/deadline: %+v %v", next, err)
	}
}

func TestHealthFileFinalPreservesRollout(t *testing.T) {
	// Given
	s, complete := healthFixture(t)
	ctx := context.Background()
	if _, err := s.CompleteRollout(ctx, complete); err != nil {
		t.Fatal(err)
	}
	before, err := s.loadReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	job, err := s.ClaimNextHealth(ctx, ClaimOptions{Now: complete.Now, WorkerID: "a"})
	if err != nil || job == nil {
		t.Fatalf("claim: %v", err)
	}
	// When
	err = s.FinishHealth(ctx, HealthCompletion{Lease: job.Lease(), Now: complete.Now.Add(time.Second), Status: "HEALTHY"})
	// Then
	if err != nil {
		t.Fatal(err)
	}
	after, err := s.loadReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	d := findRecord(recordSlice(after, "deployments"), "d")
	old := findRecord(recordSlice(before, "deployments"), "d")
	for _, key := range []string{"status", "deployedAt", "finishedAt", "errorCode", "errorMessage", "imageUrl"} {
		if stringField(d, key) != stringField(old, key) {
			t.Fatalf("rewrote rollout field %s", key)
		}
	}
	if stringField(d, "publicHealthStatus") != "HEALTHY" || stringField(recordSlice(after, "workflowJobs")[0], "status") != "succeeded" {
		t.Fatalf("atomic final: %+v", after)
	}
}
