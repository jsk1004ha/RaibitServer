package controlplane

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	WorkflowQueued    = "queued"
	WorkflowRunning   = "running"
	WorkflowSucceeded = "succeeded"
	WorkflowFailed    = "failed"

	exhaustedWorkflowReapLimit      = 16
	exhaustedWorkflowFailureMessage = "build worker lease expired after the final allowed attempt"

	DeletionStatusRequested = "DELETE_REQUESTED"
	DeletionStatusDeleting  = "DELETING"
	DeletionStatusFailed    = "DELETE_FAILED"
)

type Store interface {
	ClaimNextWorkflowJob(ctx context.Context, options ClaimOptions) (*WorkflowJob, error)
	CompleteWorkflowJob(ctx context.Context, lease WorkflowLease, result map[string]any) error
	FailWorkflowJob(ctx context.Context, lease WorkflowLease, failure error) error
	CancelWorkflowJob(ctx context.Context, lease WorkflowLease, reason error) error
	RenewWorkflowJobLease(ctx context.Context, lease WorkflowLease, now time.Time) error
	GetProject(ctx context.Context, projectID string) (*Project, error)
	GetService(ctx context.Context, serviceID string) (*Service, error)
	GetDeployment(ctx context.Context, deploymentID string) (*Deployment, error)
	UpdateDeployment(ctx context.Context, deploymentID string, updates map[string]any) (*Deployment, error)
	UpdateDeploymentForLease(ctx context.Context, lease WorkflowLease, deploymentID string, updates map[string]any) (*Deployment, error)
	UpdateService(ctx context.Context, serviceID string, updates map[string]any) (*Service, error)
	StartBuild(ctx context.Context, input BuildStartInput) error
	PublishImageReady(ctx context.Context, input ImagePublicationInput) error
	AppendBuildLog(ctx context.Context, input BuildLogInput) error
	AppendDeploymentEvent(ctx context.Context, input DeploymentEventInput) error
}

type ClaimOptions struct {
	WorkerID     string
	LeaseSeconds int
	Now          time.Time
}

type WorkflowJob struct {
	ID          string
	Type        string
	Status      string
	TargetType  string
	TargetID    string
	Payload     map[string]any
	Attempts    int
	MaxAttempts int
	LockedBy    string
}

type WorkflowLease struct {
	JobID    string
	WorkerID string
	Attempt  int
}

var (
	ErrWorkflowLeaseLost   = errors.New("workflow job lease ownership lost")
	ErrBuildTargetDeleting = errors.New("build target is deleting; image publication cancelled")
)

func (job *WorkflowJob) Lease() WorkflowLease {
	if job == nil {
		return WorkflowLease{}
	}
	return WorkflowLease{JobID: job.ID, WorkerID: job.LockedBy, Attempt: job.Attempts}
}

type Project struct {
	ID             string
	OrganizationID string
	Name           string
	Slug           string
	Status         string
}

type Service struct {
	ID                         string
	ProjectID                  string
	Name                       string
	Slug                       string
	Type                       string
	RuntimeType                string
	SourceType                 string
	BuildMode                  string
	RepoURL                    string
	GitHubIntegrationID        string
	GitHubInstallationID       string
	GitHubRepositoryID         string
	GitHubRepository           string
	GitHubRepositoryVisibility string
	SourceAccess               string
	Branch                     string
	RootDirectory              string
	BuildContext               string
	DockerfilePath             string
	InstallCommand             string
	BuildCommand               string
	StartCommand               string
	OutputDirectory            string
	Image                      string
	ImageURL                   string
	Registry                   string
	LocalPath                  string
	Port                       int
	Status                     string
	DesiredSpec                map[string]any
	DesiredState               map[string]any
}

type Deployment struct {
	ID                  string
	ServiceID           string
	ProjectID           string
	Status              string
	DeploymentType      string
	TriggerType         string
	Branch              string
	CommitSHA           string
	CommitHash          string
	PullRequestNumber   int
	PreviewURL          string
	ImageURL            string
	ImageDigest         string
	DesiredSpecSnapshot json.RawMessage
	SnapshotVersion     *int
	SourceDeploymentID  string
	RetryOfDeploymentID string
}

type BuildLogInput struct {
	DeploymentID string
	Step         string
	Line         string
	Level        string
}

type DeploymentEventInput struct {
	DeploymentID string
	Type         string
	Message      string
	Metadata     map[string]any
}

type BuildStartInput struct {
	Lease        WorkflowLease
	DeploymentID string
	ServiceID    string
	ProjectID    string
	StartedAt    time.Time
}

type ImagePublicationInput struct {
	Lease           WorkflowLease
	DeploymentID    string
	ServiceID       string
	ProjectID       string
	ImageURL        string
	ImageDigest     string
	DryRun          bool
	SupplyChain     map[string]any
	BuildFinishedAt time.Time
}

func imagePublicationResult(input ImagePublicationInput) map[string]any {
	return map[string]any{
		"deploymentId": input.DeploymentID,
		"serviceId":    input.ServiceID,
		"image":        input.ImageURL,
		"imageDigest":  input.ImageDigest,
		"dryRun":       input.DryRun,
		"supplyChain":  input.SupplyChain,
	}
}

func imagePublicationEvent(input ImagePublicationInput) DeploymentEventInput {
	return DeploymentEventInput{
		DeploymentID: input.DeploymentID,
		Type:         "build.image_ready",
		Message:      "image built and ready for orchestration",
		Metadata: map[string]any{
			"image":       input.ImageURL,
			"imageDigest": input.ImageDigest,
			"dryRun":      input.DryRun,
			"supplyChain": input.SupplyChain,
		},
	}
}

