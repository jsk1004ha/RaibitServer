package store

import (
	"context"
	"encoding/json"
	"time"
)

func (s *FileStore) CompleteRollout(ctx context.Context, input RolloutCompletion) (*Deployment, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	input.Now = healthClock(input.Now)
	observation, err := rolloutObservation(input)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return nil, err
	}
	d := findRecord(recordSlice(state, "deployments"), input.Lease.DeploymentID)
	if d == nil {
		return nil, ErrDeploymentLeaseLost
	}
	if observation != nil && observation.Public && stringField(d, "status") == "READY" && sameFileObservation(d, *observation) {
		existing := findRecord(recordSlice(state, "workflowJobs"), healthJobID(*observation))
		if existing != nil {
			return deploymentFromRecord(d), nil
		}
	}
	duration := input.LeaseDuration
	if duration <= 0 {
		duration = 15 * time.Minute
	}
	lockedAt := parseTimestamp(stringField(d, "reconcileLockedAt"))
	if !recordOwnsDeploymentLease(d, input.Lease) || lockedAt.IsZero() || !lockedAt.Add(duration).After(input.Now) {
		return nil, ErrDeploymentLeaseLost
	}
	if parentsDeletingInState(state, stringField(d, "projectId"), stringField(d, "serviceId")) {
		return nil, ErrParentDeletionRequested
	}
	if service := findRecord(recordSlice(state, "services"), stringField(d, "serviceId")); stringField(service, "projectId") != stringField(d, "projectId") {
		return nil, ErrParentDeletionRequested
	}
	if observation != nil && (observation.ProjectID != stringField(d, "projectId") || observation.ServiceID != stringField(d, "serviceId")) {
		return nil, ErrHealthObservation
	}
	d["status"] = "READY"
	for _, key := range []string{"deployedAt", "finishedAt", "updatedAt"} {
		d[key] = input.Now.Format(time.RFC3339Nano)
	}
	for _, key := range []string{"errorCode", "errorMessage", "reconcileAction", "reconcileLockedBy", "reconcileLockedAt", "healthCheckedAt", "healthFailureCode", "observedGeneration"} {
		d[key] = nil
	}
	d["publicHealthStatus"] = "UNKNOWN"
	if input.ImageURL != "" {
		d["imageUrl"] = input.ImageURL
	}
	if observation != nil {
		d["observedGeneration"] = observation.ObservedGeneration
	}
	if observation != nil && observation.Public {
		raw, err := json.Marshal(observation)
		if err != nil {
			return nil, err
		}
		var payload map[string]any
		if err := json.Unmarshal(raw, &payload); err != nil {
			return nil, err
		}
		jobs := recordSlice(state, "workflowJobs")
		id := healthJobID(*observation)
		if findRecord(jobs, id) == nil {
			jobs = append(jobs, record{"id": id, "type": PublicHealthObserve, "targetType": "deployment", "targetId": observation.DeploymentID, "status": "queued", "payload": payload, "attempts": 0, "maxAttempts": 3, "runAfter": input.Now.Format(time.RFC3339Nano), "createdAt": input.Now.Format(time.RFC3339Nano), "updatedAt": input.Now.Format(time.RFC3339Nano), "lockedBy": nil, "lockedAt": nil})
			setRecordSlice(state, "workflowJobs", jobs)
		}
	}
	if err := s.save(state); err != nil {
		return nil, err
	}
	return deploymentFromRecord(d), nil
}

func sameFileObservation(d record, p HealthObservation) bool {
	return d != nil && stringField(d, "id") == p.DeploymentID && stringField(d, "serviceId") == p.ServiceID && stringField(d, "projectId") == p.ProjectID && intField(d, "reconcileAttempts") == p.RolloutAttempt && intField(d, "observedGeneration") == p.ObservedGeneration
}

func currentFileObservation(state map[string]any, p HealthObservation) bool {
	d := findRecord(recordSlice(state, "deployments"), p.DeploymentID)
	if !sameFileObservation(d, p) || stringField(d, "status") != "READY" || parentsDeletingInState(state, p.ProjectID, p.ServiceID) {
		return false
	}
	if service := findRecord(recordSlice(state, "services"), p.ServiceID); stringField(service, "projectId") != p.ProjectID {
		return false
	}
	for _, other := range recordSlice(state, "deployments") {
		if stringField(other, "serviceId") != p.ServiceID || stringField(other, "id") == p.DeploymentID || stringField(other, "deploymentType") != stringField(d, "deploymentType") || intField(other, "pullRequestNumber") != intField(d, "pullRequestNumber") {
			continue
		}
		switch stringField(other, "status") {
		case "DEPLOYING", "READY":
			left, right := stringField(other, "createdAt"), stringField(d, "createdAt")
			if left > right || (left == right && stringField(other, "id") > p.DeploymentID) {
				return false
			}
		}
	}
	return true
}
