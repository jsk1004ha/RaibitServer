package store

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"
)

func (s *FileStore) ClaimNextPreviewRoute(ctx context.Context, options ClaimOptions) (*PreviewRouteWork, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	at := options.Now.UTC()
	if at.IsZero() {
		at = time.Now().UTC()
	}
	duration := options.Lease
	if duration <= 0 {
		duration = 60 * time.Second
	}
	worker := strings.TrimSpace(options.WorkerID)
	if worker == "" {
		return nil, ErrPreviewContract
	}
	token, err := newPreviewToken()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return nil, err
	}
	lineages := recordSlice(state, "previewLineages")
	sort.SliceStable(lineages, func(i, j int) bool { return stringField(lineages[i], "id") < stringField(lineages[j], "id") })
	for _, lineage := range lineages {
		if leaseUntil := parseTimestamp(stringField(lineage, "reconcileLeaseUntil")); leaseUntil.After(at) {
			continue
		}
		work, ready := previewRouteWorkFromState(state, lineage)
		if !ready {
			continue
		}
		lineage["reconcileToken"] = token
		lineage["reconcileWorker"] = worker
		lineage["reconcileLeaseUntil"] = at.Add(duration).Format(time.RFC3339Nano)
		work.Lease = PreviewRouteLease{LineageID: stringField(lineage, "id"), Version: intField(lineage, "version"), Token: token, WorkerID: worker}
		if err := s.save(state); err != nil {
			return nil, err
		}
		return &work, nil
	}
	return nil, nil
}

func (s *FileStore) RenewPreviewRouteLease(ctx context.Context, lease PreviewRouteLease, at time.Time) error {
	return s.mutatePreviewLineage(ctx, lease, at, func(_ map[string]any, lineage record) error {
		lineage["reconcileLeaseUntil"] = at.UTC().Add(60 * time.Second).Format(time.RFC3339Nano)
		return nil
	})
}

func (s *FileStore) SetPreviewRouteIntent(ctx context.Context, lease PreviewRouteLease, intent PreviewRouteIntent) error {
	return s.mutatePreviewLineage(ctx, lease, time.Now().UTC(), func(_ map[string]any, lineage record) error {
		if !validPreviewIntent(lineage, lease, intent) {
			return ErrPreviewContract
		}
		lineage["routeIntent"] = jsonRecord(intent)
		return nil
	})
}

func (s *FileStore) CompletePreviewRoute(ctx context.Context, lease PreviewRouteLease, observed PreviewRouteObserved) error {
	return s.mutatePreviewLineage(ctx, lease, observed.ObservedAt, func(state map[string]any, lineage record) error {
		intent := mapField(lineage, "routeIntent")
		if !validPreviewObserved(lineage, lease, intent, observed) {
			return ErrPreviewContract
		}
		if stringField(intent, "operation") == PreviewPromote {
			candidateID := stringField(lineage, "candidateDeploymentId")
			candidateGeneration := intField(lineage, "candidateGeneration")
			candidate := findRecord(recordSlice(state, "deployments"), candidateID)
			if stringField(lineage, "state") != PreviewStateOpen || !healthyPreviewCandidate(candidate, lineage) ||
				observed.DeploymentID != candidateID || observed.Generation != candidateGeneration {
				return ErrPreviewContract
			}
			previousID := stringField(lineage, "currentDeploymentId")
			previousGeneration := intField(lineage, "currentGeneration")
			lineage["currentDeploymentId"], lineage["currentGeneration"] = candidateID, candidateGeneration
			lineage["candidateDeploymentId"], lineage["candidateGeneration"] = nil, nil
			if previous := findRecord(recordSlice(state, "deployments"), previousID); previous != nil && previousID != candidateID &&
				stringField(previous, "previewLineageId") == lease.LineageID && intField(previous, "previewGeneration") == previousGeneration && stringField(previous, "status") == DeploymentStatusReady {
				previous["status"] = DeploymentStatusCleanupRequested
			}
		}
		lineage["routeObserved"] = jsonRecord(observed)
		lineage["routeIntent"] = nil
		lineage["reconcileToken"], lineage["reconcileWorker"], lineage["reconcileLeaseUntil"] = nil, nil, nil
		return nil
	})
}

func (s *FileStore) mutatePreviewLineage(ctx context.Context, lease PreviewRouteLease, at time.Time, apply func(map[string]any, record) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return err
	}
	lineage := findRecord(recordSlice(state, "previewLineages"), lease.LineageID)
	if !ownsPreviewLease(lineage, lease, at) {
		return ErrDeploymentLeaseLost
	}
	if err := apply(state, lineage); err != nil {
		return err
	}
	return s.save(state)
}

