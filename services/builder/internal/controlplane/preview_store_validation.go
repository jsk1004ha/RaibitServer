package controlplane

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

type previewClaimPayload struct {
	version, lineageVersion  int
	lineageID                string
	claimToken               string
	firstClaimAt, deadlineAt time.Time
}

func parsePreviewClaimPayload(raw []byte) (previewClaimPayload, error) {
	var wire struct {
		Version        int    `json:"version"`
		LineageID      string `json:"lineageId"`
		LineageVersion int    `json:"lineageVersion"`
		ClaimToken     string `json:"claimToken"`
		FirstClaimAt   string `json:"firstClaimAt"`
		DeadlineAt     string `json:"deadlineAt"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return previewClaimPayload{}, err
	}
	first, _ := time.Parse(time.RFC3339Nano, wire.FirstClaimAt)
	deadline, _ := time.Parse(time.RFC3339Nano, wire.DeadlineAt)
	return previewClaimPayload{version: wire.Version, lineageID: wire.LineageID, lineageVersion: wire.LineageVersion, claimToken: wire.ClaimToken, firstClaimAt: first, deadlineAt: deadline}, nil
}

func previewBindingActive(row *previewClaimRow) bool {
	if !row.verified || deletingStatus(row.projectStatus) || deletingStatus(row.serviceStatus) || row.repository != row.repositoryOwner+"/"+row.repositoryName {
		return false
	}
	var desired struct {
		GitHub struct {
			IntegrationID  string `json:"integrationId"`
			InstallationID string `json:"installationId"`
			RepositoryID   string `json:"repositoryId"`
			Repository     string `json:"repository"`
		} `json:"github"`
	}
	if json.Unmarshal(row.desiredState, &desired) != nil {
		return false
	}
	return desired.GitHub.IntegrationID == row.integrationID && desired.GitHub.InstallationID == row.installationID && desired.GitHub.RepositoryID == row.repositoryID && desired.GitHub.Repository == row.repository
}

func deletingStatus(status string) bool {
	status = strings.ToUpper(strings.TrimSpace(status))
	return status == "DELETE_REQUESTED" || status == "DELETING" || status == "DELETE_FAILED" || status == "DELETED"
}

func previewClaimLeaseMatches(row *previewClaimRow, claim PreviewResolutionClaim, now time.Time) bool {
	payload, err := parsePreviewClaimPayload(row.payload)
	return err == nil && row.jobID == claim.JobID && row.jobType == PreviewResolveJobType && row.targetType == PreviewTargetType && row.targetID == claim.Target.LineageID && row.status == WorkflowRunning && row.workerID == claim.WorkerID && row.attempts == claim.Attempt && payload.claimToken == claim.ClaimToken && row.lockedAt.Valid && row.lockedAt.Time.After(now.Add(-PreviewLeaseDuration)) && payload.deadlineAt.After(now)
}

func previewClaimMatchesRow(row *previewClaimRow, claim PreviewResolutionClaim) bool {
	return row.lineageVersion == claim.Target.LineageVersion && row.installationID == claim.Target.InstallationID && row.repositoryID == claim.Target.RepositoryID && row.repository == claim.Target.Repository && row.pullNumber == claim.Target.PullRequestNumber
}

func validPreviewObservation(observation PreviewResolutionObservation) bool {
	installationID, installationErr := strconv.ParseInt(observation.InstallationID, 10, 64)
	repositoryID, repositoryErr := strconv.ParseInt(observation.RepositoryID, 10, 64)
	return observation.Version == 1 && observation.LineageID != "" && observation.LineageVersion > 0 &&
		installationErr == nil && installationID > 0 && installationID <= 9007199254740991 && repositoryErr == nil && repositoryID > 0 && repositoryID <= 9007199254740991 &&
		observation.PullRequestNumber > 0 && (observation.State == "open" || observation.State == "closed") && previewSHA.MatchString(observation.HeadSHA) &&
		validPreviewRef(observation.HeadRef) && validPreviewRef(observation.BaseRef) && !observation.UpdatedAt.IsZero() && !observation.ObservedAt.IsZero() &&
		observation.UpdatedAt.Location() == time.UTC && observation.ObservedAt.Location() == time.UTC && observation.UpdatedAt.Equal(observation.UpdatedAt.Truncate(time.Millisecond)) && observation.ObservedAt.Equal(observation.ObservedAt.Truncate(time.Millisecond))
}