type FileStore struct {
	path string
	mu   sync.Mutex
}

func NewFileStore(path string) *FileStore {
	return &FileStore{path: path}
}

func (s *FileStore) ClaimNextWorkflowJob(ctx context.Context, options ClaimOptions) (*WorkflowJob, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	state, err := s.load()
	if err != nil {
		return nil, err
	}
	now := options.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	leaseSeconds := options.LeaseSeconds
	if leaseSeconds <= 0 {
		leaseSeconds = 300
	}
	workerID := options.WorkerID
	if workerID == "" {
		workerID = "raibitserver-builder"
	}
	reaped := reapExhaustedWorkflowJobs(state, now, time.Duration(leaseSeconds)*time.Second, exhaustedWorkflowReapLimit)

	jobs := recordSlice(state, "workflowJobs")
	sort.SliceStable(jobs, func(i, j int) bool {
		return parseTime(stringField(jobs[i], "runAfter"), time.Time{}).Before(parseTime(stringField(jobs[j], "runAfter"), time.Time{}))
	})
	claimedIndex := -1
	for _, candidate := range jobs {
		if !isBuilderWorkflowType(stringField(candidate, "type")) || !workflowReady(candidate, now, time.Duration(leaseSeconds)*time.Second) {
			continue
		}
		if workflowTargetDeleting(state, candidate) {
			continue
		}
		claimedIndex = findRecordIndex(recordSlice(state, "workflowJobs"), stringField(candidate, "id"))
		if claimedIndex >= 0 {
			break
		}
	}
	if claimedIndex < 0 {
		if reaped > 0 {
			if err := s.save(state); err != nil {
				return nil, err
			}
		}
		return nil, nil
	}

	allJobs := recordSlice(state, "workflowJobs")
	job := allJobs[claimedIndex]
	job["status"] = WorkflowRunning
	job["attempts"] = intField(job, "attempts") + 1
	job["lockedBy"] = workerID
	job["lockedAt"] = now.Format(time.RFC3339Nano)
	job["updatedAt"] = now.Format(time.RFC3339Nano)
	setRecordSlice(state, "workflowJobs", allJobs)
	if err := s.save(state); err != nil {
		return nil, err
	}
	return workflowJobFromRecord(job), nil
}

func (s *FileStore) CompleteWorkflowJob(ctx context.Context, lease WorkflowLease, result map[string]any) error {
	return s.updateWorkflowJob(ctx, lease, func(job record, now time.Time) {
		payload := mapField(job, "payload")
		payload["lastResult"] = MaskSecrets(result)
		payload["completedAt"] = now.Format(time.RFC3339Nano)
		job["payload"] = MaskSecrets(payload)
		job["status"] = WorkflowSucceeded
		job["lockedBy"] = nil
		job["lockedAt"] = nil
		job["updatedAt"] = now.Format(time.RFC3339Nano)
	})
}

func (s *FileStore) FailWorkflowJob(ctx context.Context, lease WorkflowLease, failure error) error {
	return s.updateWorkflowJob(ctx, lease, func(job record, now time.Time) {
		attempts := intField(job, "attempts")
		maxAttempts := intField(job, "maxAttempts")
		if maxAttempts <= 0 {
			maxAttempts = 3
		}
		payload := mapField(job, "payload")
		payload["lastError"] = Redact(failureMessage(failure))
		payload["lastErrorSpec"] = ErrorSpecForFailure(failure, ErrorCodeUnknownInfra)
		payload["failedAt"] = now.Format(time.RFC3339Nano)
		job["payload"] = MaskSecrets(payload)
		if attempts < maxAttempts {
			job["status"] = WorkflowQueued
			job["runAfter"] = now.Add(retryDelay(attempts)).Format(time.RFC3339Nano)
		} else {
			job["status"] = WorkflowFailed
		}
		job["lockedBy"] = nil
		job["lockedAt"] = nil
		job["updatedAt"] = now.Format(time.RFC3339Nano)
	})
}

func (s *FileStore) CancelWorkflowJob(ctx context.Context, lease WorkflowLease, reason error) error {
	return s.updateWorkflowJob(ctx, lease, func(job record, now time.Time) {
		payload := mapField(job, "payload")
		payload["lastError"] = Redact(failureMessage(reason))
		payload["lastErrorSpec"] = ErrorSpecForFailure(reason, ErrorCodeDeploymentCancelled)
		payload["cancelledAt"] = now.Format(time.RFC3339Nano)
		job["payload"] = MaskSecrets(payload)
		job["status"] = WorkflowFailed
		job["lockedBy"] = nil
		job["lockedAt"] = nil
		job["updatedAt"] = now.Format(time.RFC3339Nano)
	})
}

func (s *FileStore) RenewWorkflowJobLease(ctx context.Context, lease WorkflowLease, now time.Time) error {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	return s.updateWorkflowJobLease(ctx, lease, func(job record) {
		job["lockedAt"] = now.Format(time.RFC3339Nano)
		job["updatedAt"] = now.Format(time.RFC3339Nano)
	})
}

func (s *FileStore) GetProject(ctx context.Context, projectID string) (*Project, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	state, err := s.loadReadOnly()
	if err != nil {
		return nil, err
	}
	rec := findRecord(recordSlice(state, "projects"), projectID)
	if rec == nil {
		return nil, notFound("project", projectID)
	}
	return projectFromRecord(rec), nil
}