func previewRouteWorkFromState(state map[string]any, lineage record) (PreviewRouteWork, bool) {
	work := PreviewRouteWork{OrganizationID: stringField(lineage, "organizationId"), ProjectID: stringField(lineage, "projectId"), ServiceID: stringField(lineage, "serviceId"), State: stringField(lineage, "state"), Namespace: stringField(lineage, "namespace"), RouteName: stringField(lineage, "routeName"), StableHost: stringField(lineage, "stableHost"), CurrentDeployment: stringField(lineage, "currentDeploymentId"), CurrentGeneration: intField(lineage, "currentGeneration")}
	if work.State == PreviewStateClosed {
		observed := mapField(lineage, "routeObserved")
		return withOperation(work, PreviewClear), stringField(observed, "uid") != "" || len(mapField(lineage, "routeIntent")) > 0
	}
	if work.State != PreviewStateOpen {
		return work, false
	}
	candidate := findRecord(recordSlice(state, "deployments"), stringField(lineage, "candidateDeploymentId"))
	if !healthyPreviewCandidate(candidate, lineage) {
		return work, false
	}
	observed := mapField(lineage, "routeObserved")
	if stringField(observed, "deploymentId") == stringField(candidate, "id") && intField(observed, "generation") == intField(candidate, "previewGeneration") {
		return work, false
	}
	work.Candidate = deploymentFromRecord(candidate)
	return withOperation(work, PreviewPromote), true
}

func withOperation(work PreviewRouteWork, operation string) PreviewRouteWork {
	work.Operation = operation
	return work
}

func healthyPreviewCandidate(candidate, lineage record) bool {
	return candidate != nil && stringField(candidate, "id") == stringField(lineage, "candidateDeploymentId") &&
		stringField(candidate, "previewLineageId") == stringField(lineage, "id") && intField(candidate, "previewGeneration") == intField(lineage, "candidateGeneration") &&
		stringField(candidate, "status") == DeploymentStatusReady && stringField(candidate, "publicHealthStatus") == "HEALTHY"
}

func ownsPreviewLease(lineage record, lease PreviewRouteLease, at time.Time) bool {
	return lineage != nil && lease.LineageID != "" && lease.Version > 0 && lease.Token != "" && lease.WorkerID != "" &&
		intField(lineage, "version") == lease.Version && stringField(lineage, "reconcileToken") == lease.Token &&
		stringField(lineage, "reconcileWorker") == lease.WorkerID && parseTimestamp(stringField(lineage, "reconcileLeaseUntil")).After(at.UTC())
}

func validPreviewIntent(lineage record, lease PreviewRouteLease, intent PreviewRouteIntent) bool {
	if intent.Version != 1 || intent.LineageVersion != lease.Version || intent.Token != lease.Token || intent.Namespace != stringField(lineage, "namespace") || intent.Name != stringField(lineage, "routeName") || (intent.UID == "") != (intent.ResourceVersion == "") {
		return false
	}
	if intent.Operation == PreviewClear {
		return stringField(lineage, "state") == PreviewStateClosed && intent.DeploymentID == "" && intent.Generation == 0
	}
	return intent.Operation == PreviewPromote && stringField(lineage, "state") == PreviewStateOpen && intent.DeploymentID == stringField(lineage, "candidateDeploymentId") && intent.Generation == intField(lineage, "candidateGeneration")
}

func validPreviewObserved(lineage record, lease PreviewRouteLease, intent record, observed PreviewRouteObserved) bool {
	if observed.Version != 1 || observed.LineageVersion != lease.Version || observed.Namespace != stringField(lineage, "namespace") || observed.Name != stringField(lineage, "routeName") || observed.ObservedAt.IsZero() || stringField(intent, "token") != lease.Token {
		return false
	}
	if stringField(intent, "operation") == PreviewClear {
		return observed.UID == "" && observed.ResourceVersion == "" && observed.DeploymentID == "" && observed.Generation == 0
	}
	return observed.UID != "" && observed.ResourceVersion != "" && (stringField(intent, "uid") == "" || observed.UID == stringField(intent, "uid")) && observed.DeploymentID == stringField(intent, "deploymentId") && observed.Generation == intField(intent, "generation")
}

func jsonRecord(value any) record {
	raw, _ := json.Marshal(value)
	var result record
	_ = json.Unmarshal(raw, &result)
	return result
}
