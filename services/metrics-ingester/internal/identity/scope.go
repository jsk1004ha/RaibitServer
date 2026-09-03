package identity

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
)

var ErrIdentity = errors.New("runtime_identity_rejected")

type Scope struct {
	OrganizationID, ProjectID, ServiceID, DeploymentID  string
	Namespace, WorkloadName, Kind, ContainerName, Image string
	Fingerprint                                         string
	EnvironmentHash                                     string
	Command, Args                                       []string
}

type State struct {
	OrganizationID, ProjectID, ServiceID, DeploymentID string
	ProjectSlug, ServiceSlug, DeploymentType           string
	ImageURL, ImageDigest                              string
	CommitSHA                                          string
	PullRequestNumber, SnapshotVersion                 int
	Snapshot                                           json.RawMessage
}

func Parse(state State) (Scope, error) {
	if state.SnapshotVersion != 1 || len(state.Snapshot) > 65536 {
		return Scope{}, ErrIdentity
	}
	spec, err := parseSnapshot(state.Snapshot)
	if err != nil {
		return Scope{}, ErrIdentity
	}
	for _, value := range []string{state.OrganizationID, state.ProjectID, state.ServiceID, state.DeploymentID, state.ProjectSlug, state.ServiceSlug} {
		if value == "" || len(value) > 256 || strings.ContainsAny(value, "\x00\r\n") {
			return Scope{}, ErrIdentity
		}
	}
	name := bounded(state.ServiceSlug, state.ServiceID, 63)
	if state.DeploymentType == "preview" && state.PullRequestNumber > 0 {
		name = suffixed("pr-"+strconv.Itoa(state.PullRequestNumber)+"-"+name, state.DeploymentID, 63)
	}
	scope := Scope{
		OrganizationID: state.OrganizationID, ProjectID: state.ProjectID, ServiceID: state.ServiceID, DeploymentID: state.DeploymentID,
		Namespace: bounded(normalize(state.OrganizationID)+"--"+normalize(state.ProjectSlug), state.OrganizationID+"\x00"+state.ProjectID, 63), WorkloadName: name, ContainerName: name, Command: spec.Command, Args: spec.Args,
	}
	switch strings.ToLower(strings.TrimSpace(spec.Type)) {
	case "web", "private", "worker":
		scope.Kind = "Deployment"
	case "cron":
		scope.Kind = "CronJob"
		scope.WorkloadName = bounded(name, state.ServiceID+"\x00"+name, 52)
	case "job", "one-off", "one_off":
		scope.Kind = "Job"
		scope.WorkloadName = bounded(name, name, 50) + "-" + digest(state.DeploymentID)[:12]
	default:
		return Scope{}, ErrIdentity
	}
	image := strings.TrimSpace(state.ImageURL)
	if image == "" || len(image) > 2048 || strings.ContainsAny(image, "\r\n\x00") {
		return Scope{}, ErrIdentity
	}
	if state.ImageDigest != "" {
		if !shaDigest.MatchString(state.ImageDigest) {
			return Scope{}, ErrIdentity
		}
		if parts := strings.SplitN(image, "@", 2); len(parts) == 2 {
			if parts[1] != state.ImageDigest {
				return Scope{}, ErrIdentity
			}
			image = parts[0]
		} else if colon := strings.LastIndex(image, ":"); colon > strings.LastIndex(image, "/") {
			image = image[:colon]
		}
		image += "@" + state.ImageDigest
	}
	scope.Image = image
	scope.EnvironmentHash, err = runtimeEnvironment(state, spec)
	if err != nil {
		return Scope{}, err
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return Scope{}, ErrIdentity
	}
	scope.Fingerprint = digest(string(encoded))
	return scope, nil
}

func (s Scope) Labels(labels map[string]string) bool {
	return labels["app.kubernetes.io/managed-by"] == "raibitserver" && labels["raibitserver.io/project-id"] == s.ProjectID && labels["raibitserver.io/service-id"] == s.ServiceID && labels["raibitserver.io/deployment-id"] == s.DeploymentID
}

var (
	dns       = regexp.MustCompile(`[^a-z0-9-]+`)
	shaDigest = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

func normalize(value string) string {
	value = strings.Trim(dns.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "-"), "-")
	if value == "" {
		return "item"
	}
	return value
}

func digest(value string) string {
	hash := sha256.Sum256([]byte(value))
	return hex.EncodeToString(hash[:])
}

func bounded(value, id string, limit int) string {
	value = normalize(value)
	if len(value) <= limit {
		return value
	}
	return suffixed(value, id, limit)
}

func suffixed(value, id string, limit int) string {
	value = normalize(value)
	if len(value) > limit-13 {
		value = strings.TrimRight(value[:limit-13], "-")
	}
	return value + "-" + digest(id)[:12]
}