func (s *FileStore) GetService(ctx context.Context, serviceID string) (*Service, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	state, err := s.loadReadOnly()
	if err != nil {
		return nil, err
	}
	rec := findRecord(recordSlice(state, "services"), serviceID)
	if rec == nil {
		return nil, notFound("service", serviceID)
	}
	return serviceFromRecord(rec), nil
}

func (s *FileStore) GetDeployment(ctx context.Context, deploymentID string) (*Deployment, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	state, err := s.loadReadOnly()
	if err != nil {
		return nil, err
	}
	rec := findRecord(recordSlice(state, "deployments"), deploymentID)
	if rec == nil {
		return nil, notFound("deployment", deploymentID)
	}
	deployment := deploymentFromRecord(rec)
	return deployment, deployment.decodeSnapshotRecord(rec)
}

func (s *FileStore) UpdateDeployment(ctx context.Context, deploymentID string, updates map[string]any) (*Deployment, error) {
	return s.updateDeployment(ctx, nil, deploymentID, updates)
}

func (s *FileStore) updateDeploymentForLease(ctx context.Context, lease WorkflowLease, deploymentID string, updates map[string]any) (*Deployment, error) {
	return s.updateDeployment(ctx, &lease, deploymentID, updates)
}

func (s *FileStore) UpdateDeploymentForLease(ctx context.Context, lease WorkflowLease, deploymentID string, updates map[string]any) (*Deployment, error) {
	return s.updateDeploymentForLease(ctx, lease, deploymentID, updates)
}

func (s *FileStore) updateDeployment(ctx context.Context, lease *WorkflowLease, deploymentID string, updates map[string]any) (*Deployment, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return nil, err
	}
	if lease != nil {
		jobs := recordSlice(state, "workflowJobs")
		jobIndex := findRecordIndex(jobs, lease.JobID)
		if jobIndex < 0 {
			return nil, notFound("workflow job", lease.JobID)
		}
		if !recordOwnsWorkflowLease(jobs[jobIndex], *lease) {
			return nil, ErrWorkflowLeaseLost
		}
	}
	rows := recordSlice(state, "deployments")
	idx := findRecordIndex(rows, deploymentID)
	if idx < 0 {
		return nil, notFound("deployment", deploymentID)
	}
	if lease != nil {
		updates, err = leaseFencedDeploymentUpdates(deploymentFromRecord(rows[idx]), updates)
		if err != nil {
			return nil, err
		}
	}
	for key, value := range updates {
		rows[idx][key] = MaskSecrets(value)
	}
	rows[idx]["updatedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	setRecordSlice(state, "deployments", rows)
	if err := s.save(state); err != nil {
		return nil, err
	}
	deployment := deploymentFromRecord(rows[idx])
	return deployment, deployment.decodeSnapshotRecord(rows[idx])
}

var fullGitCommitPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)

func NormalizeGitCommitSHA(value string) (string, error) {
	commit := strings.ToLower(strings.TrimSpace(value))
	if !fullGitCommitPattern.MatchString(commit) {
		return "", errors.New("checked-out Git commit must be a full 40 or 64 character hexadecimal object ID")
	}
	return commit, nil
}

func normalizedDeploymentCommitUpdate(updates map[string]any) (string, bool, error) {
	commitSHA, hasCommitSHA := updates["commitSha"]
	commitHash, hasCommitHash := updates["commitHash"]
	if !hasCommitSHA && !hasCommitHash {
		return "", false, nil
	}
	if len(updates) != 2 || !hasCommitSHA || !hasCommitHash {
		return "", true, errors.New("deployment commit pin must set commitSha and commitHash together")
	}
	sha, shaOK := commitSHA.(string)
	hash, hashOK := commitHash.(string)
	if !shaOK || !hashOK {
		return "", true, errors.New("deployment commit pin values must be strings")
	}
	normalizedSHA, err := NormalizeGitCommitSHA(sha)
	if err != nil {
		return "", true, err
	}
	normalizedHash, err := NormalizeGitCommitSHA(hash)
	if err != nil {
		return "", true, err
	}
	if normalizedSHA != normalizedHash {
		return "", true, errors.New("deployment commitSha and commitHash must match")
	}
	return normalizedSHA, true, nil
}

func leaseFencedDeploymentUpdates(deployment *Deployment, updates map[string]any) (map[string]any, error) {
	commit, requested, err := normalizedDeploymentCommitUpdate(updates)
	if err != nil || !requested {
		return updates, err
	}
	if deployment == nil {
		return nil, errors.New("deployment commit pin target is missing")
	}
	if !strings.EqualFold(strings.TrimSpace(deployment.Status), "BUILDING") {
		return nil, errors.New("deployment commit can only be pinned while BUILDING")
	}
	current := strings.TrimSpace(deployment.CommitSHA)
	if current == "" {
		current = strings.TrimSpace(deployment.CommitHash)
	}
	if current != "" && !strings.EqualFold(current, commit) {
		return nil, errors.New("deployment commit is already pinned to a different revision")
	}
	return map[string]any{"commitSha": commit, "commitHash": commit}, nil
}

func (s *FileStore) UpdateService(ctx context.Context, serviceID string, updates map[string]any) (*Service, error) {
	return s.updateService(ctx, nil, serviceID, updates)
}

func (s *FileStore) updateServiceForLease(ctx context.Context, lease WorkflowLease, serviceID string, updates map[string]any) (*Service, error) {
	return s.updateService(ctx, &lease, serviceID, updates)
}

