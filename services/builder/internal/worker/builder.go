package worker

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	buildplan "github.com/raibitserver/builder/internal/build"
	"github.com/raibitserver/builder/internal/controlplane"
)

const (
	DeploymentStatusBuilding    = "BUILDING"
	DeploymentStatusImageReady  = "IMAGE_READY"
	DeploymentStatusBuildFailed = controlplane.ErrorCodeBuildFailed
)

type Config struct {
	WorkerID                           string
	WorkspaceDir                       string
	Registry                           string
	DryRun                             bool
	Production                         bool
	AllowAnonymousGit                  bool
	Push                               bool
	Builder                            string
	BuildkitAddress                    string
	BuildkitTLSDirectory               string
	BuildkitTLSServerName              string
	IsolationMode                      string
	RunOnce                            bool
	GeneratedDockerfileFrontend        string
	GeneratedNodeImage                 string
	RegistryCredentialBrokerURL        string
	RegistryCredentialBrokerTokenFile  string
	RegistryCredentialBrokerHTTPClient *http.Client
	RegistryCredentialMinTTL           time.Duration
	RegistryCredentialMaxTTL           time.Duration
	Timeout                            time.Duration
	LeaseSeconds                       int
	MetadataDir                        string
	Scan                               bool
	Scanner                            string
	ScanSeverity                       string
	Sign                               bool
	Signer                             string
	SigningKeyPath                     string
}

type Builder struct {
	Store  controlplane.Store
	Runner CommandRunner
	Config Config
}

