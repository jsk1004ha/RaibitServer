package identity

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
)

var (
	ErrIdentity = errors.New("runtime identity rejected")
	ErrLegacy   = errors.New("unverifiable_legacy_deployment")
)

// Scope contains only database-derived authority and a nonsecret snapshot digest.
type Scope struct {
	OrganizationID, ProjectID, ServiceID, DeploymentID   string
	Namespace, Name, Kind, Container, Image, Fingerprint string
	Command, Args, EnvironmentHash                       string
}

type Input struct {
	OrganizationID, ProjectID, ServiceProjectID, ServiceID, DeploymentID      string
	ProjectSlug, ProjectName, ServiceSlug, ServiceName                        string
	ServiceType, DeploymentType, Status, Action, ProjectStatus, ServiceStatus string
	ProjectDeleting, ServiceDeleting                                          bool
	ImageURL, ImageDigest, LiveImageURL                                       string
	SnapshotVersion, PullRequestNumber                                        int
	Snapshot, LiveSpec                                                        json.RawMessage
	TriggerType, SourceDeploymentID, RetryOfDeploymentID, CommitSHA           string
}

func Parse(input Input) (Scope, error) {
	for _, value := range []string{input.OrganizationID, input.ProjectID, input.ServiceID, input.DeploymentID} {
		if value == "" || len(value) > 256 {
			return Scope{}, ErrIdentity
		}
	}
	if input.ProjectID != input.ServiceProjectID || input.ProjectDeleting || input.ServiceDeleting || deleting(input.ProjectStatus) || deleting(input.ServiceStatus) || strings.Contains(strings.ToUpper(input.Action), "CLEANUP") {
		return Scope{}, ErrIdentity
	}
	switch strings.ToUpper(input.Status) {
	case "DEPLOYING", "READY", "FAILED":
	default:
		return Scope{}, ErrIdentity
	}
	missing := len(input.Snapshot) == 0 || string(input.Snapshot) == "null"
	if missing || input.SnapshotVersion != 1 {
		return Scope{}, ErrLegacy
	}
	if len(input.Snapshot) > 1024*1024 {
		return Scope{}, ErrIdentity
	}
	snapshot, err := parseSnapshot(input.Snapshot)
	if err != nil {
		return Scope{}, err
	}
	envHash, err := runtimeEnvironment(input, snapshot)
	if err != nil {
		return Scope{}, err
	}
	runtimeType := snapshot.Type
	image := input.ImageURL
	if image == "" || len(image) > 2048 || strings.ContainsAny(image, " \t\r\n") {
		return Scope{}, ErrIdentity
	}
	if input.ImageDigest != "" {
		if !digestPattern.MatchString(input.ImageDigest) {
			return Scope{}, ErrIdentity
		}
		if parts := strings.Split(image, "@"); len(parts) > 1 {
			if len(parts) != 2 || parts[1] != input.ImageDigest {
				return Scope{}, ErrIdentity
			}
		} else {
			if colon := strings.LastIndex(image, ":"); colon > strings.LastIndex(image, "/") {
				image = image[:colon]
			}
			image += "@" + input.ImageDigest
		}
	}
	if parts := strings.Split(image, "@"); len(parts) > 1 && (len(parts) != 2 || !digestPattern.MatchString(parts[1])) {
		return Scope{}, ErrIdentity
	}
	namespace := bounded(normalize(input.OrganizationID)+"--"+normalize(first(input.ProjectSlug, input.ProjectName, input.ProjectID)), input.OrganizationID+"\x00"+input.ProjectID, 63)
	name := bounded(first(input.ServiceSlug, input.ServiceName, input.ServiceID), input.ServiceID, 63)
	if input.DeploymentType == "preview" && input.PullRequestNumber > 0 {
		name = previewName(name, input)
	}
	workload, kind := name, "Deployment"
	switch strings.ToLower(strings.TrimSpace(runtimeType)) {
	case "web", "private", "worker":
	case "cron":
		kind = "CronJob"
		workload = bounded(name, input.ServiceID+"\x00"+name, 52)
	case "job", "one-off", "one_off":
		kind = "Job"
		workload = bounded(name, name, 50) + "-" + suffix(input.DeploymentID)
	default:
		return Scope{}, ErrIdentity
	}
	// Exclude status/health timestamps: an allowed rollout transition is not a new identity.
	input.Status, input.ProjectStatus, input.ServiceStatus, input.Action = "", "", "", ""
	input.ServiceType, input.LiveImageURL, input.LiveSpec = "", "", nil
	raw, err := json.Marshal(input)
	if err != nil {
		return Scope{}, ErrIdentity
	}
	hash := sha256.Sum256(raw)
	return Scope{OrganizationID: input.OrganizationID, ProjectID: input.ProjectID, ServiceID: input.ServiceID, DeploymentID: input.DeploymentID, Namespace: namespace, Name: workload, Kind: kind, Container: name, Image: image, Fingerprint: hex.EncodeToString(hash[:]), Command: strings.Join(snapshot.Command, "\x00"), Args: strings.Join(snapshot.Args, "\x00"), EnvironmentHash: envHash}, nil
}

func deleting(status string) bool {
	switch strings.ToUpper(status) {
	case "DELETE_REQUESTED", "DELETING", "DELETED":
		return true
	default:
		return false
	}
}
