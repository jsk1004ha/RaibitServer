package store

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestHealthFileLifecycle(t *testing.T)     { runHealthLifecycle(t, false) }
func TestHealthPostgresLifecycle(t *testing.T) { runHealthLifecycle(t, true) }

func runHealthLifecycle(t *testing.T, postgres bool) {
	t.Run("retry_delays_and_final_third_failure", func(t *testing.T) {
		// Given: a READY observation with three bounded attempts.
		h := newHealthHarness(t, postgres)
		h.ready(t)
		at := h.input.Now
		first := h.claim(t, at)
		for attempt, delay := range []time.Duration{5 * time.Second, 15 * time.Second, 0} {
			job := first
			if attempt > 0 {
				job = h.claim(t, at)
			}
			// When: retryable HTTP status failures exhaust the allowance.
			err := h.FinishHealth(t.Context(), HealthCompletion{Lease: job.Lease(), Now: at, Status: "DEGRADED", FailureCode: "PUBLIC_HEALTH_HTTP_STATUS", Retryable: true})
			if err != nil {
				t.Fatal(err)
			}
			// Then: no early claims; a fixed absolute deadline; final-only checkedAt.
			row := h.row(t, "Deployment", h.input.Lease.DeploymentID)
			if attempt < 2 {
				next, err := h.ClaimNextHealth(t.Context(), ClaimOptions{Now: at.Add(delay - time.Millisecond), WorkerID: "early"})
				if err != nil || next != nil || stringField(row, "healthCheckedAt") != "" {
					t.Fatalf("early retry/final timestamp: %+v %v", next, err)
				}
			} else if stringField(row, "publicHealthStatus") != "DEGRADED" || stringField(row, "healthFailureCode") != "PUBLIC_HEALTH_HTTP_STATUS" || stringField(h.row(t, "WorkflowJob", job.ID), "status") != "failed" {
				t.Fatalf("exhaustion: %+v", row)
			}
			if !job.Payload.AbsoluteDeadline.Equal(h.input.Now.Add(180 * time.Second)) {
				t.Fatal("deadline moved")
			}
			at = at.Add(delay)
		}
	})
	t.Run("renewal_and_expired_worker_fence", func(t *testing.T) {
		// Given
		h := newHealthHarness(t, postgres)
		h.ready(t)
		job := h.claim(t, h.input.Now)
		// When
		if err := h.RenewHealthLease(t.Context(), job.Lease(), h.input.Now.Add(10*time.Second)); err != nil {
			t.Fatal(err)
		}
		got, err := h.ClaimNextHealth(t.Context(), ClaimOptions{Now: h.input.Now.Add(30 * time.Second), WorkerID: "other"})
		// Then
		if err != nil || got != nil {
			t.Fatalf("renewal not respected: %+v %v", got, err)
		}
		if err := h.FinishHealth(t.Context(), HealthCompletion{Lease: job.Lease(), Now: h.input.Now.Add(40 * time.Second), Status: "HEALTHY"}); !errors.Is(err, ErrHealthLeaseLost) {
			t.Fatalf("expired completion: %v", err)
		}
	})
	t.Run("deadline_returns_lease_for_identity_fence", func(t *testing.T) {
		// Given
		h := newHealthHarness(t, postgres)
		h.ready(t)
		// When
		job, err := h.ClaimNextHealth(t.Context(), ClaimOptions{Now: h.input.Now.Add(180 * time.Second), WorkerID: "late"})
		// Then
		row := h.row(t, "Deployment", h.input.Lease.DeploymentID)
		if err != nil || job == nil || stringField(row, "publicHealthStatus") != "CHECKING" || stringField(row, "healthCheckedAt") != "" {
			t.Fatalf("deadline: %+v %+v %v", job, row, err)
		}
	})
	t.Run("concurrent_claim_has_one_winner", func(t *testing.T) {
		// Given
		h := newHealthHarness(t, postgres)
		h.ready(t)
		start := make(chan struct{})
		results := make(chan *HealthJob, 2)
		errs := make(chan error, 2)
		var group sync.WaitGroup
		for range 2 {
			group.Add(1)
			go func() {
				defer group.Done()
				<-start
				job, err := h.ClaimNextHealth(t.Context(), ClaimOptions{Now: h.input.Now, WorkerID: "race"})
				results <- job
				errs <- err
			}()
		}
		// When
		close(start)
		group.Wait()
		close(results)
		close(errs)
		// Then
		count := 0
		for job := range results {
			if job != nil {
				count++
			}
		}
		for err := range errs {
			if err != nil {
				t.Fatal(err)
			}
		}
		if count != 1 {
			t.Fatalf("claim winners=%d", count)
		}
	})
	for _, field := range []string{"reconcileAttempts", "observedGeneration", "status"} {
		t.Run("stale_"+field, func(t *testing.T) {
			// Given
			h := newHealthHarness(t, postgres)
			h.ready(t)
			job := h.claim(t, h.input.Now)
			value := any(99)
			if field == "status" {
				value = "PREVIEW_CLEANUP_REQUESTED"
			}
			h.mutate(t, "Deployment", h.input.Lease.DeploymentID, record{field: value})
			// When
			err := h.FinishHealth(t.Context(), HealthCompletion{Lease: job.Lease(), Now: h.input.Now.Add(time.Second), Status: "HEALTHY"})
			// Then
			if !errors.Is(err, ErrHealthLeaseLost) || stringField(h.row(t, "WorkflowJob", job.ID), "status") != "cancelled" {
				t.Fatalf("stale mutation: %v", err)
			}
			d := h.row(t, "Deployment", h.input.Lease.DeploymentID)
			if stringField(d, "healthCheckedAt") != "" {
				t.Fatal("stale result wrote health")
			}
		})
	}
	for _, table := range []string{"Service", "Project", "Deployment"} {
		t.Run("orphan_"+table, func(t *testing.T) {
			// Given
			h := newHealthHarness(t, postgres)
			h.ready(t)
			job := h.claim(t, h.input.Now)
			id := h.input.Lease.DeploymentID
			if table == "Service" {
				id = h.input.Observation.ServiceID
			}
			if table == "Project" {
				id = h.input.Observation.ProjectID
			}
			h.delete(t, table, id)
			// When
			next, err := h.ClaimNextHealth(t.Context(), ClaimOptions{Now: h.input.Now.Add(time.Second), WorkerID: "cleanup"})
			// Then
			if err != nil || next != nil || stringField(h.row(t, "WorkflowJob", job.ID), "status") != "cancelled" {
				t.Fatalf("orphan cleanup: %+v %v", next, err)
			}
		})
	}
}
