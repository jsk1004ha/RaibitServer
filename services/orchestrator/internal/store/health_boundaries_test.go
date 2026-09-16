package store

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"strings"
	"testing"
	"time"
)

func TestHealthFileBoundaries(t *testing.T)     { runHealthBoundaries(t, false) }
func TestHealthPostgresBoundaries(t *testing.T) { runHealthBoundaries(t, true) }

func runHealthBoundaries(t *testing.T, postgres bool) {
	t.Run("parent_finalizer_cancels_job_atomically", func(t *testing.T) {
		// Given
		h := newHealthHarness(t, postgres)
		h.ready(t)
		job := h.claim(t, h.input.Now)
		lease := DeletionLease{ID: h.input.Observation.ServiceID, ClaimedAt: h.input.Now}
		h.mutate(t, "Service", lease.ID, record{"status": "DELETING", "updatedAt": h.input.Now.Format(time.RFC3339Nano)})
		finalizer, ok := h.HealthStore.(interface {
			FinalizeServiceDeletion(context.Context, DeletionLease) error
		})
		if !ok {
			t.Fatal("missing finalizer")
		}
		// When
		err := finalizer.FinalizeServiceDeletion(t.Context(), lease)
		// Then
		if err != nil || stringField(h.row(t, "WorkflowJob", job.ID), "status") != "cancelled" {
			t.Fatalf("finalizer orphan: %v", err)
		}
	})
	t.Run("ready_insert_failure_rolls_back", func(t *testing.T) {
		// Given: durable publication is forced to fail after preparing READY.
		h := newHealthHarness(t, postgres)
		if h.file != nil {
			if err := os.Mkdir(h.file.path+".tmp", 0o700); err != nil {
				t.Fatal(err)
			}
		} else {
			_, err := h.db.Exec(`CREATE FUNCTION reject_health_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected health insert failure'; END $$;
    CREATE TRIGGER reject_health BEFORE INSERT ON "WorkflowJob" FOR EACH ROW EXECUTE FUNCTION reject_health_insert()`)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if _, err := h.db.Exec(`DROP TRIGGER reject_health ON "WorkflowJob"; DROP FUNCTION reject_health_insert()`); err != nil {
					t.Error(err)
				}
			})
		}
		// When
		_, err := h.CompleteRollout(t.Context(), h.input)
		// Then: neither a READY row nor a released rollout lease is durable.
		row := h.row(t, "Deployment", h.input.Lease.DeploymentID)
		if err == nil || stringField(row, "status") != "DEPLOYING" || stringField(row, "reconcileLockedBy") != "rollout" {
			t.Fatalf("atomic publication failure: %+v %v", row, err)
		}
	})
	t.Run("completion_failure_rolls_back_job", func(t *testing.T) {
		// Given
		h := newHealthHarness(t, postgres)
		h.ready(t)
		job := h.claim(t, h.input.Now)
		if h.file != nil {
			if err := os.Mkdir(h.file.path+".tmp", 0o700); err != nil {
				t.Fatal(err)
			}
		} else {
			_, err := h.db.Exec(`CREATE FUNCTION reject_health_final() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."publicHealthStatus"='HEALTHY' THEN RAISE EXCEPTION 'injected final failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_health_final BEFORE UPDATE ON "Deployment" FOR EACH ROW EXECUTE FUNCTION reject_health_final()`)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if _, err := h.db.Exec(`DROP TRIGGER reject_health_final ON "Deployment"; DROP FUNCTION reject_health_final()`); err != nil {
					t.Error(err)
				}
			})
		}
		// When
		err := h.FinishHealth(t.Context(), HealthCompletion{Lease: job.Lease(), Now: h.input.Now.Add(time.Second), Status: "HEALTHY"})
		// Then
		if err == nil || stringField(h.row(t, "WorkflowJob", job.ID), "status") != "running" || stringField(h.row(t, "Deployment", h.input.Lease.DeploymentID), "publicHealthStatus") != "CHECKING" {
			t.Fatalf("partial final commit: %v", err)
		}
	})
	t.Run("duplicate_ready_preserves_final", func(t *testing.T) {
		// Given
		h := newHealthHarness(t, postgres)
		h.ready(t)
		job := h.claim(t, h.input.Now)
		if err := h.FinishHealth(t.Context(), HealthCompletion{Lease: job.Lease(), Now: h.input.Now, Status: "HEALTHY"}); err != nil {
			t.Fatal(err)
		}
		// When
		d, err := h.CompleteRollout(t.Context(), h.input)
		// Then
		if err != nil || d.PublicHealthStatus != "HEALTHY" || stringField(h.row(t, "WorkflowJob", job.ID), "status") != "succeeded" {
			t.Fatalf("duplicate reset: %+v %v", d, err)
		}
	})
	t.Run("foreign_type_is_never_claimed", func(t *testing.T) {
		// Given
		h := newHealthHarness(t, postgres)
		h.ready(t)
		p := *h.input.Observation
		p.Version = 1
		p.AbsoluteDeadline = h.input.Now.Add(180 * time.Second)
		id := healthJobID(p)
		h.mutate(t, "WorkflowJob", id, record{"type": "build-and-deploy"})
		// When
		job, err := h.ClaimNextHealth(t.Context(), ClaimOptions{Now: h.input.Now, WorkerID: "health"})
		// Then
		if err != nil || job != nil || stringField(h.row(t, "WorkflowJob", id), "status") != "queued" {
			t.Fatalf("foreign dispatch: %+v %v", job, err)
		}
	})
	t.Run("newer_route_rollout_cancels_old", func(t *testing.T) {
		// Given
		h := newHealthHarness(t, postgres)
		h.ready(t)
		job := h.claim(t, h.input.Now)
		p := h.input.Observation
		if h.file != nil {
			state, err := h.file.loadReadOnly()
			if err != nil {
				t.Fatal(err)
			}
			d := cloneMap(findRecord(recordSlice(state, "deployments"), p.DeploymentID))
			d["id"] = p.DeploymentID + "-new"
			d["status"] = "DEPLOYING"
			d["createdAt"] = h.input.Now.Add(time.Second).Format(time.RFC3339Nano)
			setRecordSlice(state, "deployments", append(recordSlice(state, "deployments"), d))
			if err := h.file.save(state); err != nil {
				t.Fatal(err)
			}
		} else {
			if _, err := h.db.Exec(`INSERT INTO "Deployment"(id,"serviceId","projectId",status,"createdAt","updatedAt") VALUES($1,$2,$3,'DEPLOYING',$4,$4)`, p.DeploymentID+"-new", p.ServiceID, p.ProjectID, h.input.Now.Add(time.Second)); err != nil {
				t.Fatal(err)
			}
		}
		// When
		err := h.RenewHealthLease(t.Context(), job.Lease(), h.input.Now.Add(10*time.Second))
		// Then
		if !errors.Is(err, ErrHealthLeaseLost) || stringField(h.row(t, "WorkflowJob", job.ID), "status") != "cancelled" {
			t.Fatalf("superseded rollout: %v", err)
		}
	})
	t.Run("wrong_worker_and_untrusted_result_fenced", func(t *testing.T) {
		// Given
		h := newHealthHarness(t, postgres)
		h.ready(t)
		job := h.claim(t, h.input.Now)
		lease := job.Lease()
		lease.WorkerID = "wrong"
		// When
		err := h.FinishHealth(t.Context(), HealthCompletion{Lease: lease, Now: h.input.Now, Status: "HEALTHY"})
		invalid := h.FinishHealth(t.Context(), HealthCompletion{Lease: job.Lease(), Now: h.input.Now, Status: "DEGRADED", FailureCode: "secret body"})
		// Then
		if !errors.Is(err, ErrHealthLeaseLost) || !errors.Is(invalid, ErrHealthObservation) || stringField(h.row(t, "Deployment", h.input.Lease.DeploymentID), "healthCheckedAt") != "" {
			t.Fatalf("worker/result fence: %v %v", err, invalid)
		}
	})
}