func (s *FileStore) updateService(ctx context.Context, lease *WorkflowLease, serviceID string, updates map[string]any) (*Service, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return nil, err
	}
	if lease != nil {
		jobs := recordSlice(state, "workflowJobs")
		jobIndex := findRecordIndex(jobs, lease.JobID)
		if jobIndex < 0 {
			return nil, notFound("workflow job", lease.JobID)
		}
		if !recordOwnsWorkflowLease(jobs[jobIndex], *lease) {
			return nil, ErrWorkflowLeaseLost
		}
	}
	rows := recordSlice(state, "services")
	idx := findRecordIndex(rows, serviceID)
	if idx < 0 {
		return nil, notFound("service", serviceID)
	}
	for key, value := range updates {
		rows[idx][key] = MaskSecrets(value)
	}
	rows[idx]["updatedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	setRecordSlice(state, "services", rows)
	if err := s.save(state); err != nil {
		return nil, err
	}
	return serviceFromRecord(rows[idx]), nil
}

func (s *FileStore) StartBuild(ctx context.Context, input BuildStartInput) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return err
	}
	jobs := recordSlice(state, "workflowJobs")
	jobIndex := findRecordIndex(jobs, input.Lease.JobID)
	if jobIndex < 0 {
		return notFound("workflow job", input.Lease.JobID)
	}
	if !recordOwnsWorkflowLease(jobs[jobIndex], input.Lease) {
		return ErrWorkflowLeaseLost
	}
	if !isBuilderWorkflowType(stringField(jobs[jobIndex], "type")) || workflowDeploymentID(jobs[jobIndex]) != input.DeploymentID {
		return ErrWorkflowLeaseLost
	}
	deployments := recordSlice(state, "deployments")
	deploymentIndex := findRecordIndex(deployments, input.DeploymentID)
	if deploymentIndex < 0 {
		return notFound("deployment", input.DeploymentID)
	}
	deployment := deployments[deploymentIndex]
	if stringField(deployment, "serviceId") != input.ServiceID || stringField(deployment, "projectId") != input.ProjectID {
		return errors.New("build start target no longer matches deployment ownership")
	}
	if !strings.EqualFold(strings.TrimSpace(stringField(deployment, "status")), "QUEUED") {
		return ErrWorkflowLeaseLost
	}
	services := recordSlice(state, "services")
	serviceIndex := findRecordIndex(services, input.ServiceID)
	if serviceIndex < 0 {
		return notFound("service", input.ServiceID)
	}
	projects := recordSlice(state, "projects")
	projectIndex := findRecordIndex(projects, input.ProjectID)
	if projectIndex < 0 {
		return notFound("project", input.ProjectID)
	}
	if stringField(services[serviceIndex], "projectId") != input.ProjectID {
		return errors.New("build start target no longer matches service ownership")
	}
	if err := deletingTargetError(stringField(services[serviceIndex], "status"), stringField(projects[projectIndex], "status")); err != nil {
		return err
	}
	startedAt := input.StartedAt
	if startedAt.IsZero() {
		startedAt = time.Now().UTC()
	}
	deployment["status"] = "BUILDING"
	deployment["buildStartedAt"] = startedAt.Format(time.RFC3339Nano)
	deployment["updatedAt"] = startedAt.Format(time.RFC3339Nano)
	setRecordSlice(state, "deployments", deployments)
	return s.save(state)
}

func (s *FileStore) PublishImageReady(ctx context.Context, input ImagePublicationInput) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return err
	}
	jobs := recordSlice(state, "workflowJobs")
	jobIndex := findRecordIndex(jobs, input.Lease.JobID)
	if jobIndex < 0 {
		return notFound("workflow job", input.Lease.JobID)
	}
	if !recordOwnsWorkflowLease(jobs[jobIndex], input.Lease) {
		return ErrWorkflowLeaseLost
	}
	if !isBuilderWorkflowType(stringField(jobs[jobIndex], "type")) || workflowDeploymentID(jobs[jobIndex]) != input.DeploymentID {
		return ErrWorkflowLeaseLost
	}
	deployments := recordSlice(state, "deployments")
	deploymentIndex := findRecordIndex(deployments, input.DeploymentID)
	if deploymentIndex < 0 {
		return notFound("deployment", input.DeploymentID)
	}
	deployment := deployments[deploymentIndex]
	if stringField(deployment, "serviceId") != input.ServiceID || stringField(deployment, "projectId") != input.ProjectID {
		return errors.New("image publication target no longer matches deployment ownership")
	}
	if !strings.EqualFold(strings.TrimSpace(stringField(deployment, "status")), "BUILDING") {
		return ErrWorkflowLeaseLost
	}
	services := recordSlice(state, "services")
	serviceIndex := findRecordIndex(services, input.ServiceID)
	if serviceIndex < 0 {
		return notFound("service", input.ServiceID)
	}
	projects := recordSlice(state, "projects")
	projectIndex := findRecordIndex(projects, input.ProjectID)
	if projectIndex < 0 {
		return notFound("project", input.ProjectID)
	}
	if stringField(services[serviceIndex], "projectId") != input.ProjectID {
		return errors.New("image publication target no longer matches service ownership")
	}
	if err := deletingTargetError(stringField(services[serviceIndex], "status"), stringField(projects[projectIndex], "status")); err != nil {
		return err
	}
	finishedAt := input.BuildFinishedAt
	if finishedAt.IsZero() {
		finishedAt = time.Now().UTC()
	}
	deployment["status"] = "IMAGE_READY"
	deployment["imageUrl"] = input.ImageURL
	deployment["imageDigest"] = input.ImageDigest
	deployment["buildFinishedAt"] = finishedAt.Format(time.RFC3339Nano)
	deployment["errorCode"] = nil
	deployment["errorMessage"] = nil
	deployment["updatedAt"] = finishedAt.Format(time.RFC3339Nano)
	service := services[serviceIndex]
	service["imageUrl"] = input.ImageURL
	service["image"] = input.ImageURL
	service["status"] = "image-ready"
	service["updatedAt"] = finishedAt.Format(time.RFC3339Nano)
	job := jobs[jobIndex]
	payload := mapField(job, "payload")
	payload["lastResult"] = MaskSecrets(imagePublicationResult(input))
	payload["completedAt"] = finishedAt.Format(time.RFC3339Nano)
	job["payload"] = MaskSecrets(payload)
	job["status"] = WorkflowSucceeded
	job["lockedBy"] = nil
	job["lockedAt"] = nil
	job["updatedAt"] = finishedAt.Format(time.RFC3339Nano)
	event := imagePublicationEvent(input)
	events := recordSlice(state, "deploymentEvents")
	events = append(events, record{
		"id":           stableID("devevt", event.DeploymentID, event.Type, event.Message, finishedAt.Format(time.RFC3339Nano)),
		"deploymentId": event.DeploymentID,
		"type":         event.Type,
		"message":      Redact(event.Message),
		"metadata":     MaskSecrets(event.Metadata),
		"timestamp":    finishedAt.Format(time.RFC3339Nano),
	})
	setRecordSlice(state, "deployments", deployments)
	setRecordSlice(state, "services", services)
	setRecordSlice(state, "workflowJobs", jobs)
	setRecordSlice(state, "deploymentEvents", events)
	return s.save(state)
}

