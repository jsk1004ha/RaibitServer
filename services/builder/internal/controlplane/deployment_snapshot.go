package controlplane

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"strings"
)

var (
	ErrDeploymentSnapshot       = errors.New("deployment snapshot is missing, invalid, or unsupported")
	ErrDeploymentSnapshotSource = errors.New("deployment snapshot GitHub binding is no longer authorized")
)

// DeploymentBuildSpec deliberately excludes live identity, status and credentials.
type DeploymentBuildSpec struct {
	SourceType           string
	BuildMode            string
	RepoURL              string
	RepositoryURL        string
	RootDirectory        string
	BuildContext         string
	DockerfilePath       string
	InstallCommand       string
	BuildCommand         string
	CustomBuildCommand   string
	StartCommand         string
	OutputDirectory      string
	LocalPath            string
	Port                 int
	BuildArgs            map[string]snapshotBuildArgument
	GitHubIntegrationID  string
	GitHubInstallationID string
	GitHubRepositoryID   string
	GitHubRepository     string
	GitHub               struct {
		IntegrationID  string
		InstallationID string
		RepositoryID   string
		Repository     string
	}
}

// Normalize at the JSON boundary using the legacy worker's argument coercion.
type snapshotBuildArgument string

func (arg *snapshotBuildArgument) UnmarshalJSON(data []byte) error {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return ErrDeploymentSnapshot
	}
	text := ""
	if value != nil {
		text = fmt.Sprint(value)
	}
	*arg = snapshotBuildArgument(text)
	return nil
}

func (d *Deployment) decodeSnapshotRecord(row record) error {
	raw, err := json.Marshal(struct {
		SnapshotVersion     any `json:"snapshotVersion"`
		DesiredSpecSnapshot any `json:"desiredSpecSnapshot"`
	}{row["snapshotVersion"], row["desiredSpecSnapshot"]})
	if err != nil {
		return fmt.Errorf("decode stored deployment snapshot: %w", ErrDeploymentSnapshot)
	}
	if err := json.Unmarshal(raw, d); err != nil {
		return fmt.Errorf("decode stored deployment snapshot: %w", ErrDeploymentSnapshot)
	}
	_, err = d.BuildSpec()
	return err
}

func (d *Deployment) BuildSpec() (*DeploymentBuildSpec, error) {
	raw := bytes.TrimSpace(d.DesiredSpecSnapshot)
	present := len(raw) > 0 && !bytes.Equal(raw, []byte("null"))
	if d.SnapshotVersion == nil && !present && !d.hasSnapshotLineage() {
		return nil, nil // N-1 initial deployments retain the existing live-service path.
	}
	if d.SnapshotVersion == nil || *d.SnapshotVersion != 1 || !present || raw[0] != '{' {
		return nil, ErrDeploymentSnapshot
	}
	var spec DeploymentBuildSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		return nil, ErrDeploymentSnapshot
	}
	return &spec, nil
}

func (d *Deployment) hasSnapshotLineage() bool {
	trigger := strings.TrimSpace(d.TriggerType)
	return d.SourceDeploymentID != "" || d.RetryOfDeploymentID != "" || strings.EqualFold(trigger, "retry") || strings.EqualFold(trigger, "redeploy")
}

// BuildInputs overlays execution fields only; security authority stays live.
func (d *Deployment) BuildInputs(live *Service, job *WorkflowJob) (*Service, *WorkflowJob, error) {
	spec, err := d.BuildSpec()
	if err != nil || spec == nil {
		return live, job, err
	}
	if d.hasSnapshotLineage() && coalesceString(spec.RepoURL, spec.RepositoryURL) != "" && coalesceString(d.CommitSHA, d.CommitHash) == "" {
		return nil, nil, fmt.Errorf("lineaged Git build requires a durable commit: %w", ErrDeploymentSnapshot)
	}
	for _, binding := range [][2]string{
		{coalesceString(spec.GitHubIntegrationID, spec.GitHub.IntegrationID), live.GitHubIntegrationID},
		{coalesceString(spec.GitHubInstallationID, spec.GitHub.InstallationID), live.GitHubInstallationID},
		{coalesceString(spec.GitHubRepositoryID, spec.GitHub.RepositoryID), live.GitHubRepositoryID},
		{coalesceString(spec.GitHubRepository, spec.GitHub.Repository), live.GitHubRepository},
	} {
		if binding[0] != "" && binding[0] != binding[1] {
			return nil, nil, ErrDeploymentSnapshotSource
		}
	}
	service := *live
	service.SourceType, service.BuildMode = spec.SourceType, coalesceString(spec.BuildMode, "auto")
	service.RepoURL = coalesceString(spec.RepoURL, spec.RepositoryURL)
	service.RootDirectory, service.BuildContext, service.DockerfilePath = spec.RootDirectory, spec.BuildContext, spec.DockerfilePath
	service.InstallCommand, service.BuildCommand = spec.InstallCommand, coalesceString(spec.BuildCommand, spec.CustomBuildCommand)
	service.StartCommand, service.OutputDirectory = spec.StartCommand, spec.OutputDirectory
	service.LocalPath, service.Port = spec.LocalPath, spec.Port
	service.Branch, service.Image, service.ImageURL = d.Branch, d.ImageURL, d.ImageURL
	service.DesiredSpec, service.DesiredState = nil, nil
	resolved := *job
	resolved.Payload = maps.Clone(job.Payload)
	for _, key := range []string{
		"buildMode", "buildContext", "dockerfilePath", "buildArgs", "localPath", "source", "repoUrl", "repository",
		"githubRepositoryId", "repositoryId", "githubInstallationId", "branch", "commitSha", "commitHash",
		"image", "imageUrl", "imageDigest", "registry", "desiredSpecSnapshot", "snapshotVersion",
	} {
		delete(resolved.Payload, key)
	}
	if len(spec.BuildArgs) > 0 {
		if resolved.Payload == nil {
			resolved.Payload = make(map[string]any)
		}
		args := make(map[string]any, len(spec.BuildArgs))
		for key, value := range spec.BuildArgs {
			args[key] = string(value)
		}
		resolved.Payload["buildArgs"] = args
	}
	return &service, &resolved, nil
}
