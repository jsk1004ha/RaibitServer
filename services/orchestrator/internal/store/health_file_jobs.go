package store

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"
)

func fileHealthJob(row record) (HealthJob, error) {
	raw, err := json.Marshal(row["payload"])
	if err != nil {
		return HealthJob{}, err
	}
	payload, err := parseHealthObservation(raw)
	if err != nil {
		return HealthJob{}, err
	}
	job := HealthJob{ID: stringField(row, "id"), Payload: payload, Attempts: intField(row, "attempts"), LockedBy: stringField(row, "lockedBy"), LeaseExpiresAt: parseTimestamp(stringField(row, "lockedAt")).Add(HealthLeaseDuration)}
	if !payload.Public || stringField(row, "targetType") != "deployment" || stringField(row, "targetId") != payload.DeploymentID || job.ID != healthJobID(payload) {
		return HealthJob{}, ErrHealthObservation
	}
	return job, nil
}

func (s *FileStore) ClaimNextHealth(ctx context.Context, options ClaimOptions) (*HealthJob, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	at := healthClock(options.Now)
	worker := strings.TrimSpace(options.WorkerID)
	if worker == "" {
		return nil, ErrHealthLeaseLost
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return nil, err
	}
	jobs := recordSlice(state, "workflowJobs")
	sort.SliceStable(jobs, func(i, j int) bool { return stringField(jobs[i], "id") < stringField(jobs[j], "id") })
	changed := false
	for _, row := range jobs {
		if stringField(row, "type") != PublicHealthObserve {
			continue
		}
		status := stringField(row, "status")
		if status != "queued" && status != "running" {
			continue
		}
		job, parseErr := fileHealthJob(row)
		if parseErr != nil || !currentFileObservation(state, job.Payload) {
			cancelFileHealth(state, row, job.Payload, at)
			changed = true
			continue
		}
		switch status {
		case "queued":
			if parseTimestamp(stringField(row, "runAfter")).After(at) {
				continue
			}
		case "running":
			if job.LeaseExpiresAt.After(at) {
				continue
			}
		}
		d := findRecord(recordSlice(state, "deployments"), job.Payload.DeploymentID)
		if job.Attempts >= 3 {
			cancelFileHealth(state, row, job.Payload, at)
			changed = true
			continue
		}
		row["status"] = "running"
		row["lockedBy"] = worker
		row["lockedAt"] = at.Format(time.RFC3339Nano)
		row["attempts"] = job.Attempts + 1
		row["updatedAt"] = at.Format(time.RFC3339Nano)
		d["publicHealthStatus"] = "CHECKING"
		job.Attempts++
		job.DeploymentType = stringField(d, "deploymentType")
		job.PullRequestNumber = intField(d, "pullRequestNumber")
		job.LockedBy = worker
		job.LeaseExpiresAt = at.Add(HealthLeaseDuration)
		if err := s.save(state); err != nil {
			return nil, err
		}
		return &job, nil
	}
	if changed {
		return nil, s.save(state)
	}
	return nil, nil
}

func (s *FileStore) RenewHealthLease(ctx context.Context, lease HealthLease, at time.Time) error {
	return s.mutateHealth(ctx, HealthCompletion{Lease: lease, Now: at}, "renew")
}

func (s *FileStore) FinishHealth(ctx context.Context, result HealthCompletion) error {
	if !validHealthResult(result) {
		return ErrHealthObservation
	}
	return s.mutateHealth(ctx, result, "finish")
}

func (s *FileStore) CancelHealth(ctx context.Context, lease HealthLease, at time.Time) error {
	return s.mutateHealth(ctx, HealthCompletion{Lease: lease, Now: at}, "cancel")
}

func (s *FileStore) mutateHealth(ctx context.Context, result HealthCompletion, operation string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	result.Now = healthClock(result.Now)
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return err
	}
	row := findRecord(recordSlice(state, "workflowJobs"), result.Lease.JobID)
	if row == nil || stringField(row, "type") != PublicHealthObserve || stringField(row, "status") != "running" {
		return ErrHealthLeaseLost
	}
	job, err := fileHealthJob(row)
	if err != nil {
		return ErrHealthLeaseLost
	}
	if job.LockedBy != result.Lease.WorkerID || job.Attempts != result.Lease.Attempt || !job.LeaseExpiresAt.After(result.Now) {
		return ErrHealthLeaseLost
	}
	if operation == "cancel" {
		cancelFileHealth(state, row, job.Payload, result.Now)
		return s.save(state)
	}
	if !currentFileObservation(state, job.Payload) {
		cancelFileHealth(state, row, job.Payload, result.Now)
		if err := s.save(state); err != nil {
			return err
		}
		return ErrHealthLeaseLost
	}
	if operation == "renew" {
		row["lockedAt"] = result.Now.Format(time.RFC3339Nano)
		row["updatedAt"] = result.Now.Format(time.RFC3339Nano)
		return s.save(state)
	}
	status, health, code, due := healthOutcome(job, result)
	d := findRecord(recordSlice(state, "deployments"), job.Payload.DeploymentID)
	if status == "queued" {
		row["status"] = status
		row["runAfter"] = due.Format(time.RFC3339Nano)
		row["lockedBy"] = nil
		row["lockedAt"] = nil
		row["updatedAt"] = result.Now.Format(time.RFC3339Nano)
	} else {
		result.Status = health
		result.FailureCode = code
		terminalFileHealth(row, d, result, status)
	}
	return s.save(state)
}

func terminalFileHealth(row, d record, result HealthCompletion, status string) {
	row["status"] = status
	row["lockedBy"] = nil
	row["lockedAt"] = nil
	row["updatedAt"] = result.Now.Format(time.RFC3339Nano)
	d["publicHealthStatus"] = result.Status
	d["healthFailureCode"] = nullable(result.FailureCode)
	d["healthCheckedAt"] = result.Now.Format(time.RFC3339Nano)
}

func cancelFileHealth(state map[string]any, row record, p HealthObservation, at time.Time) {
	row["status"] = "cancelled"
	row["lockedBy"] = nil
	row["lockedAt"] = nil
	row["updatedAt"] = at.Format(time.RFC3339Nano)
	d := findRecord(recordSlice(state, "deployments"), p.DeploymentID)
	if sameFileObservation(d, p) && stringField(d, "publicHealthStatus") == "CHECKING" {
		d["publicHealthStatus"] = "UNKNOWN"
	}
}