type Result struct {
	Processed    bool           `json:"processed"`
	JobID        string         `json:"jobId,omitempty"`
	DeploymentID string         `json:"deploymentId,omitempty"`
	ServiceID    string         `json:"serviceId,omitempty"`
	ProjectID    string         `json:"projectId,omitempty"`
	Image        string         `json:"image,omitempty"`
	ImageDigest  string         `json:"imageDigest,omitempty"`
	DryRun       bool           `json:"dryRun"`
	Steps        []StepResult   `json:"steps,omitempty"`
	Reason       string         `json:"reason,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
}

type StepResult struct {
	Type    string `json:"type"`
	Command string `json:"command,omitempty"`
	DryRun  bool   `json:"dryRun"`
	Detail  string `json:"detail,omitempty"`
}

type buildContext struct {
	Job          *controlplane.WorkflowJob
	Deployment   *controlplane.Deployment
	Service      *controlplane.Service
	Project      *controlplane.Project
	Plan         buildplan.Plan
	WorkspaceDir string
	MetadataDir  string
	SourceDir    string
	Dockerfile   string
	ContextDir   string
	Image        string
	Push         bool
	MetadataFile string
	RegistryEnv  map[string]string
	Generated    []string
	Steps        []StepResult
	ScanEvidence map[string]any
	SignEvidence map[string]any
}

type prebuiltImageAuthorizer interface {
	AuthorizePrebuiltImage(ctx context.Context, organizationID, projectID, serviceID, image string) error
}

type gitHubRepositoryCredentialStore interface {
	IssueGitHubRepositoryCredential(context.Context, controlplane.GitHubRepositoryCredentialRequest) (*controlplane.GitHubRepositoryCredential, error)
}

func New(store controlplane.Store, runner CommandRunner, config Config) *Builder {
	if runner == nil {
		runner = OSRunner{}
	}
	if config.WorkerID == "" {
		config.WorkerID = "raibitserver-builder"
	}
	if config.WorkspaceDir == "" {
		config.WorkspaceDir = filepath.Join(os.TempDir(), "raibitserver-builder")
	}
	if config.Registry == "" && config.DryRun {
		config.Registry = "registry.invalid"
	}
	if config.DryRun {
		config.AllowAnonymousGit = true
	}
	if config.Builder == "" {
		config.Builder = "docker-buildx"
	}
	if config.BuildkitAddress == "" {
		config.BuildkitAddress = firstNonEmpty(os.Getenv("RAIBITSERVER_BUILDKIT_ADDRESS"), os.Getenv("BUILDKIT_HOST"))
	}
	if config.BuildkitTLSDirectory == "" {
		config.BuildkitTLSDirectory = strings.TrimSpace(os.Getenv("RAIBITSERVER_BUILDKIT_TLS_DIRECTORY"))
	}
	if config.BuildkitTLSServerName == "" {
		config.BuildkitTLSServerName = strings.TrimSpace(os.Getenv("RAIBITSERVER_BUILDKIT_TLS_SERVER_NAME"))
	}
	if config.IsolationMode == "" {
		config.IsolationMode = strings.TrimSpace(os.Getenv("RAIBITSERVER_BUILDER_ISOLATION"))
	}
	if !config.RunOnce {
		config.RunOnce = boolFromEnv("RAIBITSERVER_RUN_ONCE")
	}
	if config.GeneratedDockerfileFrontend == "" {
		config.GeneratedDockerfileFrontend = strings.TrimSpace(os.Getenv("RAIBITSERVER_GENERATED_DOCKERFILE_FRONTEND"))
	}
	if config.GeneratedNodeImage == "" {
		config.GeneratedNodeImage = strings.TrimSpace(os.Getenv("RAIBITSERVER_GENERATED_NODE_IMAGE"))
	}
	if config.RegistryCredentialBrokerURL == "" {
		config.RegistryCredentialBrokerURL = strings.TrimSpace(os.Getenv("RAIBITSERVER_REGISTRY_CREDENTIAL_BROKER_URL"))
	}
	if config.RegistryCredentialBrokerTokenFile == "" {
		config.RegistryCredentialBrokerTokenFile = strings.TrimSpace(os.Getenv("RAIBITSERVER_REGISTRY_CREDENTIAL_BROKER_TOKEN_FILE"))
	}
	if config.RegistryCredentialMinTTL <= 0 {
		config.RegistryCredentialMinTTL = defaultRegistryCredentialMinTTL
	}
	if config.RegistryCredentialMaxTTL <= 0 {
		config.RegistryCredentialMaxTTL = defaultRegistryCredentialMaxTTL
	}
	if config.DryRun && config.GeneratedDockerfileFrontend == "" {
		config.GeneratedDockerfileFrontend = "docker/dockerfile:1.7"
	}
	if config.DryRun && config.GeneratedNodeImage == "" {
		config.GeneratedNodeImage = "node:24-alpine"
	}
	if config.Timeout <= 0 {
		config.Timeout = defaultBuildCommandTimeout
	}
	if config.Scanner == "" {
		config.Scanner = "trivy"
	}
	if config.ScanSeverity == "" {
		config.ScanSeverity = "HIGH,CRITICAL"
	}
	if config.Signer == "" {
		config.Signer = "cosign"
	}
	return &Builder{Store: store, Runner: runner, Config: config}
}

func (b *Builder) RunOnce(ctx context.Context) (*Result, error) {
	if b.Store == nil {
		return nil, errors.New("builder store is required")
	}
	job, err := b.Store.ClaimNextWorkflowJob(ctx, controlplane.ClaimOptions{WorkerID: b.Config.WorkerID, LeaseSeconds: b.Config.LeaseSeconds})
	if err != nil {
		return nil, err
	}
	if job == nil {
		return &Result{Processed: false, DryRun: b.Config.DryRun, Reason: "no_ready_workflow_jobs"}, nil
	}
	processCtx, stopHeartbeat := context.WithCancel(ctx)
	heartbeatDone := make(chan error, 1)
	go func() {
		heartbeatErr := b.leaseHeartbeat(processCtx, job.Lease())
		if heartbeatErr != nil {
			stopHeartbeat()
		}
		heartbeatDone <- heartbeatErr
	}()
	result, err := b.processClaimedJob(processCtx, job)
	stopHeartbeat()
	heartbeatErr := <-heartbeatDone
	if err != nil {
		if errors.Is(err, controlplane.ErrWorkflowLeaseLost) {
			return result, errors.Join(err, heartbeatErr)
		}
		if errors.Is(err, controlplane.ErrBuildTargetDeleting) {
			cancelErr := b.Store.CancelWorkflowJob(ctx, job.Lease(), err)
			return result, errors.Join(err, cancelErr, heartbeatErr)
		}
		failureErr := b.Store.FailWorkflowJob(ctx, job.Lease(), err)
		return result, errors.Join(err, failureErr, heartbeatErr)
	}
	return result, nil
}

func (b *Builder) leaseHeartbeat(ctx context.Context, lease controlplane.WorkflowLease) error {
	leaseSeconds := b.Config.LeaseSeconds
	if leaseSeconds <= 0 {
		leaseSeconds = 300
	}
	interval := time.Duration(leaseSeconds) * time.Second / 3
	if interval < time.Second {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case now := <-ticker.C:
			if err := b.Store.RenewWorkflowJobLease(ctx, lease, now.UTC()); err != nil {
				return err
			}
		}
	}
}

func (b *Builder) processClaimedJob(ctx context.Context, job *controlplane.WorkflowJob) (*Result, error) {
	state, err := b.resolveState(ctx, job)
	if err != nil {
		return &Result{Processed: true, JobID: job.ID, DryRun: b.Config.DryRun}, err
	}
	if err := validateBuildOwnership(state); err != nil {
		return &Result{Processed: true, JobID: job.ID, DryRun: b.Config.DryRun}, err
	}
	result := &Result{Processed: true, JobID: job.ID, DeploymentID: state.Deployment.ID, ServiceID: state.Service.ID, ProjectID: state.Project.ID, DryRun: b.Config.DryRun}
	if err := b.prepareJobArtifacts(state); err != nil {
		return result, b.failClaimedBuild(ctx, state, err)
	}
	defer b.cleanupJobArtifacts(state)
	if err := currentTargetDeletionError(state); err != nil {
		result.Reason = "build_target_deleting"
		b.recordDeletionCancellation(ctx, state)
		return result, err
	}
	if err := b.validateRuntimeConfig(); err != nil {
		_ = b.Store.AppendDeploymentEvent(ctx, controlplane.DeploymentEventInput{DeploymentID: state.Deployment.ID, Type: "build.supply_chain_policy_failed", Message: "builder supply-chain policy rejected the live job", Metadata: map[string]any{"jobId": job.ID, "result": "failed", "dryRun": b.Config.DryRun}})
		return result, b.failClaimedBuild(ctx, state, err)
	}
	if err := b.markBuilding(ctx, state); err != nil {
		if errors.Is(err, controlplane.ErrWorkflowLeaseLost) {
			return result, err
		}
		if errors.Is(err, controlplane.ErrBuildTargetDeleting) {
			result.Reason = "build_target_deleting"
			b.recordDeletionCancellation(ctx, state)
			return result, err
		}
		return result, b.failClaimedBuild(ctx, state, err)
	}
	if err := b.writeLog(ctx, state, "claim", fmt.Sprintf("claimed workflow job %s for deployment %s", job.ID, state.Deployment.ID), "info"); err != nil {
		return result, b.failClaimedBuild(ctx, state, err)
	}
	if err := b.prepareSource(ctx, state); err != nil {
		return result, b.failClaimedBuild(ctx, state, err)
	}
	if err := b.prepareBuildPlan(ctx, state); err != nil {
		return result, b.failClaimedBuild(ctx, state, err)
	}
	if err := b.executeBuild(ctx, state); err != nil {
		return result, b.failClaimedBuild(ctx, state, err)
	}
	digest, err := b.resolveDigest(state)
	if err != nil {
		return result, b.failClaimedBuild(ctx, state, err)
	}
	if err := b.recheckTargetDeletion(ctx, state); err != nil {
		if errors.Is(err, controlplane.ErrBuildTargetDeleting) {
			result.Reason = "build_target_deleting"
			b.recordDeletionCancellation(ctx, state)
		} else {
			return result, b.failClaimedBuild(ctx, state, err)
		}
		return result, err
	}
	if err := b.scanImage(ctx, state, digest); err != nil {
		return result, b.failClaimedBuild(ctx, state, err)
	}
	if err := b.recheckTargetDeletion(ctx, state); err != nil {
		if errors.Is(err, controlplane.ErrBuildTargetDeleting) {
			result.Reason = "build_target_deleting"
			b.recordDeletionCancellation(ctx, state)
		} else {
			return result, b.failClaimedBuild(ctx, state, err)
		}
		return result, err
	}
	if isPrebuilt(state.Service, state.Deployment) || state.Plan.Mode == "prebuilt-image" {
		state.SignEvidence = map[string]any{"result": "preauthorized", "evidence": "control-plane-image-acl", "digest": digest, "dryRun": b.Config.DryRun}
	} else {
		if err := b.signImage(ctx, state, digest); err != nil {
			return result, b.failClaimedBuild(ctx, state, err)
		}
	}
	if err := b.Store.RenewWorkflowJobLease(ctx, job.Lease(), time.Now().UTC()); err != nil {
		return result, err
	}
	supplyChain := map[string]any{"scan": state.ScanEvidence, "signing": state.SignEvidence}
	if err := b.Store.PublishImageReady(ctx, controlplane.ImagePublicationInput{
		Lease:           job.Lease(),
		DeploymentID:    state.Deployment.ID,
		ServiceID:       state.Service.ID,
		ProjectID:       state.Project.ID,
		ImageURL:        state.Image,
		ImageDigest:     digest,
		DryRun:          b.Config.DryRun,
		SupplyChain:     supplyChain,
		BuildFinishedAt: time.Now().UTC(),
	}); err != nil {
		if errors.Is(err, controlplane.ErrBuildTargetDeleting) {
			result.Reason = "build_target_deleting"
			b.recordDeletionCancellation(ctx, state)
		}
		return result, err
	}
	result.Image = state.Image
	result.ImageDigest = digest
	result.Steps = state.Steps
	result.Metadata = map[string]any{"mode": state.Plan.Mode, "sourceDir": state.SourceDir, "dockerfile": state.Dockerfile, "builder": b.Config.Builder, "supplyChain": supplyChain}
	return result, nil
}

func (b *Builder) resolveState(ctx context.Context, job *controlplane.WorkflowJob) (*buildContext, error) {
	payloadDeploymentID := strings.TrimSpace(stringValue(job.Payload["deploymentId"]))
	targetDeploymentID := ""
	if strings.EqualFold(strings.TrimSpace(job.TargetType), "deployment") {
		targetDeploymentID = strings.TrimSpace(job.TargetID)
	}
	if payloadDeploymentID != "" && targetDeploymentID != "" && payloadDeploymentID != targetDeploymentID {
		return nil, errors.New("workflow job has inconsistent deployment targets")
	}
	deploymentID := firstNonEmpty(payloadDeploymentID, targetDeploymentID)
	if deploymentID == "" {
		return nil, errors.New("workflow job payload.deploymentId or deployment targetId is required")
	}
	deployment, err := b.Store.GetDeployment(ctx, deploymentID)
	if err != nil {
		return nil, err
	}
	serviceID := firstNonEmpty(deployment.ServiceID, stringValue(job.Payload["serviceId"]))
	service, err := b.Store.GetService(ctx, serviceID)
	if err != nil {
		return nil, err
	}
	projectID := firstNonEmpty(deployment.ProjectID, service.ProjectID, stringValue(job.Payload["projectId"]))
	project, err := b.Store.GetProject(ctx, projectID)
	if err != nil {
		return nil, err
	}
	return &buildContext{Job: job, Deployment: deployment, Service: service, Project: project}, nil
}

func (b *Builder) recheckTargetDeletion(ctx context.Context, state *buildContext) error {
	service, err := b.Store.GetService(ctx, state.Service.ID)
	if err != nil {
		return err
	}
	project, err := b.Store.GetProject(ctx, state.Project.ID)
	if err != nil {
		return err
	}
	state.Service.Status = service.Status
	state.Project.Status = project.Status
	return currentTargetDeletionError(state)
}

func currentTargetDeletionError(state *buildContext) error {
	if state == nil || state.Service == nil || state.Project == nil {
		return nil
	}
	if controlplane.IsDeletionStatus(state.Service.Status) {
		return fmt.Errorf("%w: service status is %s", controlplane.ErrBuildTargetDeleting, strings.ToUpper(strings.TrimSpace(state.Service.Status)))
	}
	if controlplane.IsDeletionStatus(state.Project.Status) {
		return fmt.Errorf("%w: project status is %s", controlplane.ErrBuildTargetDeleting, strings.ToUpper(strings.TrimSpace(state.Project.Status)))
	}
	return nil
}

func (b *Builder) recordDeletionCancellation(ctx context.Context, state *buildContext) {
	const message = "build cancelled because service or project deletion is in progress"
	_ = b.writeLog(ctx, state, "cancel", message, "info")
	_ = b.Store.AppendDeploymentEvent(ctx, controlplane.DeploymentEventInput{
		DeploymentID: state.Deployment.ID,
		Type:         "build.cancelled_deleting_target",
		Message:      message,
		Metadata: map[string]any{
			"jobId":         state.Job.ID,
			"serviceStatus": state.Service.Status,
			"projectStatus": state.Project.Status,
			"retryable":     false,
		},
	})
}

func (b *Builder) markBuilding(ctx context.Context, state *buildContext) error {
	if err := b.Store.StartBuild(ctx, controlplane.BuildStartInput{
		Lease:        state.Job.Lease(),
		DeploymentID: state.Deployment.ID,
		ServiceID:    state.Service.ID,
		ProjectID:    state.Project.ID,
		StartedAt:    time.Now().UTC(),
	}); err != nil {
		return err
	}
	return b.Store.AppendDeploymentEvent(ctx, controlplane.DeploymentEventInput{DeploymentID: state.Deployment.ID, Type: "build.started", Message: "builder claimed deployment and started image workflow", Metadata: map[string]any{"jobId": state.Job.ID, "workerId": b.Config.WorkerID, "dryRun": b.Config.DryRun}})
}

func (b *Builder) markFailed(ctx context.Context, state *buildContext, failure error) error {
	logErr := b.writeLog(ctx, state, "error", failure.Error(), "error")
	errorSpec := controlplane.ErrorSpecForFailure(failure, controlplane.ErrorCodeBuildFailed)
	_, err := b.Store.UpdateDeploymentForLease(ctx, state.Job.Lease(), state.Deployment.ID, map[string]any{"status": DeploymentStatusBuildFailed, "buildFinishedAt": time.Now().UTC().Format(time.RFC3339Nano), "errorCode": errorSpec.Code, "errorMessage": errorSpec.Message})
	if err != nil {
		return errors.Join(logErr, err)
	}
	eventErr := b.Store.AppendDeploymentEvent(ctx, controlplane.DeploymentEventInput{DeploymentID: state.Deployment.ID, Type: "build.failed", Message: errorSpec.Message, Metadata: map[string]any{"jobId": state.Job.ID, "errorSpec": errorSpec}})
	return errors.Join(logErr, eventErr)
}

func (b *Builder) failClaimedBuild(ctx context.Context, state *buildContext, failure error) error {
	return errors.Join(failure, b.markFailed(ctx, state, failure))
}

func (b *Builder) prepareJobArtifacts(state *buildContext) error {
	if state == nil || state.Job == nil || state.Project == nil || state.Service == nil {
		return errors.New("resolved build identity is required before creating artifacts")
	}
	if err := os.MkdirAll(b.Config.WorkspaceDir, 0o700); err != nil {
		return err
	}
	prefix := "job-" + buildIdentityHash(state)[:16] + "-"
	workspaceDir, err := os.MkdirTemp(b.Config.WorkspaceDir, prefix)
	if err != nil {
		return err
	}
	state.WorkspaceDir = workspaceDir
	if err := os.Chmod(workspaceDir, 0o700); err != nil {
		b.cleanupJobArtifacts(state)
		return err
	}
	metadataRoot := b.metadataDir()
	if err := os.MkdirAll(metadataRoot, 0o700); err != nil {
		b.cleanupJobArtifacts(state)
		return err
	}
	metadataDir, err := os.MkdirTemp(metadataRoot, prefix)
	if err != nil {
		b.cleanupJobArtifacts(state)
		return err
	}
	state.MetadataDir = metadataDir
	if err := os.Chmod(metadataDir, 0o700); err != nil {
		b.cleanupJobArtifacts(state)
		return err
	}
	return nil
}

func (b *Builder) cleanupJobArtifacts(state *buildContext) {
	if state == nil {
		return
	}
	for _, path := range state.Generated {
		_ = os.Remove(path)
	}
	if state.MetadataDir != "" {
		_ = os.RemoveAll(state.MetadataDir)
	}
	if state.WorkspaceDir != "" {
		_ = os.RemoveAll(state.WorkspaceDir)
	}
}

func buildIdentityHash(state *buildContext) string {
	organizationID := strings.TrimSpace(state.Project.OrganizationID)
	if organizationID == "" {
		organizationID = "organization-unset"
	}
	sum := sha256.Sum256([]byte(strings.Join([]string{
		"raibitserver-build-identity-v1",
		organizationID,
		strings.TrimSpace(state.Project.ID),
		strings.TrimSpace(state.Service.ID),
		strings.TrimSpace(state.Job.ID),
	}, "\x00")))
	return hex.EncodeToString(sum[:])
}

func (b *Builder) prepareSource(ctx context.Context, state *buildContext) error {
	workspace := state.WorkspaceDir
	localPath := firstNonEmpty(stringValue(state.Job.Payload["localPath"]), state.Service.LocalPath)
	if localPath != "" {
		sourceDir, err := b.resolveLocalSourceDir(localPath)
		if err != nil {
			return err
		}
		state.SourceDir = sourceDir
		state.Steps = append(state.Steps, StepResult{Type: "source-local", DryRun: b.Config.DryRun, Detail: localPath})
		return b.writeLog(ctx, state, "source", "using local source path "+localPath, "info")
	}
	repoURL := strings.TrimSpace(state.Service.RepoURL)
	if isPrebuilt(state.Service, state.Deployment) {
		state.SourceDir = workspace
		return nil
	}
	if repoURL == "" {
		return errors.New("source repository URL is required for non-prebuilt build")
	}
	if isCredentialedURL(repoURL) {
		_, _ = b.Store.UpdateService(ctx, state.Service.ID, map[string]any{"repoUrl": redactCredentialedGitURL(repoURL)})
		return errors.New("credentialed git URLs are not allowed; repository credentials must come from an exact-repository per-build broker")
	}
	bound, err := validateAuthoritativeGitSource(state.Service)
	if err != nil {
		return err
	}
	if err := validateWorkflowSourcePayload(state, bound); err != nil {
		return err
	}
	if _, err := canonicalGitHubRepository(repoURL); err != nil {
		return err
	}
	privateRepository := bound && strings.EqualFold(state.Service.GitHubRepositoryVisibility, "private")
	gitEnv := isolatedGitEnvironment(workspace)
	if privateRepository {
		credentialStore, ok := b.Store.(gitHubRepositoryCredentialStore)
		if !ok {
			return errors.New("private GitHub repository builds require an exact-repository short-lived credential from a per-build credential broker")
		}
		credential, credentialErr := credentialStore.IssueGitHubRepositoryCredential(ctx, controlplane.GitHubRepositoryCredentialRequest{
			ServiceID:      state.Service.ID,
			InstallationID: state.Service.GitHubInstallationID,
			RepositoryID:   state.Service.GitHubRepositoryID,
		})
		if credentialErr != nil {
			return credentialErr
		}
		gitEnv["GIT_CONFIG_COUNT"] = "1"
		gitEnv["GIT_CONFIG_KEY_0"] = "http.https://github.com/.extraheader"
		gitEnv["GIT_CONFIG_VALUE_0"] = "AUTHORIZATION: basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:"+credential.Token))
	} else if b.Config.Production && !b.Config.AllowAnonymousGit {
		return errors.New("anonymous Git source policy is disabled for production builds")
	}
	branch := firstNonEmpty(state.Deployment.Branch, state.Service.Branch, "main")
	destination := filepath.Join(workspace, "source")
	args := []string{"clone", "--depth", "1", "--branch", branch, repoURL, destination}
	command := Command{Name: "git", Args: args, Env: gitEnv, CleanGitEnv: true, Redacted: "git " + strings.Join(redactArgs(args), " ")}
	result, err := b.Runner.Run(ctx, command, CommandOptions{DryRun: b.Config.DryRun, Timeout: b.Config.Timeout, Sensitive: privateRepository})
	state.Steps = append(state.Steps, StepResult{Type: "git-clone", Command: result.Command, DryRun: result.DryRun})
	_ = b.writeCommandLogs(ctx, state, "clone", result)
	if err != nil {
		return err
	}
	gitEnv = isolatedGitEnvironment(workspace)
	commit := firstNonEmpty(state.Deployment.CommitSHA, state.Deployment.CommitHash)
	if commit != "" {
		checkout := Command{Name: "git", Args: []string{"checkout", commit}, Dir: destination, Env: gitEnv, CleanGitEnv: true}
		checkoutResult, err := b.Runner.Run(ctx, checkout, CommandOptions{DryRun: b.Config.DryRun, Timeout: b.Config.Timeout})
		state.Steps = append(state.Steps, StepResult{Type: "git-checkout", Command: checkoutResult.Command, DryRun: checkoutResult.DryRun})
		_ = b.writeCommandLogs(ctx, state, "clone", checkoutResult)
		if err != nil {
			return err
		}
	} else {
		revision := Command{Name: "git", Args: []string{"rev-parse", "HEAD"}, Dir: destination, Env: gitEnv, CleanGitEnv: true}
		revisionResult, err := b.Runner.Run(ctx, revision, CommandOptions{DryRun: b.Config.DryRun, Timeout: b.Config.Timeout})
		state.Steps = append(state.Steps, StepResult{Type: "git-revision", Command: revisionResult.Command, DryRun: revisionResult.DryRun})
		_ = b.writeCommandLogs(ctx, state, "clone", revisionResult)
		if err != nil {
			return err
		}
		resolvedCommit := strings.TrimSpace(revisionResult.Stdout)
		if revisionResult.DryRun && resolvedCommit == "" {
			resolvedCommit = buildIdentityHash(state)[:40]
		}
		resolvedCommit, err = controlplane.NormalizeGitCommitSHA(resolvedCommit)
		if err != nil {
			return err
		}
		deployment, err := b.Store.UpdateDeploymentForLease(ctx, state.Job.Lease(), state.Deployment.ID, map[string]any{"commitSha": resolvedCommit, "commitHash": resolvedCommit})
		if err != nil {
			return err
		}
		state.Deployment = deployment
		if err := b.writeLog(ctx, state, "source", "pinned checked-out source commit "+resolvedCommit, "info"); err != nil {
			return err
		}
	}
	state.SourceDir = destination
	return nil
}

func (b *Builder) prepareBuildPlan(ctx context.Context, state *buildContext) error {
	mode := normalizeMode(firstNonEmpty(stringValue(state.Job.Payload["buildMode"]), state.Service.BuildMode, envOr("RAIBITSERVER_BUILD_MODE", "auto")))
	prebuilt := isPrebuilt(state.Service, state.Deployment)
	if prebuilt {
		mode = "prebuilt-image"
	}
	source := firstNonEmpty(state.Service.RepoURL, state.Service.LocalPath, state.SourceDir)
	image, err := b.resolveImage(ctx, state, prebuilt)
	if err != nil {
		return err
	}
	plan := buildplan.Plan{Mode: mode, Source: source, Image: image, ProjectID: state.Project.ID, ServiceID: state.Service.ID, DeploymentID: state.Deployment.ID}
	if err := plan.Validate(ctx); err != nil {
		return err
	}
	state.Plan = plan
	state.Image = image
	state.Push = b.Config.Push || b.Config.DryRun
	if err := validateImageDestination(state.Image, b.Config.Registry); err != nil {
		return err
	}
	contextDir, err := resolvePathWithinSourceDir(state.SourceDir, firstNonEmpty(stringValue(state.Job.Payload["buildContext"]), state.Service.BuildContext, state.Service.RootDirectory, "."), "buildContext")
	if err != nil {
		return err
	}
	state.ContextDir = contextDir
	if prebuilt || mode == "prebuilt-image" {
		return nil
	}
	dockerfilePath := firstNonEmpty(stringValue(state.Job.Payload["dockerfilePath"]), state.Service.DockerfilePath, "Dockerfile")
	resolvedDockerfile, err := resolvePathWithinSourceDir(state.SourceDir, dockerfilePath, "dockerfilePath")
	if err != nil {
		return err
	}
	if info, statErr := os.Stat(resolvedDockerfile); statErr == nil && info.IsDir() {
		return fmt.Errorf("dockerfilePath must point to a file, got directory: %s", dockerfilePath)
	} else if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return statErr
	}
	state.Dockerfile = resolvedDockerfile
	if mode == "dockerfile" || fileExists(state.Dockerfile) {
		state.Plan.Mode = "dockerfile"
		return b.writeLog(ctx, state, "plan", "Dockerfile selected before generated build strategy", "info")
	}
	state.Plan.Mode = "generated"
	return b.writeGeneratedDockerfile(ctx, state)
}

func resolvePathWithinSourceDir(sourceDir, candidate, field string) (string, error) {
	if filepath.IsAbs(candidate) {
		return "", fmt.Errorf("%s must be relative to source directory", field)
	}
	sourceRoot, err := filepath.Abs(filepath.Clean(sourceDir))
	if err != nil {
		return "", err
	}
	resolvedPath, err := filepath.Abs(filepath.Join(sourceRoot, candidate))
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(sourceRoot, resolvedPath)
	if err != nil {
		return "", err
	}
	if relative == "." || relative == "" {
		return resolvedPath, nil
	}
	if relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) || filepath.IsAbs(relative) {
		return "", fmt.Errorf("%s escapes source directory", field)
	}
	if _, err := os.Stat(sourceRoot); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// A dry-run clone does not materialize its source tree. Live builds always
			// reach this point with an existing source root.
			return resolvedPath, nil
		}
		return "", err
	}
	if err := rejectSymbolicLinksWithin(sourceRoot, resolvedPath, field); err != nil {
		return "", err
	}
	realSourceRoot, err := filepath.EvalSymlinks(sourceRoot)
	if err != nil {
		return "", err
	}
	realResolvedPath, err := evalSymlinksAllowMissing(resolvedPath)
	if err != nil {
		return "", err
	}
	if !pathIsWithin(realSourceRoot, realResolvedPath) {
		return "", fmt.Errorf("%s escapes source directory", field)
	}
	return resolvedPath, nil
}

func rejectSymbolicLinksWithin(root, target, field string) error {
	relative, err := filepath.Rel(root, target)
	if err != nil {
		return err
	}
	paths := []string{root}
	current := root
	if relative != "." && relative != "" {
		for _, part := range strings.Split(relative, string(os.PathSeparator)) {
			current = filepath.Join(current, part)
			paths = append(paths, current)
		}
	}
	for _, path := range paths {
		linked, exists, err := pathEntryIsSymbolicLink(path)
		if err != nil {
			return err
		}
		if !exists {
			break
		}
		if linked {
			return fmt.Errorf("%s must not contain symbolic links", field)
		}
	}
	return nil
}

func pathEntryIsSymbolicLink(path string) (linked, exists bool, err error) {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, false, nil
		}
		return false, false, err
	}
	// Windows directory junctions are exposed by os.Lstat as ModeIrregular
	// rather than ModeSymlink. Both are unsafe as BuildKit local roots.
	if info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
		return true, true, nil
	}
	parentReal, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return false, true, err
	}
	pathReal, err := filepath.EvalSymlinks(path)
	if err != nil {
		return false, true, err
	}
	expectedReal := filepath.Join(parentReal, filepath.Base(path))
	return !samePath(pathReal, expectedReal), true, nil
}

func evalSymlinksAllowMissing(path string) (string, error) {
	current := filepath.Clean(path)
	missing := make([]string, 0)
	for {
		resolved, err := filepath.EvalSymlinks(current)
		if err == nil {
			for index := len(missing) - 1; index >= 0; index-- {
				resolved = filepath.Join(resolved, missing[index])
			}
			return resolved, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", err
		}
		missing = append(missing, filepath.Base(current))
		current = parent
	}
}

func samePath(left, right string) bool {
	left = filepath.Clean(left)
	right = filepath.Clean(right)
	if os.PathSeparator == '\\' {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func pathIsWithin(base, candidate string) bool {
	relative, err := filepath.Rel(base, candidate)
	if err != nil {
		return false
	}
	return relative == "." || relative == "" || (!filepath.IsAbs(relative) && relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator)))
}

func (b *Builder) executeBuild(ctx context.Context, state *buildContext) error {
	if isPrebuilt(state.Service, state.Deployment) || state.Plan.Mode == "prebuilt-image" {
		if err := b.writeLog(ctx, state, "image", "using prebuilt image "+state.Image, "info"); err != nil {
			return err
		}
		if state.Push && stringValue(state.Job.Payload["retagImage"]) == "true" {
			return b.runDockerPush(ctx, state)
		}
		return nil
	}
	if !b.Config.DryRun && (b.Config.Production || strings.TrimSpace(b.Config.RegistryCredentialBrokerURL) != "") {
		registryEnv, err := b.issuePerBuildRegistryCredential(ctx, state)
		if err != nil {
			return err
		}
		state.RegistryEnv = registryEnv
	}
	state.MetadataFile = filepath.Join(state.MetadataDir, "build-metadata.json")
	buildArgs, err := buildArgsFromPayload(state.Job.Payload)
	if err != nil {
		return err
	}
	cacheNamespace := "raibit-" + buildIdentityHash(state)
	cacheArgs, err := b.buildCacheArgs(state)
	if err != nil {
		return err
	}
	buildArgKeys := make([]string, 0, len(buildArgs))
	for key := range buildArgs {
		buildArgKeys = append(buildArgKeys, key)
	}
	sort.Strings(buildArgKeys)
	var command Command
	if b.Config.Builder == "buildctl" {
		args := make([]string, 0, 24+len(buildArgKeys)*2)
		if address := strings.TrimSpace(b.Config.BuildkitAddress); address != "" {
			args = append(args, "--addr", address)
		}
		if tlsDirectory := strings.TrimSpace(b.Config.BuildkitTLSDirectory); tlsDirectory != "" {
			args = append(args, "--tlsdir", tlsDirectory)
		}
		if serverName := strings.TrimSpace(b.Config.BuildkitTLSServerName); serverName != "" {
			args = append(args, "--tlsservername", serverName)
		}
		args = append(args, "build", "--frontend", "dockerfile.v0", "--local", "context="+state.ContextDir, "--local", "dockerfile="+filepath.Dir(state.Dockerfile), "--output", fmt.Sprintf("type=image,name=%s,push=%t", state.Image, state.Push), "--metadata-file", state.MetadataFile)
		args = append(args, cacheArgs...)
		args = append(args, "--opt", "build-arg:BUILDKIT_CACHE_MOUNT_NS="+cacheNamespace)
		for _, key := range buildArgKeys {
			args = append(args, "--opt", "build-arg:"+key+"="+buildArgs[key])
		}
		command = Command{Name: "buildctl", Args: args, Env: state.RegistryEnv, Redacted: "buildctl " + strings.Join(redactArgs(args), " "), CleanRegistryEnv: true}
	} else {
		args := []string{"buildx", "build", "--file", state.Dockerfile, "--tag", state.Image, "--metadata-file", state.MetadataFile}
		if state.Push {
			args = append(args, "--push")
		} else {
			args = append(args, "--load")
		}
		args = append(args, cacheArgs...)
		args = append(args, "--build-arg", "BUILDKIT_CACHE_MOUNT_NS="+cacheNamespace)
		for _, key := range buildArgKeys {
			args = append(args, "--build-arg", key+"="+buildArgs[key])
		}
		args = append(args, state.ContextDir)
		command = Command{Name: "docker", Args: args, Env: state.RegistryEnv, Redacted: "docker " + strings.Join(redactArgs(args), " "), CleanRegistryEnv: true}
	}
	result, err := b.Runner.Run(ctx, command, CommandOptions{DryRun: b.Config.DryRun, Timeout: b.Config.Timeout})
	state.Steps = append(state.Steps, StepResult{Type: "buildkit-build", Command: result.Command, DryRun: result.DryRun})
	_ = b.writeCommandLogs(ctx, state, "build", result)
	if err != nil {
		return err
	}
	if state.Push && b.Config.Builder != "buildctl" && !strings.Contains(result.Command, "--push") {
		return b.runDockerPush(ctx, state)
	}
	return nil
}

func (b *Builder) scanImage(ctx context.Context, state *buildContext, digest string) error {
	if !b.Config.Scan {
		return nil
	}
	image, err := digestPinnedImage(state.Image, digest)
	if err != nil {
		return err
	}
	command := Command{Name: b.Config.Scanner, Args: []string{"image", "--quiet", "--exit-code", "1", "--severity", b.Config.ScanSeverity, "--ignore-unfixed", image}, Env: state.RegistryEnv, CleanRegistryEnv: true}
	result, err := b.Runner.Run(ctx, command, CommandOptions{DryRun: b.Config.DryRun, Timeout: b.Config.Timeout, Sensitive: true})
	state.Steps = append(state.Steps, StepResult{Type: "image-scan", Command: result.Command, DryRun: result.DryRun})
	if err != nil {
		_ = b.Store.AppendDeploymentEvent(ctx, controlplane.DeploymentEventInput{DeploymentID: state.Deployment.ID, Type: "build.image_scan_failed", Message: "image vulnerability policy failed", Metadata: map[string]any{"tool": b.Config.Scanner, "digest": digest, "result": "failed", "dryRun": b.Config.DryRun}})
		return err
	}
	state.ScanEvidence = map[string]any{"tool": b.Config.Scanner, "image": image, "digest": digest, "result": "passed", "dryRun": b.Config.DryRun}
	if err := b.writeLog(ctx, state, "scan", "image vulnerability scan passed for "+image, "info"); err != nil {
		return err
	}
	return b.Store.AppendDeploymentEvent(ctx, controlplane.DeploymentEventInput{DeploymentID: state.Deployment.ID, Type: "build.image_scanned", Message: "image vulnerability policy passed", Metadata: state.ScanEvidence})
}

func (b *Builder) signImage(ctx context.Context, state *buildContext, digest string) error {
	if !b.Config.Sign {
		return nil
	}
	image, err := digestPinnedImage(state.Image, digest)
	if err != nil {
		_ = b.Store.AppendDeploymentEvent(ctx, controlplane.DeploymentEventInput{DeploymentID: state.Deployment.ID, Type: "build.image_sign_failed", Message: "image signing failed", Metadata: map[string]any{"tool": b.Config.Signer, "digest": digest, "result": "failed", "dryRun": b.Config.DryRun}})
		return err
	}
	args := []string{
		"sign",
		"--yes",
		"--new-bundle-format=false",
		"--use-signing-config=false",
		"--registry-referrers-mode=legacy",
	}
	if b.Config.SigningKeyPath != "" {
		args = append(args, "--key", b.Config.SigningKeyPath)
	}
	args = append(args, image)
	command := Command{Name: b.Config.Signer, Args: args, Env: state.RegistryEnv, CleanRegistryEnv: true}
	result, err := b.Runner.Run(ctx, command, CommandOptions{DryRun: b.Config.DryRun, Timeout: b.Config.Timeout, Sensitive: true})
	state.Steps = append(state.Steps, StepResult{Type: "image-sign", Command: result.Command, DryRun: result.DryRun})
	if err != nil {
		_ = b.Store.AppendDeploymentEvent(ctx, controlplane.DeploymentEventInput{DeploymentID: state.Deployment.ID, Type: "build.image_sign_failed", Message: "image signing failed", Metadata: map[string]any{"tool": b.Config.Signer, "digest": digest, "result": "failed", "dryRun": b.Config.DryRun}})
		return err
	}
	state.SignEvidence = map[string]any{"tool": b.Config.Signer, "image": image, "digest": digest, "result": "signed", "evidence": "registry-signature", "dryRun": b.Config.DryRun}
	if err := b.writeLog(ctx, state, "sign", "image signature recorded for "+image, "info"); err != nil {
		return err
	}
	return b.Store.AppendDeploymentEvent(ctx, controlplane.DeploymentEventInput{DeploymentID: state.Deployment.ID, Type: "build.image_signed", Message: "image signature recorded", Metadata: state.SignEvidence})
}

func (b *Builder) runDockerPush(ctx context.Context, state *buildContext) error {
	command := Command{Name: "docker", Args: []string{"push", state.Image}, Env: state.RegistryEnv, CleanRegistryEnv: true}
	result, err := b.Runner.Run(ctx, command, CommandOptions{DryRun: b.Config.DryRun, Timeout: b.Config.Timeout})
	state.Steps = append(state.Steps, StepResult{Type: "registry-push", Command: result.Command, DryRun: result.DryRun})
	_ = b.writeCommandLogs(ctx, state, "push", result)
	return err
}

func (b *Builder) writeGeneratedDockerfile(ctx context.Context, state *buildContext) error {
	if state.Dockerfile == "" {
		state.Dockerfile = filepath.Join(state.SourceDir, "Dockerfile.raibitserver")
	}
	if err := os.MkdirAll(filepath.Dir(state.Dockerfile), 0o755); err != nil {
		return err
	}
	start := firstNonEmpty(state.Service.StartCommand, "npm start")
	build := firstNonEmpty(state.Service.BuildCommand, "npm run build --if-present")
	install := firstNonEmpty(state.Service.InstallCommand, "if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile; elif [ -f yarn.lock ]; then corepack enable && yarn install --frozen-lockfile; elif [ -f package-lock.json ]; then npm ci; elif [ -f requirements.txt ]; then pip install --cache-dir=/root/.cache/pip -r requirements.txt; elif [ -f package.json ]; then npm install; fi")
	frontend, nodeImage, err := b.generatedDockerfileImages()
	if err != nil {
		return err
	}
	content := fmt.Sprintf("# syntax=%s\nFROM %s\nWORKDIR /app\nCOPY . .\nRUN --mount=type=cache,target=/root/.npm --mount=type=cache,target=/root/.pnpm-store --mount=type=cache,target=/root/.cache/yarn --mount=type=cache,target=/root/.cache/pip %s\nRUN %s\nENV NODE_ENV=production\nCMD [\"sh\", \"-lc\", %q]\n", frontend, nodeImage, install, build, start)
	if err := os.WriteFile(state.Dockerfile, []byte(content), 0o644); err != nil {
		return err
	}
	state.Generated = append(state.Generated, state.Dockerfile)
	state.Steps = append(state.Steps, StepResult{Type: "generated-dockerfile", DryRun: b.Config.DryRun, Detail: state.Dockerfile})
	return b.writeLog(ctx, state, "plan", "generated Dockerfile for framework/buildpack fallback", "info")
}

func (b *Builder) generatedDockerfileImages() (string, string, error) {
	frontend := strings.TrimSpace(b.Config.GeneratedDockerfileFrontend)
	nodeImage := strings.TrimSpace(b.Config.GeneratedNodeImage)
	if b.Config.DryRun && frontend == "docker/dockerfile:1.7" && nodeImage == "node:24-alpine" {
		return frontend, nodeImage, nil
	}
	if !validDigestPinnedImageReference(frontend) {
		return "", "", errors.New("generated Dockerfile frontend must be an image reference pinned by sha256 digest")
	}
	if !validDigestPinnedImageReference(nodeImage) {
		return "", "", errors.New("generated Dockerfile node image must be an image reference pinned by sha256 digest")
	}
	return frontend, nodeImage, nil
}

func (b *Builder) resolveDigest(state *buildContext) (string, error) {
	embeddedDigest, err := embeddedDigestFromImage(state.Image)
	if err != nil {
		return "", err
	}
	if state.MetadataFile != "" {
		if bytes, err := os.ReadFile(state.MetadataFile); err == nil {
			var metadata map[string]any
			if err := json.Unmarshal(bytes, &metadata); err == nil {
				if digest := strings.TrimSpace(stringValue(metadata["containerimage.digest"])); validSHA256Digest(digest) {
					if embeddedDigest != "" && embeddedDigest != digest {
						return "", errors.New("image digest conflict between image reference and OCI metadata")
					}
					return digest, nil
				}
			}
		}
		if b.Config.DryRun {
			return deterministicDigest(state.Job.ID, state.Deployment.ID, state.Image, state.Deployment.CommitSHA, state.Deployment.CommitHash), nil
		}
		return "", errors.New("live build did not produce a valid registry digest in OCI metadata")
	}
	recordedDigest := strings.TrimSpace(state.Deployment.ImageDigest)
	if recordedDigest != "" && !validSHA256Digest(recordedDigest) {
		return "", errors.New("deployment contains an invalid sha256 image digest")
	}
	if embeddedDigest != "" && recordedDigest != "" && embeddedDigest != recordedDigest {
		return "", errors.New("image digest conflict between image reference and deployment record")
	}
	if embeddedDigest != "" {
		return embeddedDigest, nil
	}
	if recordedDigest != "" {
		return recordedDigest, nil
	}
	if b.Config.DryRun {
		return deterministicDigest(state.Job.ID, state.Deployment.ID, state.Image, state.Deployment.CommitSHA, state.Deployment.CommitHash), nil
	}
	return "", errors.New("live build did not produce a valid registry digest in OCI metadata")
}

func (b *Builder) resolveImage(ctx context.Context, state *buildContext, prebuilt bool) (string, error) {
	if err := validateBuildOwnership(state); err != nil {
		return "", err
	}
	if prebuilt {
		return b.resolveAuthorizedPrebuiltImage(ctx, state)
	}
	for _, key := range []string{"image", "imageUrl", "registry"} {
		if value, exists := state.Job.Payload[key]; exists && strings.TrimSpace(stringValue(value)) != "" {
			return "", fmt.Errorf("workflow image destination override %q is not allowed for source builds", key)
		}
	}
	repository, err := b.derivedImageRepository(state)
	if err != nil {
		return "", err
	}
	commit := firstNonEmpty(state.Deployment.CommitSHA, state.Deployment.CommitHash)
	if commit == "" && b.Config.Production {
		return "", errors.New("production source build requires an authoritative deployment commit")
	}
	tag := slug(commit)
	if commit == "" {
		tag = "build-" + buildIdentityHash(state)[:16]
	}
	image := repository + ":" + tag
	if err := validateExactImageRepository(image, repository); err != nil {
		return "", err
	}
	return image, nil
}

func (b *Builder) resolveAuthorizedPrebuiltImage(ctx context.Context, state *buildContext) (string, error) {
	for _, key := range []string{"image", "imageUrl", "registry", "retagImage"} {
		if value, exists := state.Job.Payload[key]; exists && strings.TrimSpace(stringValue(value)) != "" {
			return "", fmt.Errorf("workflow prebuilt image override %q is not allowed", key)
		}
	}
	image := firstNonEmpty(state.Deployment.ImageURL, state.Service.ImageURL, state.Service.Image)
	if image == "" {
		return "", errors.New("prebuilt image reference is required")
	}
	for _, candidate := range []string{state.Deployment.ImageURL, state.Service.ImageURL, state.Service.Image} {
		if strings.TrimSpace(candidate) != "" && strings.TrimSpace(candidate) != strings.TrimSpace(image) {
			return "", errors.New("prebuilt image references conflict across authoritative records")
		}
	}
	digest, err := embeddedDigestFromImage(image)
	if err != nil || digest == "" {
		return "", errors.New("prebuilt image requires an immutable sha256 digest reference")
	}
	if recorded := strings.TrimSpace(state.Deployment.ImageDigest); recorded != "" && recorded != digest {
		return "", errors.New("prebuilt image digest conflicts with deployment record")
	}
	authorizer, ok := b.Store.(prebuiltImageAuthorizer)
	if !ok {
		return "", errors.New("prebuilt image requires authoritative control-plane authorization")
	}
	if err := authorizer.AuthorizePrebuiltImage(ctx, state.Project.OrganizationID, state.Project.ID, state.Service.ID, image); err != nil {
		return "", fmt.Errorf("prebuilt image authoritative control-plane authorization failed: %w", err)
	}
	return image, nil
}

func validateBuildOwnership(state *buildContext) error {
	if state == nil || state.Job == nil || state.Project == nil || state.Service == nil || state.Deployment == nil {
		return errors.New("complete authoritative build state is required")
	}
	if strings.TrimSpace(state.Project.ID) == "" || strings.TrimSpace(state.Service.ID) == "" || strings.TrimSpace(state.Job.ID) == "" {
		return errors.New("authoritative project, service, and job identities are required")
	}
	if state.Service.ProjectID != state.Project.ID || state.Deployment.ProjectID != state.Project.ID || state.Deployment.ServiceID != state.Service.ID {
		return errors.New("deployment, service, and project ownership records do not match")
	}
	return nil
}

func (b *Builder) derivedImageRepository(state *buildContext) (string, error) {
	if b.Config.Production && strings.TrimSpace(state.Project.OrganizationID) == "" {
		return "", errors.New("production source build requires an authoritative organization identity")
	}
	prefix, _, err := normalizedRegistryPrefix(b.Config.Registry)
	if err != nil {
		return "", fmt.Errorf("configured registry prefix is invalid: %w", err)
	}
	organizationID := strings.TrimSpace(state.Project.OrganizationID)
	if organizationID == "" {
		organizationID = "organization-unset"
	}
	return strings.Join([]string{
		prefix,
		immutableIdentitySegment("org", organizationID),
		immutableIdentitySegment("project", state.Project.ID),
		immutableIdentitySegment("service", state.Service.ID),
	}, "/"), nil
}

func immutableIdentitySegment(kind, value string) string {
	sum := sha256.Sum256([]byte("raibitserver-registry-segment-v1\x00" + kind + "\x00" + strings.TrimSpace(value)))
	return kind + "-" + hex.EncodeToString(sum[:12])
}

func validateExactImageRepository(image, expectedRepository string) error {
	repository, err := imageRepository(image)
	if err != nil {
		return err
	}
	if repository != strings.ToLower(strings.TrimSpace(expectedRepository)) {
		return errors.New("image destination does not match the authoritative service repository")
	}
	return nil
}

func (b *Builder) metadataDir() string {
	if b.Config.MetadataDir != "" {
		return b.Config.MetadataDir
	}
	return filepath.Join(b.Config.WorkspaceDir, "metadata")
}

func (b *Builder) resolveLocalSourceDir(localPath string) (string, error) {
	sourceDir := filepath.Clean(localPath)
	if !filepath.IsAbs(sourceDir) {
		sourceDir = filepath.Join(b.Config.WorkspaceDir, sourceDir)
	}
	return resolvePathWithin(b.Config.WorkspaceDir, sourceDir)
}

func resolvePathWithin(baseDir, value string) (string, error) {
	base := filepath.Clean(baseDir)
	if !filepath.IsAbs(base) {
		absBase, err := filepath.Abs(base)
		if err != nil {
			return "", err
		}
		base = absBase
	}
	candidate := value
	if !filepath.IsAbs(candidate) {
		candidate = filepath.Join(base, candidate)
	}
	candidate = filepath.Clean(candidate)
	rel, err := filepath.Rel(base, candidate)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("path %q escapes allowed base directory", value)
	}
	return candidate, nil
}

func (b *Builder) validateRuntimeConfig() error {
	if b.Config.DryRun {
		return nil
	}
	if b.Config.Production && (b.Config.IsolationMode != "single-job-pod" || !b.Config.RunOnce) {
		return errors.New("production live builder requires single-job-pod isolation and run-once process lifecycle")
	}
	if b.Config.Production {
		if err := validateRegistryCredentialBrokerURL(b.Config.RegistryCredentialBrokerURL); err != nil {
			return err
		}
		if strings.TrimSpace(b.Config.RegistryCredentialBrokerTokenFile) == "" {
			return errors.New("production live builder requires a secret-backed registry credential broker token file")
		}
		if err := validateRegistryCredentialLifetimeConfig(b.Config); err != nil {
			return err
		}
		if b.Config.Builder == "buildctl" {
			if err := validateBuildkitConnectionConfig(b.Config); err != nil {
				return err
			}
		}
	}
	if strings.TrimSpace(b.Config.Registry) == "" {
		return errors.New("live builder requires an explicit registry")
	}
	if !b.Config.Push {
		return errors.New("live builder requires registry push to be enabled")
	}
	if registryIsPrivate(b.Config.Registry) {
		return errors.New("live builder registry must not resolve to a private registry address")
	}
	if !b.Config.Scan {
		return errors.New("live builder requires fail-closed vulnerability scanning")
	}
	if !b.Config.Sign {
		return errors.New("live builder requires image signing")
	}
	if b.Config.Scan && strings.TrimSpace(b.Config.Scanner) == "" {
		return errors.New("configured image scan requires a scanner command")
	}
	if b.Config.Sign {
		if strings.TrimSpace(b.Config.Signer) == "" {
			return errors.New("configured image signing requires a signer command")
		}
		if strings.TrimSpace(b.Config.SigningKeyPath) == "" {
			return errors.New("configured live image signing requires a secret-backed signing key path")
		}
	}
	return nil
}

func validateBuildkitConnectionConfig(config Config) error {
	parsed, err := url.Parse(strings.TrimSpace(config.BuildkitAddress))
	if err != nil || parsed.Scheme != "tcp" || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("production buildctl requires an explicit loopback TCP address protected by mTLS")
	}
	host := net.ParseIP(parsed.Hostname())
	port, portError := strconv.Atoi(parsed.Port())
	if host == nil || !host.IsLoopback() || portError != nil || port < 1 || port > 65535 {
		return errors.New("production buildctl endpoint must use an explicit loopback IP and port")
	}
	tlsDirectory := strings.TrimSpace(config.BuildkitTLSDirectory)
	if !filepath.IsAbs(tlsDirectory) || filepath.Clean(tlsDirectory) != tlsDirectory {
		return errors.New("production buildctl requires an absolute clean mTLS directory")
	}
	serverName := strings.TrimSpace(config.BuildkitTLSServerName)
	if serverName == "" || strings.ContainsAny(serverName, " \t\r\n/\\:@") {
		return errors.New("production buildctl requires an explicit TLS server name")
	}
	return nil
}

func (b *Builder) buildCacheArgs(state *buildContext) ([]string, error) {
	for _, key := range []string{"cacheRef", "buildCacheRef"} {
		if _, exists := state.Job.Payload[key]; exists {
			return nil, fmt.Errorf("workflow cache destination override %q is not allowed", key)
		}
	}
	if strings.EqualFold(stringValue(state.Job.Payload["cache"]), "false") || strings.EqualFold(stringValue(state.Job.Payload["buildCache"]), "false") {
		return nil, nil
	}
	cacheMode := firstNonEmpty(stringValue(state.Job.Payload["buildCache"]), os.Getenv("RAIBITSERVER_BUILDKIT_CACHE"))
	if strings.EqualFold(cacheMode, "registry") || strings.EqualFold(cacheMode, "true") {
		repository, err := b.derivedImageRepository(state)
		if err != nil {
			return nil, err
		}
		if err := validateExactImageRepository(state.Image, repository); err != nil {
			return nil, err
		}
		cacheRef := repository + ":buildcache"
		if err := validateImageDestination(cacheRef, b.Config.Registry); err != nil {
			return nil, err
		}
		if b.Config.Builder == "buildctl" {
			return []string{"--import-cache", "type=registry,ref=" + cacheRef, "--export-cache", "type=registry,ref=" + cacheRef + ",mode=max"}, nil
		}
		return []string{"--cache-from", "type=registry,ref=" + cacheRef, "--cache-to", "type=registry,ref=" + cacheRef + ",mode=max"}, nil
	}
	if b.Config.Builder == "buildctl" {
		return []string{"--export-cache", "type=inline"}, nil
	}
	return []string{"--cache-to", "type=inline"}, nil
}

func (b *Builder) writeLog(ctx context.Context, state *buildContext, step, line, level string) error {
	return b.Store.AppendBuildLog(ctx, controlplane.BuildLogInput{DeploymentID: state.Deployment.ID, Step: step, Line: line, Level: level})
}

func (b *Builder) writeCommandLogs(ctx context.Context, state *buildContext, step string, result CommandResult) error {
	if err := b.writeLog(ctx, state, step, "$ "+result.Command, "info"); err != nil {
		return err
	}
	for _, line := range splitLines(result.Stdout) {
		if err := b.writeLog(ctx, state, step, line, "info"); err != nil {
			return err
		}
	}
	for _, line := range splitLines(result.Stderr) {
		if err := b.writeLog(ctx, state, step, line, "warn"); err != nil {
			return err
		}
	}
	return nil
}

func ConfigFromEnv() Config {
	dryRun := os.Getenv("RAIBITSERVER_EXECUTE") != "1"
	timeout := defaultBuildCommandTimeout
	if value := os.Getenv("RAIBITSERVER_BUILD_TIMEOUT_SECONDS"); value != "" {
		if parsed, err := time.ParseDuration(value + "s"); err == nil {
			timeout = parsed
		}
	}
	return Config{
		WorkerID:                          envOr("RAIBITSERVER_WORKER_ID", "raibitserver-builder"),
		WorkspaceDir:                      envOr("RAIBITSERVER_WORKSPACE", filepath.Join(os.TempDir(), "raibitserver-builder")),
		Registry:                          os.Getenv("RAIBITSERVER_REGISTRY"),
		DryRun:                            dryRun,
		Production:                        boolFromEnv("RAIBITSERVER_PRODUCTION") || strings.EqualFold(os.Getenv("RAIBITSERVER_ENV"), "production"),
		AllowAnonymousGit:                 boolFromEnv("RAIBITSERVER_ALLOW_ANONYMOUS_GIT"),
		Push:                              boolFromEnv("RAIBITSERVER_PUSH"),
		Builder:                           envOr("RAIBITSERVER_BUILDER", "docker-buildx"),
		BuildkitAddress:                   firstNonEmpty(os.Getenv("RAIBITSERVER_BUILDKIT_ADDRESS"), os.Getenv("BUILDKIT_HOST")),
		BuildkitTLSDirectory:              strings.TrimSpace(os.Getenv("RAIBITSERVER_BUILDKIT_TLS_DIRECTORY")),
		BuildkitTLSServerName:             strings.TrimSpace(os.Getenv("RAIBITSERVER_BUILDKIT_TLS_SERVER_NAME")),
		IsolationMode:                     strings.TrimSpace(os.Getenv("RAIBITSERVER_BUILDER_ISOLATION")),
		RunOnce:                           boolFromEnv("RAIBITSERVER_RUN_ONCE"),
		GeneratedDockerfileFrontend:       strings.TrimSpace(os.Getenv("RAIBITSERVER_GENERATED_DOCKERFILE_FRONTEND")),
		GeneratedNodeImage:                strings.TrimSpace(os.Getenv("RAIBITSERVER_GENERATED_NODE_IMAGE")),
		RegistryCredentialBrokerURL:       strings.TrimSpace(os.Getenv("RAIBITSERVER_REGISTRY_CREDENTIAL_BROKER_URL")),
		RegistryCredentialBrokerTokenFile: strings.TrimSpace(os.Getenv("RAIBITSERVER_REGISTRY_CREDENTIAL_BROKER_TOKEN_FILE")),
		RegistryCredentialMinTTL:          time.Duration(intFromEnv("RAIBITSERVER_REGISTRY_CREDENTIAL_MIN_TTL_SECONDS", int(defaultRegistryCredentialMinTTL/time.Second))) * time.Second,
		RegistryCredentialMaxTTL:          time.Duration(intFromEnv("RAIBITSERVER_REGISTRY_CREDENTIAL_MAX_TTL_SECONDS", 900)) * time.Second,
		Timeout:                           timeout,
		LeaseSeconds:                      intFromEnv("RAIBITSERVER_WORKFLOW_LEASE_SECONDS", 300),
		MetadataDir:                       os.Getenv("RAIBITSERVER_BUILD_METADATA_DIR"),
		Scan:                              boolFromEnv("RAIBITSERVER_SCAN"),
		Scanner:                           envOr("RAIBITSERVER_SCANNER", "trivy"),
		ScanSeverity:                      envOr("RAIBITSERVER_SCAN_SEVERITY", "HIGH,CRITICAL"),
		Sign:                              boolFromEnv("RAIBITSERVER_SIGN"),
		Signer:                            envOr("RAIBITSERVER_SIGNER", "cosign"),
		SigningKeyPath:                    os.Getenv("RAIBITSERVER_SIGNING_KEY"),
	}
}

func StateFileFromEnv() string {
	return firstNonEmpty(os.Getenv("RAIBITSERVER_CONTROL_PLANE_FILE"), os.Getenv("RAIBITSERVER_STATE_FILE"), os.Getenv("RAIBITSERVER_WORKFLOW_STATE"))
}

func isPrebuilt(service *controlplane.Service, deployment *controlplane.Deployment) bool {
	source := strings.ToLower(service.SourceType)
	mode := normalizeMode(service.BuildMode)
	return source == "image" || mode == "prebuilt-image" || (service.RepoURL == "" && service.LocalPath == "" && firstNonEmpty(deployment.ImageURL, service.ImageURL, service.Image) != "")
}

func normalizeMode(value string) string {
	normalized := strings.ToLower(strings.ReplaceAll(value, "_", "-"))
	switch normalized {
	case "", "auto":
		return "auto"
	case "docker", "dockerfile":
		return "dockerfile"
	case "image", "prebuilt", "prebuilt-image":
		return "prebuilt-image"
	case "generated", "framework", "buildpack", "buildpacks", "custom":
		return normalized
	default:
		return "auto"
	}
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func intFromEnv(key string, fallback int) int {
	if value := os.Getenv(key); value != "" {
		var parsed int
		if _, err := fmt.Sscanf(value, "%d", &parsed); err == nil {
			return parsed
		}
	}
	return fallback
}

func boolFromEnv(key string) bool {
	value := strings.TrimSpace(os.Getenv(key))
	return value == "1" || strings.EqualFold(value, "true") || strings.EqualFold(value, "yes")
}

func stringValue(value any) string {
	if value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return typed
	case fmt.Stringer:
		return typed.String()
	default:
		return fmt.Sprintf("%v", typed)
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func buildArgsFromPayload(payload map[string]any) (map[string]string, error) {
	value, ok := payload["buildArgs"].(map[string]any)
	if !ok {
		return map[string]string{}, nil
	}
	out := map[string]string{}
	for key, item := range value {
		if !buildArgNamePattern.MatchString(key) {
			return nil, fmt.Errorf("invalid build arg name %q", key)
		}
		if strings.EqualFold(key, "BUILDKIT_CACHE_MOUNT_NS") {
			return nil, errors.New("BuildKit cache namespace build arg is reserved for the builder")
		}
		if secretBuildArgPattern.MatchString(key) {
			return nil, fmt.Errorf("secret-looking build arg %q is not allowed; use a BuildKit secret mount", key)
		}
		out[key] = stringValue(item)
	}
	return out, nil
}

func splitLines(value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return strings.Split(strings.ReplaceAll(value, "\r\n", "\n"), "\n")
}

func embeddedDigestFromImage(image string) (string, error) {
	parts := strings.SplitN(strings.TrimSpace(image), "@", 2)
	if len(parts) == 1 {
		return "", nil
	}
	if len(parts) != 2 || !validSHA256Digest(parts[1]) {
		return "", errors.New("image reference contains an invalid sha256 digest")
	}
	return parts[1], nil
}

func validSHA256Digest(value string) bool {
	return sha256DigestPattern.MatchString(strings.TrimSpace(value))
}

func validDigestPinnedImageReference(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || strings.ContainsAny(value, " \t\r\n") || strings.Contains(value, "://") || strings.Count(value, "@") != 1 {
		return false
	}
	reference, digest, _ := strings.Cut(value, "@")
	return reference != "" && !strings.HasPrefix(reference, "/") && !strings.HasSuffix(reference, "/") && validSHA256Digest(digest)
}

func digestPinnedImage(image, digest string) (string, error) {
	image = strings.TrimSpace(image)
	if image == "" {
		return "", errors.New("image reference is required")
	}
	if !validSHA256Digest(digest) {
		return "", errors.New("valid sha256 registry digest is required")
	}
	if strings.Contains(image, "@") {
		parts := strings.SplitN(image, "@", 2)
		if !validSHA256Digest(parts[1]) {
			return "", errors.New("image reference contains an invalid sha256 digest")
		}
		if parts[1] != digest {
			return "", errors.New("image digest conflict between image reference and supplied digest")
		}
		image = parts[0]
	}
	lastSlash := strings.LastIndex(image, "/")
	if colon := strings.LastIndex(image, ":"); colon > lastSlash {
		image = image[:colon]
	}
	return image + "@" + digest, nil
}

func registryIsPrivate(value string) bool {
	_, host, err := normalizedRegistryPrefix(value)
	if err != nil {
		return true
	}
	hostname := strings.ToLower(host)
	if hostname == "localhost" || strings.HasSuffix(hostname, ".localhost") || strings.HasSuffix(hostname, ".local") || strings.HasSuffix(hostname, ".internal") {
		return true
	}
	if ip := net.ParseIP(hostname); ip != nil {
		return ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified()
	}
	return false
}

func validateImageDestination(image, configuredRegistry string) error {
	prefix, _, err := normalizedRegistryPrefix(configuredRegistry)
	if err != nil {
		return fmt.Errorf("configured registry prefix is invalid: %w", err)
	}
	repository, err := imageRepository(image)
	if err != nil {
		return err
	}
	if repository != prefix && !strings.HasPrefix(repository, prefix+"/") {
		return errors.New("image destination is outside configured registry prefix")
	}
	return nil
}

func normalizedRegistryPrefix(value string) (string, string, error) {
	value = strings.TrimSpace(strings.TrimRight(value, "/"))
	if value == "" || strings.Contains(value, "://") {
		return "", "", errors.New("registry must be a host/path prefix without a URL scheme")
	}
	parsed, err := url.Parse("registry://" + value)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", "", errors.New("registry must not contain credentials, query parameters, or fragments")
	}
	hostname := parsed.Hostname()
	if hostname == "" {
		return "", "", errors.New("registry host is required")
	}
	prefix := strings.ToLower(parsed.Host + strings.TrimRight(parsed.EscapedPath(), "/"))
	return prefix, hostname, nil
}

func imageRepository(image string) (string, error) {
	image = strings.TrimSpace(image)
	if image == "" || strings.Contains(image, "://") {
		return "", errors.New("image destination must be an OCI registry reference")
	}
	withoutDigest := strings.SplitN(image, "@", 2)[0]
	lastSlash := strings.LastIndex(withoutDigest, "/")
	if lastSlash <= 0 {
		return "", errors.New("image destination must include a configured registry host and repository")
	}
	if colon := strings.LastIndex(withoutDigest, ":"); colon > lastSlash {
		withoutDigest = withoutDigest[:colon]
	}
	return strings.ToLower(strings.TrimRight(withoutDigest, "/")), nil
}

func deterministicDigest(parts ...string) string {
	hash := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return "sha256:" + hex.EncodeToString(hash[:])
}

var slugPattern = regexp.MustCompile(`[^a-z0-9._-]+`)
var sha256DigestPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var buildArgNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
var secretBuildArgPattern = regexp.MustCompile(`(?i)(secret|password|passwd|token|private.?key|credential|database.?url|api.?key|access.?key|auth)`)
var secretQueryKeyPattern = regexp.MustCompile(`(?i)(secret|password|passwd|token|private.?key|credential|database.?url|api.?key|access.?key|auth)`)
var githubRepositoryPartPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

func slug(value string) string {
	out := strings.ToLower(strings.TrimSpace(value))
	out = slugPattern.ReplaceAllString(out, "-")
	out = strings.Trim(out, "-._")
	if out == "" {
		return "item"
	}
	return out
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func validateAuthoritativeGitSource(service *controlplane.Service) (bool, error) {
	fields := []string{
		service.GitHubIntegrationID,
		service.GitHubInstallationID,
		service.GitHubRepositoryID,
		service.GitHubRepository,
		service.GitHubRepositoryVisibility,
	}
	populated := 0
	for _, field := range fields {
		if strings.TrimSpace(field) != "" {
			populated++
		}
	}
	if populated == 0 {
		return false, nil
	}
	if populated != len(fields) {
		return false, errors.New("GitHub repository binding is incomplete; source build rejected")
	}
	visibility := strings.ToLower(strings.TrimSpace(service.GitHubRepositoryVisibility))
	if visibility != "public" && visibility != "private" {
		return false, errors.New("GitHub repository binding visibility must be public or private")
	}
	repository, err := canonicalGitHubRepository(service.RepoURL)
	if err != nil {
		return false, err
	}
	if !strings.EqualFold(repository, normalizeGitHubRepositoryName(service.GitHubRepository)) {
		return false, errors.New("GitHub repository binding does not match the authoritative repository URL")
	}
	return true, nil
}

func validateWorkflowSourcePayload(state *buildContext, bound bool) error {
	expectedRepository, err := canonicalGitHubRepository(state.Service.RepoURL)
	if err != nil {
		return err
	}
	if payloadURL := strings.TrimSpace(stringValue(state.Job.Payload["repoUrl"])); payloadURL != "" {
		payloadRepository, payloadErr := canonicalGitHubRepository(payloadURL)
		if payloadErr != nil || !strings.EqualFold(payloadRepository, expectedRepository) {
			return errors.New("workflow repository payload does not match the authoritative service binding")
		}
	}
	if payloadRepository := strings.TrimSpace(stringValue(state.Job.Payload["repository"])); payloadRepository != "" {
		if normalized := normalizeGitHubRepositoryName(payloadRepository); !strings.EqualFold(normalized, expectedRepository) {
			return errors.New("workflow repository payload does not match the authoritative service binding")
		}
	}
	if payloadRepositoryID := strings.TrimSpace(firstNonEmpty(stringValue(state.Job.Payload["githubRepositoryId"]), stringValue(state.Job.Payload["repositoryId"]))); payloadRepositoryID != "" {
		if !bound || payloadRepositoryID != strings.TrimSpace(state.Service.GitHubRepositoryID) {
			return errors.New("workflow repository payload does not match the authoritative service binding")
		}
	}
	if payloadInstallationID := strings.TrimSpace(stringValue(state.Job.Payload["githubInstallationId"])); payloadInstallationID != "" {
		if !bound || payloadInstallationID != strings.TrimSpace(state.Service.GitHubInstallationID) {
			return errors.New("workflow repository payload does not match the authoritative service binding")
		}
	}
	branch := firstNonEmpty(state.Deployment.Branch, state.Service.Branch, "main")
	if payloadBranch := strings.TrimSpace(stringValue(state.Job.Payload["branch"])); payloadBranch != "" && payloadBranch != branch {
		return errors.New("workflow branch payload does not match the authoritative deployment binding")
	}
	commit := firstNonEmpty(state.Deployment.CommitSHA, state.Deployment.CommitHash)
	if payloadCommit := strings.TrimSpace(stringValue(state.Job.Payload["commitSha"])); payloadCommit != "" && !strings.EqualFold(payloadCommit, commit) {
		return errors.New("workflow commit payload does not match the authoritative deployment binding")
	}
	return nil
}

func canonicalGitHubRepository(value string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || !strings.EqualFold(parsed.Scheme, "https") || !strings.EqualFold(parsed.Hostname(), "github.com") || parsed.Port() != "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("Git source URL must be an uncredentialed HTTPS github.com repository URL")
	}
	parts := strings.Split(strings.Trim(strings.TrimSuffix(parsed.EscapedPath(), ".git"), "/"), "/")
	if len(parts) != 2 {
		return "", errors.New("Git source URL must identify exactly one github.com owner/repository")
	}
	owner, ownerErr := url.PathUnescape(parts[0])
	repository, repositoryErr := url.PathUnescape(parts[1])
	if ownerErr != nil || repositoryErr != nil || !githubRepositoryPartPattern.MatchString(owner) || !githubRepositoryPartPattern.MatchString(repository) {
		return "", errors.New("Git source URL contains an invalid GitHub repository name")
	}
	return strings.ToLower(owner + "/" + repository), nil
}

func normalizeGitHubRepositoryName(value string) string {
	normalized := strings.TrimSpace(value)
	if repository, err := canonicalGitHubRepository(normalized); err == nil {
		return repository
	}
	normalized = strings.TrimSuffix(strings.Trim(normalized, "/"), ".git")
	parts := strings.Split(normalized, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return ""
	}
	return strings.ToLower(parts[0] + "/" + parts[1])
}

func isolatedGitEnvironment(workspace string) map[string]string {
	return map[string]string{
		"GIT_TERMINAL_PROMPT": "0",
		"GIT_CONFIG_NOSYSTEM": "1",
		"GIT_CONFIG_GLOBAL":   filepath.Join(workspace, "disabled-global-gitconfig"),
	}
}

func isCredentialedURL(value string) bool {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme == "" {
		return false
	}
	if parsed.User != nil {
		return true
	}
	for key := range parsed.Query() {
		if secretQueryKeyPattern.MatchString(key) {
			return true
		}
	}
	return false
}

func redactCredentialedGitURL(value string) string {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil {
		return controlplane.Redact(value)
	}
	if parsed.User != nil {
		parsed.User = url.User("redacted")
	}
	query := parsed.Query()
	for key := range query {
		if secretQueryKeyPattern.MatchString(key) {
			query.Set(key, "redacted")
		}
	}
	parsed.RawQuery = query.Encode()
	return controlplane.Redact(parsed.String())
}

func redactArgs(args []string) []string {
	out := make([]string, len(args))
	for i, arg := range args {
		out[i] = controlplane.Redact(arg)
		if isCredentialedURL(arg) {
			out[i] = redactCredentialedGitURL(arg)
		}
	}
	return out
}
