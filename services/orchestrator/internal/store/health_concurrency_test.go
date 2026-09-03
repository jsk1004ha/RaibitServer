package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestHealthPostgresDeletionLocksJobsBeforeParents(t *testing.T) {
	// Given: another worker holds the job lease row. Observe the real PG lock queue.
	h := newHealthHarness(t, true)
	h.ready(t)
	job := h.claim(t, h.input.Now)
	lease := DeletionLease{ID: h.input.Observation.ServiceID, ClaimedAt: h.input.Now}
	h.mutate(t, "Service", lease.ID, record{"status": "DELETING", "updatedAt": h.input.Now.Format(time.RFC3339Nano)})
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	gate, err := h.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Rollback()
	var id string
	var pid int
	if err := gate.QueryRowContext(ctx, `SELECT id FROM "WorkflowJob" WHERE id=$1 FOR UPDATE`, job.ID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if err := gate.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	finalizer := NewPostgresStore(h.db)
	done := make(chan error, 1)
	go func() { done <- finalizer.FinalizeServiceDeletion(ctx, lease) }()
	for {
		var waiting bool
		if err := h.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
	}
	// When: the job-row owner needs the parent row to finish its observation.
	probe, err := h.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	lockErr := probe.QueryRowContext(ctx, `SELECT id FROM "Service" WHERE id=$1 FOR UPDATE NOWAIT`, lease.ID).Scan(&id)
	if err := probe.Rollback(); err != nil {
		t.Fatal(err)
	}
	if err := gate.Rollback(); err != nil {
		t.Fatal(err)
	}
	deleteErr := <-done
	// Then: deletion waiting on a job must not hold its parent (no lock cycle).
	if lockErr != nil || deleteErr != nil {
		t.Fatalf("lock order: parent=%v finalizer=%v", lockErr, deleteErr)
	}
}

func TestHealthPostgresParentCompletionRace(t *testing.T) {
	for attempt := range 8 {
		t.Run(fmt.Sprint(attempt), func(t *testing.T) {
			// Given: a deleting service and an outstanding health lease.
			h := newHealthHarness(t, true)
			h.ready(t)
			job := h.claim(t, h.input.Now)
			lease := DeletionLease{ID: h.input.Observation.ServiceID, ClaimedAt: h.input.Now}
			h.mutate(t, "Service", lease.ID, record{"status": "DELETING", "updatedAt": h.input.Now.Format(time.RFC3339Nano)})
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			finalizer, ok := h.HealthStore.(interface {
				FinalizeServiceDeletion(context.Context, DeletionLease) error
			})
			if !ok {
				t.Fatal("missing finalizer")
			}
			start := make(chan struct{})
			deleted := make(chan error, 1)
			finished := make(chan error, 1)
			go func() { <-start; deleted <- finalizer.FinalizeServiceDeletion(ctx, lease) }()
			go func() {
				<-start
				finished <- h.FinishHealth(ctx, HealthCompletion{Lease: job.Lease(), Now: h.input.Now.Add(time.Second), Status: "HEALTHY"})
			}()
			// When: finalization races completion on separate database connections.
			close(start)
			deleteErr, finishErr := <-deleted, <-finished
			// Then: cancellation is atomic and neither operation deadlocks.
			if deleteErr != nil || !errors.Is(finishErr, ErrHealthLeaseLost) || stringField(h.row(t, "WorkflowJob", job.ID), "status") != "cancelled" {
				t.Fatalf("parent/completion race: delete=%v finish=%v", deleteErr, finishErr)
			}
		})
	}
}