func (s *FileStore) AppendBuildLog(ctx context.Context, input BuildLogInput) error {
	return s.appendBuildLog(ctx, nil, input)
}

func (s *FileStore) appendBuildLogForLease(ctx context.Context, lease WorkflowLease, input BuildLogInput) error {
	return s.appendBuildLog(ctx, &lease, input)
}

func (s *FileStore) appendBuildLog(ctx context.Context, lease *WorkflowLease, input BuildLogInput) error {
	if strings.TrimSpace(input.Line) == "" {
		return nil
	}
	return s.appendRecord(ctx, lease, "buildLogs", record{
		"id":           stableID("blog", input.DeploymentID, input.Step, input.Line, time.Now().UTC().Format(time.RFC3339Nano)),
		"deploymentId": input.DeploymentID,
		"step":         defaultString(input.Step, "build"),
		"line":         Redact(input.Line),
		"level":        defaultString(input.Level, "info"),
		"timestamp":    time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func (s *FileStore) AppendDeploymentEvent(ctx context.Context, input DeploymentEventInput) error {
	return s.appendDeploymentEvent(ctx, nil, input)
}

func (s *FileStore) appendDeploymentEventForLease(ctx context.Context, lease WorkflowLease, input DeploymentEventInput) error {
	return s.appendDeploymentEvent(ctx, &lease, input)
}

func (s *FileStore) appendDeploymentEvent(ctx context.Context, lease *WorkflowLease, input DeploymentEventInput) error {
	return s.appendRecord(ctx, lease, "deploymentEvents", record{
		"id":           stableID("devevt", input.DeploymentID, input.Type, input.Message, time.Now().UTC().Format(time.RFC3339Nano)),
		"deploymentId": input.DeploymentID,
		"type":         defaultString(input.Type, "deployment.event"),
		"message":      Redact(input.Message),
		"metadata":     MaskSecrets(input.Metadata),
		"timestamp":    time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func (s *FileStore) updateWorkflowJob(ctx context.Context, lease WorkflowLease, update func(job record, now time.Time)) error {
	return s.updateWorkflowJobLease(ctx, lease, func(job record) {
		update(job, time.Now().UTC())
	})
}

func (s *FileStore) updateWorkflowJobLease(ctx context.Context, lease WorkflowLease, update func(job record)) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return err
	}
	rows := recordSlice(state, "workflowJobs")
	idx := findRecordIndex(rows, lease.JobID)
	if idx < 0 {
		return notFound("workflow job", lease.JobID)
	}
	if !recordOwnsWorkflowLease(rows[idx], lease) {
		return ErrWorkflowLeaseLost
	}
	update(rows[idx])
	setRecordSlice(state, "workflowJobs", rows)
	return s.save(state)
}

func (s *FileStore) appendRecord(ctx context.Context, lease *WorkflowLease, key string, row record) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return err
	}
	if lease != nil {
		jobs := recordSlice(state, "workflowJobs")
		jobIndex := findRecordIndex(jobs, lease.JobID)
		if jobIndex < 0 {
			return notFound("workflow job", lease.JobID)
		}
		if !recordOwnsWorkflowLease(jobs[jobIndex], *lease) {
			return ErrWorkflowLeaseLost
		}
	}
	rows := recordSlice(state, key)
	rows = append(rows, row)
	setRecordSlice(state, key, rows)
	return s.save(state)
}

func (s *FileStore) loadReadOnly() (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load()
}

func (s *FileStore) load() (map[string]any, error) {
	if s.path == "" {
		return nil, errors.New("control-plane state file is required")
	}
	bytes, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]any{}, nil
		}
		return nil, err
	}
	if len(strings.TrimSpace(string(bytes))) == 0 {
		return map[string]any{}, nil
	}
	var state map[string]any
	if err := json.Unmarshal(bytes, &state); err != nil {
		return nil, fmt.Errorf("read control-plane state %s: %w", s.path, err)
	}
	return state, nil
}