func TestHealthObservationBoundedParser(t *testing.T) {
	_, input := healthFixture(t)
	p, err := rolloutObservation(input)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		change func(*HealthObservation)
	}{
		{"generation_zero", func(p *HealthObservation) { p.ObservedGeneration = 0 }},
		{"generation_overflow", func(p *HealthObservation) { p.ObservedGeneration = math.MaxInt32 + 1 }},
		{"version", func(p *HealthObservation) { p.Version = 2 }},
		{"untrusted_hostname", func(p *HealthObservation) { p.GeneratedHost = "https://internal/" }},
		{"path_encoded_slash", func(p *HealthObservation) { p.EffectivePath = "/%2fadmin" }},
		{"path_dot_segment", func(p *HealthObservation) { p.EffectivePath = "/%2e%2e/admin" }},
		{"path_overlong", func(p *HealthObservation) { p.EffectivePath = "/" + strings.Repeat("x", 1024) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Given
			bad := *p
			tc.change(&bad)
			raw, err := json.Marshal(bad)
			if err != nil {
				t.Fatal(err)
			}
			// When
			_, err = parseHealthObservation(raw)
			// Then
			if !errors.Is(err, ErrHealthObservation) {
				t.Fatalf("invalid payload accepted: %v", err)
			}
		})
	}
}
