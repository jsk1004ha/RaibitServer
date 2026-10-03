package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"

	"github.com/raibitserver/builder/internal/controlplane"
	"github.com/raibitserver/builder/internal/source"
)

func (b *Builder) prepareTemplateSource(ctx context.Context, state *buildContext) error {
	request, err := templateRequestFromSnapshot(state.Deployment)
	if err != nil {
		return err
	}
	destination := filepath.Join(state.WorkspaceDir, "source")
	materializer := source.NewTemplateMaterializer(b.Config.TemplateCatalogPath, b.Config.TemplateBundlePath)
	if err := materializer.Materialize(ctx, request, destination); err != nil {
		return fmt.Errorf("materialize packaged template source: %w", err)
	}
	state.SourceDir = destination
	state.Steps = append(state.Steps, StepResult{Type: "source-template", DryRun: b.Config.DryRun, Detail: request.CatalogID + "/" + request.CatalogVersion})
	return b.writeLog(ctx, state, "source", "materialized checksummed packaged template "+request.CatalogID+"/"+request.CatalogVersion, "info")
}

func templateRequestFromSnapshot(deployment *controlplane.Deployment) (source.TemplateRequest, error) {
	if deployment == nil || deployment.SnapshotVersion == nil || *deployment.SnapshotVersion != 1 || len(deployment.DesiredSpecSnapshot) == 0 {
		return source.TemplateRequest{}, errors.New("template build requires a versioned deployment snapshot")
	}
	var snapshot struct {
		SourceType     string          `json:"sourceType"`
		BuildMode      string          `json:"buildMode"`
		DockerfilePath string          `json:"dockerfilePath"`
		BuildContext   string          `json:"buildContext"`
		RootDirectory  string          `json:"rootDirectory"`
		LocalPath      string          `json:"localPath"`
		RepoURL        string          `json:"repoUrl"`
		RepositoryURL  string          `json:"repositoryUrl"`
		Source         json.RawMessage `json:"source"`
	}
	if err := json.Unmarshal(deployment.DesiredSpecSnapshot, &snapshot); err != nil {
		return source.TemplateRequest{}, errors.New("template build has an invalid deployment snapshot")
	}
	if snapshot.SourceType != "template" || snapshot.BuildMode != "dockerfile" ||
		(snapshot.DockerfilePath != "" && snapshot.DockerfilePath != "Dockerfile") ||
		(snapshot.BuildContext != "" && snapshot.BuildContext != ".") ||
		(snapshot.RootDirectory != "" && snapshot.RootDirectory != ".") ||
		snapshot.LocalPath != "" || snapshot.RepoURL != "" || snapshot.RepositoryURL != "" {
		return source.TemplateRequest{}, errors.New("template build requires the packaged root Dockerfile without source overrides")
	}
	var identity struct {
		Type           string `json:"type"`
		CatalogID      string `json:"catalogId"`
		CatalogVersion string `json:"catalogVersion"`
		CatalogDigest  string `json:"catalogDigest"`
		SourceDigest   string `json:"sourceDigest"`
	}
	decoder := json.NewDecoder(bytes.NewReader(snapshot.Source))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&identity); err != nil || identity.Type != "template" ||
		identity.CatalogID == "" || identity.CatalogVersion == "" || identity.CatalogDigest == "" || identity.SourceDigest == "" {
		return source.TemplateRequest{}, errors.New("template build snapshot is missing exact packaged source identity")
	}
	return source.TemplateRequest{
		CatalogID: identity.CatalogID, CatalogVersion: identity.CatalogVersion,
		CatalogDigest: identity.CatalogDigest, SourceDigest: identity.SourceDigest,
	}, nil
}