func (s *FileStore) save(state map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	bytes, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	bytes = append(bytes, '\n')
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, bytes, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

type record map[string]any

func isBuilderWorkflowType(workflowType string) bool {
	switch workflowType {
	case "build-and-deploy", "preview-deploy", "build", "builder":
		return true
	default:
		return false
	}
}

func IsDeletionStatus(status string) bool {
	switch strings.ToUpper(strings.TrimSpace(status)) {
	case DeletionStatusRequested, DeletionStatusDeleting, DeletionStatusFailed:
		return true
	default:
		return false
	}
}

func deletingTargetError(serviceStatus, projectStatus string) error {
	if IsDeletionStatus(serviceStatus) {
		return fmt.Errorf("%w: service status is %s", ErrBuildTargetDeleting, strings.ToUpper(strings.TrimSpace(serviceStatus)))
	}
	if IsDeletionStatus(projectStatus) {
		return fmt.Errorf("%w: project status is %s", ErrBuildTargetDeleting, strings.ToUpper(strings.TrimSpace(projectStatus)))
	}
	return nil
}

func workflowTargetDeleting(state map[string]any, job record) bool {
	deploymentID := workflowDeploymentID(job)
	if deploymentID == "" {
		return false
	}
	deployment := findRecord(recordSlice(state, "deployments"), deploymentID)
	if deployment == nil {
		return false
	}
	payload := mapField(job, "payload")
	serviceID := coalesceString(stringField(deployment, "serviceId"), stringField(payload, "serviceId"))
	service := findRecord(recordSlice(state, "services"), serviceID)
	if service == nil {
		return false
	}
	projectID := coalesceString(stringField(deployment, "projectId"), stringField(service, "projectId"), stringField(payload, "projectId"))
	project := findRecord(recordSlice(state, "projects"), projectID)
	if project == nil {
		return false
	}
	return deletingTargetError(stringField(service, "status"), stringField(project, "status")) != nil
}

func reapExhaustedWorkflowJobs(state map[string]any, now time.Time, lease time.Duration, limit int) int {
	if limit <= 0 {
		return 0
	}
	jobs := recordSlice(state, "workflowJobs")
	deployments := recordSlice(state, "deployments")
	reaped := 0
	for _, job := range jobs {
		if reaped >= limit || !workflowExhaustedAndExpired(job, now, lease) {
			continue
		}
		payload := mapField(job, "payload")
		payload["lastError"] = exhaustedWorkflowFailureMessage
		payload["lastErrorSpec"] = ErrorSpecForFailure(errors.New(exhaustedWorkflowFailureMessage), ErrorCodeBuildFailed)
		payload["failedAt"] = now.Format(time.RFC3339Nano)
		job["payload"] = MaskSecrets(payload)
		job["status"] = WorkflowFailed
		job["lockedBy"] = nil
		job["lockedAt"] = nil
		job["updatedAt"] = now.Format(time.RFC3339Nano)

		if deployment := findRecord(deployments, workflowDeploymentID(job)); deployment != nil && workflowDeploymentCanFail(stringField(deployment, "status")) {
			deployment["status"] = ErrorCodeBuildFailed
			deployment["buildFinishedAt"] = now.Format(time.RFC3339Nano)
			deployment["errorCode"] = ErrorCodeBuildFailed
			deployment["errorMessage"] = exhaustedWorkflowFailureMessage
			deployment["updatedAt"] = now.Format(time.RFC3339Nano)
		}
		reaped++
	}
	if reaped > 0 {
		setRecordSlice(state, "workflowJobs", jobs)
		setRecordSlice(state, "deployments", deployments)
	}
	return reaped
}

func workflowExhaustedAndExpired(job record, now time.Time, lease time.Duration) bool {
	if !isBuilderWorkflowType(stringField(job, "type")) || !strings.EqualFold(stringField(job, "status"), WorkflowRunning) {
		return false
	}
	maxAttempts := intField(job, "maxAttempts")
	if maxAttempts <= 0 {
		maxAttempts = 3
	}
	lockedAt := parseTime(stringField(job, "lockedAt"), time.Time{})
	return intField(job, "attempts") >= maxAttempts && !lockedAt.IsZero() && !lockedAt.Add(lease).After(now)
}

func workflowDeploymentID(job record) string {
	payloadID := strings.TrimSpace(stringField(mapField(job, "payload"), "deploymentId"))
	targetID := ""
	if strings.EqualFold(strings.TrimSpace(stringField(job, "targetType")), "deployment") {
		targetID = strings.TrimSpace(stringField(job, "targetId"))
	}
	if payloadID != "" && targetID != "" && payloadID != targetID {
		return ""
	}
	return coalesceString(payloadID, targetID)
}

func workflowDeploymentCanFail(status string) bool {
	return strings.EqualFold(strings.TrimSpace(status), "queued") || strings.EqualFold(strings.TrimSpace(status), "BUILDING")
}

func workflowReady(job record, now time.Time, lease time.Duration) bool {
	status := strings.ToLower(stringField(job, "status"))
	lockedAt := parseTime(stringField(job, "lockedAt"), time.Time{})
	switch status {
	case WorkflowQueued:
		if runAfter := parseTime(stringField(job, "runAfter"), time.Time{}); !runAfter.IsZero() && runAfter.After(now) {
			return false
		}
		return lockedAt.IsZero() || !lockedAt.Add(lease).After(now)
	case WorkflowRunning:
		maxAttempts := intField(job, "maxAttempts")
		if maxAttempts <= 0 {
			maxAttempts = 3
		}
		return intField(job, "attempts") < maxAttempts && !lockedAt.IsZero() && !lockedAt.Add(lease).After(now)
	default:
		return false
	}
}

func recordOwnsWorkflowLease(job record, lease WorkflowLease) bool {
	return lease.JobID != "" && lease.WorkerID != "" && lease.Attempt > 0 &&
		strings.EqualFold(stringField(job, "status"), WorkflowRunning) &&
		stringField(job, "lockedBy") == lease.WorkerID && intField(job, "attempts") == lease.Attempt
}

func workflowJobFromRecord(row record) *WorkflowJob {
	if row == nil {
		return nil
	}
	return &WorkflowJob{
		ID:          stringField(row, "id"),
		Type:        stringField(row, "type"),
		Status:      stringField(row, "status"),
		TargetType:  stringField(row, "targetType"),
		TargetID:    stringField(row, "targetId"),
		Payload:     mapField(row, "payload"),
		Attempts:    intField(row, "attempts"),
		MaxAttempts: intField(row, "maxAttempts"),
		LockedBy:    stringField(row, "lockedBy"),
	}
}

func projectFromRecord(row record) *Project {
	return &Project{ID: stringField(row, "id"), OrganizationID: stringField(row, "organizationId"), Name: stringField(row, "name"), Slug: stringField(row, "slug"), Status: stringField(row, "status")}
}

func serviceFromRecord(row record) *Service {
	desiredSpec := mapField(row, "desiredSpec")
	desiredState := mapField(row, "desiredState")
	github := mapField(desiredState, "github")
	service := &Service{
		ID:                         stringField(row, "id"),
		ProjectID:                  stringField(row, "projectId"),
		Name:                       stringField(row, "name"),
		Slug:                       stringField(row, "slug"),
		Type:                       stringField(row, "type"),
		RuntimeType:                stringField(row, "runtimeType"),
		SourceType:                 coalesceString(stringField(row, "sourceType"), stringField(desiredState, "sourceType")),
		BuildMode:                  coalesceString(stringField(row, "buildMode"), stringField(desiredState, "buildMode")),
		RepoURL:                    coalesceString(stringField(row, "repoUrl"), stringField(desiredState, "repoUrl"), stringField(desiredState, "repositoryUrl")),
		GitHubIntegrationID:        coalesceString(stringField(row, "githubIntegrationId"), stringField(desiredState, "githubIntegrationId"), stringField(github, "integrationId")),
		GitHubInstallationID:       coalesceString(stringField(row, "githubInstallationId"), stringField(desiredState, "githubInstallationId"), stringField(github, "installationId")),
		GitHubRepositoryID:         coalesceString(stringField(row, "githubRepositoryId"), stringField(desiredState, "githubRepositoryId"), stringField(github, "repositoryId")),
		GitHubRepository:           coalesceString(stringField(row, "githubRepository"), stringField(desiredState, "githubRepository"), stringField(github, "repository")),
		GitHubRepositoryVisibility: coalesceString(stringField(row, "githubRepositoryVisibility"), stringField(desiredState, "githubRepositoryVisibility"), stringField(github, "visibility")),
		SourceAccess:               coalesceString(stringField(row, "sourceAccess"), stringField(desiredState, "sourceAccess")),
		Branch:                     coalesceString(stringField(row, "branch"), stringField(desiredState, "branch")),
		RootDirectory:              coalesceString(stringField(row, "rootDirectory"), stringField(desiredState, "rootDirectory")),
		BuildContext:               coalesceString(stringField(row, "buildContext"), stringField(desiredState, "buildContext")),
		DockerfilePath:             coalesceString(stringField(row, "dockerfilePath"), stringField(desiredState, "dockerfilePath")),
		InstallCommand:             coalesceString(stringField(row, "installCommand"), stringField(desiredState, "installCommand")),
		BuildCommand:               coalesceString(stringField(row, "buildCommand"), stringField(desiredState, "buildCommand"), stringField(desiredState, "customBuildCommand")),
		StartCommand:               coalesceString(stringField(row, "startCommand"), stringField(desiredState, "startCommand")),
		OutputDirectory:            coalesceString(stringField(row, "outputDirectory"), stringField(desiredState, "outputDirectory")),
		Image:                      coalesceString(stringField(row, "image"), stringField(desiredState, "image")),
		ImageURL:                   coalesceString(stringField(row, "imageUrl"), stringField(desiredState, "imageUrl")),
		Registry:                   coalesceString(stringField(row, "registry"), stringField(desiredState, "registry"), stringField(desiredSpec, "registry")),
		LocalPath:                  coalesceString(stringField(row, "localPath"), stringField(desiredState, "localPath"), stringField(desiredSpec, "localPath")),
		Port:                       intField(row, "port"),
		Status:                     stringField(row, "status"),
		DesiredSpec:                desiredSpec,
		DesiredState:               desiredState,
	}
	if service.Port == 0 {
		service.Port = intField(desiredState, "port")
	}
	return service
}

func deploymentFromRecord(row record) *Deployment {
	return &Deployment{
		ID:                  stringField(row, "id"),
		ServiceID:           stringField(row, "serviceId"),
		ProjectID:           stringField(row, "projectId"),
		Status:              stringField(row, "status"),
		DeploymentType:      stringField(row, "deploymentType"),
		TriggerType:         stringField(row, "triggerType"),
		Branch:              stringField(row, "branch"),
		CommitSHA:           stringField(row, "commitSha"),
		CommitHash:          stringField(row, "commitHash"),
		PullRequestNumber:   intField(row, "pullRequestNumber"),
		PreviewURL:          stringField(row, "previewUrl"),
		ImageURL:            stringField(row, "imageUrl"),
		ImageDigest:         stringField(row, "imageDigest"),
		SourceDeploymentID:  stringField(row, "sourceDeploymentId"),
		RetryOfDeploymentID: stringField(row, "retryOfDeploymentId"),
	}
}

func recordSlice(state map[string]any, key string) []record {
	value, ok := state[key]
	if !ok || value == nil {
		return []record{}
	}
	items, ok := value.([]any)
	if !ok {
		return []record{}
	}
	rows := make([]record, 0, len(items))
	for _, item := range items {
		if row, ok := item.(map[string]any); ok {
			rows = append(rows, row)
		}
	}
	return rows
}

func setRecordSlice(state map[string]any, key string, rows []record) {
	items := make([]any, len(rows))
	for i, row := range rows {
		items[i] = row
	}
	state[key] = items
}

func findRecord(rows []record, id string) record {
	idx := findRecordIndex(rows, id)
	if idx < 0 {
		return nil
	}
	return rows[idx]
}

func findRecordIndex(rows []record, id string) int {
	for i, row := range rows {
		if stringField(row, "id") == id {
			return i
		}
	}
	return -1
}

func stringField(row map[string]any, key string) string {
	if row == nil {
		return ""
	}
	value, ok := row[key]
	if !ok || value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return typed
	case fmt.Stringer:
		return typed.String()
	case float64:
		if typed == float64(int64(typed)) {
			return strconv.FormatInt(int64(typed), 10)
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		return fmt.Sprintf("%v", typed)
	}
}

func intField(row map[string]any, key string) int {
	if row == nil {
		return 0
	}
	value := row[key]
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case string:
		parsed, _ := strconv.Atoi(typed)
		return parsed
	default:
		return 0
	}
}

func mapField(row map[string]any, key string) map[string]any {
	if row == nil {
		return map[string]any{}
	}
	value, ok := row[key]
	if !ok || value == nil {
		return map[string]any{}
	}
	if typed, ok := value.(map[string]any); ok {
		return cloneMap(typed)
	}
	return map[string]any{}
}

func cloneMap(input map[string]any) map[string]any {
	output := make(map[string]any, len(input))
	for key, value := range input {
		if nested, ok := value.(map[string]any); ok {
			output[key] = cloneMap(nested)
			continue
		}
		if items, ok := value.([]any); ok {
			output[key] = cloneSlice(items)
			continue
		}
		output[key] = value
	}
	return output
}

func cloneSlice(input []any) []any {
	output := make([]any, len(input))
	for i, value := range input {
		if nested, ok := value.(map[string]any); ok {
			output[i] = cloneMap(nested)
			continue
		}
		if items, ok := value.([]any); ok {
			output[i] = cloneSlice(items)
			continue
		}
		output[i] = value
	}
	return output
}

func parseTime(value string, fallback time.Time) time.Time {
	if value == "" || value == "<nil>" {
		return fallback
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed
		}
	}
	return fallback
}

func retryDelay(attempts int) time.Duration {
	if attempts <= 0 {
		return time.Second
	}
	if attempts > 6 {
		attempts = 6
	}
	return time.Duration(1<<uint(attempts-1)) * time.Second
}

func notFound(kind, id string) error {
	return fmt.Errorf("%s not found: %s", kind, id)
}

func defaultString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func coalesceString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func stableID(parts ...string) string {
	hash := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return parts[0] + "_" + hex.EncodeToString(hash[:])[:16]
}

func failureMessage(err error) string {
	if err == nil {
		return "workflow failed"
	}
	return err.Error()
}

var (
	secretAssignmentPattern = regexp.MustCompile(`(?i)([A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|KEY|DATABASE_URL|MONGODB_URI|REDIS_URL)[A-Z0-9_]*=)([^\s]+)`)
	knownTokenPattern       = regexp.MustCompile(`(?i)(gh[opusr]_|github_pat_|glpat-|sk-|xox[baprs]-)[A-Za-z0-9_\-]+`)
	credentialedURLPattern  = regexp.MustCompile(`(?i)[a-z][a-z0-9+.-]*://[^\s/@]+(:[^\s/@]+)?@`)
)

func Redact(value string) string {
	redacted := secretAssignmentPattern.ReplaceAllString(value, `$1****`)
	redacted = knownTokenPattern.ReplaceAllString(redacted, `$1****`)
	redacted = credentialedURLPattern.ReplaceAllStringFunc(redacted, func(match string) string {
		scheme := strings.SplitN(match, "://", 2)[0]
		return scheme + "://****@"
	})
	return redacted
}

func MaskSecrets(input any) any {
	switch typed := input.(type) {
	case nil:
		return nil
	case string:
		return Redact(typed)
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, value := range typed {
			if IsSecretKey(key) {
				out[key] = MaskSecretValue(fmt.Sprintf("%v", value))
			} else {
				out[key] = MaskSecrets(value)
			}
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i, value := range typed {
			out[i] = MaskSecrets(value)
		}
		return out
	default:
		return typed
	}
}

func IsSecretKey(key string) bool {
	upper := strings.ToUpper(key)
	return strings.Contains(upper, "SECRET") || strings.Contains(upper, "PASSWORD") || strings.Contains(upper, "TOKEN") || strings.Contains(upper, "KEY") || strings.Contains(upper, "DATABASE_URL") || strings.Contains(upper, "MONGODB_URI") || strings.Contains(upper, "REDIS_URL")
}

func MaskSecretValue(value string) string {
	if value == "" {
		return ""
	}
	if len(value) <= 4 {
		return "****"
	}
	if len(value) <= 8 {
		return value[:2] + "****"
	}
	return value[:2] + "****" + value[len(value)-2:]
}
