package store

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
	DeploymentStatusImageReady        = "IMAGE_READY"
	DeploymentStatusDeploying         = "DEPLOYING"
	DeploymentStatusReady             = "READY"
	DeploymentStatusFailed            = "FAILED"
	DeploymentStatusRollbackRequested = "ROLLBACK_REQUESTED"
	DeploymentStatusCleanupRequested  = "PREVIEW_CLEANUP_REQUESTED"
	DeploymentStatusCleanedUp         = "CLEANED_UP"

	DeploymentActionApply    = "apply"
	DeploymentActionRollback = "rollback"
	DeploymentActionCleanup  = "cleanup"

	DeletionStatusDeleteRequested = "DELETE_REQUESTED"
	DeletionStatusDeleting        = "DELETING"
	DeletionStatusDeleted         = "DELETED"
)

var (
	ErrDeploymentLeaseLost     = errors.New("deployment reconcile lease ownership lost")
	ErrDeletionLeaseLost       = errors.New("deletion lease ownership lost")
	ErrParentDeletionRequested = errors.New("deployment parent is being deleted")
)

type DesiredStateStore interface {
	ListPendingServices() ([]ServiceDesiredState, error)
	MarkServiceReady(serviceID string, status string) error
}

type ReconcileStore interface {
	ClaimNextServiceDeletion(ctx context.Context, options ClaimOptions) (*Service, error)
	ClaimNextProjectDeletion(ctx context.Context, options ClaimOptions) (*Project, error)
	RenewServiceDeletionLease(ctx context.Context, lease DeletionLease, now time.Time) (DeletionLease, error)
	RenewProjectDeletionLease(ctx context.Context, lease DeletionLease, now time.Time) (DeletionLease, error)
	ReleaseServiceDeletion(ctx context.Context, lease DeletionLease) error
	ReleaseProjectDeletion(ctx context.Context, lease DeletionLease) error
	FinalizeServiceDeletion(ctx context.Context, lease DeletionLease) error
	FinalizeProjectDeletion(ctx context.Context, lease DeletionLease) error
	ParentsDeleting(ctx context.Context, projectID string, serviceID string) (bool, error)
	ClaimNextDeployment(ctx context.Context, options ClaimOptions) (*Deployment, error)
	RenewDeploymentLease(ctx context.Context, lease DeploymentLease, now time.Time) error
	GetProject(ctx context.Context, projectID string) (*Project, error)
	GetService(ctx context.Context, serviceID string) (*Service, error)
	TransitionDeployment(ctx context.Context, lease DeploymentLease, updates map[string]any) (*Deployment, error)
	AppendDeploymentEvent(ctx context.Context, input DeploymentEventInput) error
	AppendRuntimeLog(ctx context.Context, input RuntimeLogInput) error
}

type ClaimOptions struct {
	WorkerID string
	Lease    time.Duration
	Now      time.Time
}

type DeploymentLease struct {
	DeploymentID string
	WorkerID     string
	Attempt      int
	Action       string
}

type DeletionLease struct {
	ID        string
	ClaimedAt time.Time
}

type ServiceDesiredState struct {
	ID        string
	ProjectID string
	Image     string
	Port      int
}

type Project struct {
	ID                  string
	OrganizationID      string
	OrganizationSlug    string
	Name                string
	Slug                string
	Status              string
	DeletionRequestedAt time.Time
	UpdatedAt           time.Time
}

func (project *Project) DeletionLease() DeletionLease {
	if project == nil {
		return DeletionLease{}
	}
	return DeletionLease{ID: project.ID, ClaimedAt: project.UpdatedAt}
}

type Service struct {
	ID                  string
	ProjectID           string
	Name                string
	Slug                string
	Type                string
	ImageURL            string
	Port                int
	Replicas            int
	BaseDomain          string
	DesiredSpec         map[string]any
	DesiredState        map[string]any
	Status              string
	DeletionRequestedAt time.Time
	UpdatedAt           time.Time
}

func (service *Service) DeletionLease() DeletionLease {
	if service == nil {
		return DeletionLease{}
	}
	return DeletionLease{ID: service.ID, ClaimedAt: service.UpdatedAt}
}

type Deployment struct {
	DesiredSpecSnapshot json.RawMessage
	SnapshotVersion     int
	SourceDeploymentID  string
	RetryOfDeploymentID string
	ID                  string
	ServiceID           string
	ProjectID           string
	Status              string
	DeploymentType      string
	TriggerType         string
	Branch              string
	CommitSHA           string
	ImageURL            string
	ImageDigest         string
	PreviewURL          string
	PreviousImageURL    string
	PullRequestNumber   int
	ReconcileAction     string
	ReconcileLockedBy   string
	ReconcileLockedAt   time.Time
	ReconcileAttempts   int
}

func (deployment *Deployment) Lease() DeploymentLease {
	if deployment == nil {
		return DeploymentLease{}
	}
	return DeploymentLease{DeploymentID: deployment.ID, WorkerID: deployment.ReconcileLockedBy, Attempt: deployment.ReconcileAttempts, Action: deployment.ReconcileAction}
}

type DeploymentEventInput struct {
	DeploymentID string
	Type         string
	Message      string
	Metadata     map[string]any
}

type RuntimeLogInput struct {
	ServiceID     string
	DeploymentID  string
	PodName       string
	ContainerName string
	Line          string
	Level         string
}

type FileStore struct {
	path string
	mu   sync.Mutex
}

func NewFileStore(path string) *FileStore { return &FileStore{path: path} }

func (s *FileStore) ListPendingServices() ([]ServiceDesiredState, error) {
	state, err := s.loadReadOnly()
	if err != nil {
		return nil, err
	}
	services := []ServiceDesiredState{}
	for _, service := range recordSlice(state, "services") {
		if strings.EqualFold(stringField(service, "status"), "image-ready") || stringField(service, "imageUrl") != "" {
			services = append(services, ServiceDesiredState{ID: stringField(service, "id"), ProjectID: stringField(service, "projectId"), Image: stringField(service, "imageUrl"), Port: intField(service, "port")})
		}
	}
	return services, nil
}

func (s *FileStore) MarkServiceReady(serviceID string, status string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return err
	}
	rows := recordSlice(state, "services")
	idx := findRecordIndex(rows, serviceID)
	if idx < 0 {
		return notFound("service", serviceID)
	}
	rows[idx]["status"] = status
	rows[idx]["updatedAt"] = now()
	setRecordSlice(state, "services", rows)
	return s.save(state)
}

func (s *FileStore) ListDeploymentsForReconcile(ctx context.Context) ([]Deployment, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	state, err := s.loadReadOnly()
	if err != nil {
		return nil, err
	}
	rows := recordSlice(state, "deployments")
	out := []Deployment{}
	for _, row := range rows {
		status := strings.ToUpper(stringField(row, "status"))
		switch status {
		case DeploymentStatusImageReady, DeploymentStatusRollbackRequested, DeploymentStatusCleanupRequested, "CLEANUP_REQUESTED":
			out = append(out, *deploymentFromRecord(row))
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (s *FileStore) ClaimNextServiceDeletion(ctx context.Context, options ClaimOptions) (*Service, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return nil, err
	}
	rows := recordSlice(state, "services")
	sortDeletionRecords(rows)
	claimNow, lease := deletionClaimClock(options)
	for _, row := range rows {
		if !deletionRecordClaimable(row, claimNow, lease) {
			continue
		}
		row["status"] = DeletionStatusDeleting
		row["updatedAt"] = claimNow.Format(time.RFC3339Nano)
		setRecordSlice(state, "services", rows)
		if err := s.save(state); err != nil {
			return nil, err
		}
		return serviceFromRecord(row), nil
	}
	return nil, nil
}

func (s *FileStore) ClaimNextProjectDeletion(ctx context.Context, options ClaimOptions) (*Project, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return nil, err
	}
	rows := recordSlice(state, "projects")
	sortDeletionRecords(rows)
	claimNow, lease := deletionClaimClock(options)
	for _, row := range rows {
		if !deletionRecordClaimable(row, claimNow, lease) || projectHasChildren(state, stringField(row, "id")) {
			continue
		}
		row["status"] = DeletionStatusDeleting
		row["updatedAt"] = claimNow.Format(time.RFC3339Nano)
		setRecordSlice(state, "projects", rows)
		if err := s.save(state); err != nil {
			return nil, err
		}
		return projectFromRecord(row), nil
	}
	return nil, nil
}

func (s *FileStore) ReleaseServiceDeletion(ctx context.Context, lease DeletionLease) error {
	return s.updateDeletionRecord(ctx, "services", lease, func(row record) {
		row["status"] = DeletionStatusDeleteRequested
		row["updatedAt"] = now()
	})
}

func (s *FileStore) RenewServiceDeletionLease(ctx context.Context, lease DeletionLease, renewedAt time.Time) (DeletionLease, error) {
	return s.renewDeletionLease(ctx, "services", lease, renewedAt)
}

func (s *FileStore) RenewProjectDeletionLease(ctx context.Context, lease DeletionLease, renewedAt time.Time) (DeletionLease, error) {
	return s.renewDeletionLease(ctx, "projects", lease, renewedAt)
}

func (s *FileStore) ReleaseProjectDeletion(ctx context.Context, lease DeletionLease) error {
	return s.updateDeletionRecord(ctx, "projects", lease, func(row record) {
		row["status"] = DeletionStatusDeleteRequested
		row["updatedAt"] = now()
	})
}

func (s *FileStore) FinalizeServiceDeletion(ctx context.Context, lease DeletionLease) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return err
	}
	services := recordSlice(state, "services")
	idx := findRecordIndex(services, lease.ID)
	if idx < 0 || !recordOwnsDeletionLease(services[idx], lease) || serviceHasActiveDeployment(state, lease.ID) {
		return ErrDeletionLeaseLost
	}
	cascadeFileService(state, lease.ID)
	services = recordSlice(state, "services")
	idx = findRecordIndex(services, lease.ID)
	if idx < 0 {
		return ErrDeletionLeaseLost
	}
	services = append(services[:idx], services[idx+1:]...)
	setRecordSlice(state, "services", services)
	return s.save(state)
}

func (s *FileStore) FinalizeProjectDeletion(ctx context.Context, lease DeletionLease) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return err
	}
	projects := recordSlice(state, "projects")
	idx := findRecordIndex(projects, lease.ID)
	if idx < 0 || !recordOwnsDeletionLease(projects[idx], lease) || projectHasChildren(state, lease.ID) {
		return ErrDeletionLeaseLost
	}
	for _, key := range []string{"domains", "environmentVariables", "usageRecords"} {
		setRecordSlice(state, key, filterRecords(recordSlice(state, key), func(row record) bool {
			return stringField(row, "projectId") != lease.ID
		}))
	}
	projects = append(projects[:idx], projects[idx+1:]...)
	setRecordSlice(state, "projects", projects)
	return s.save(state)
}

func (s *FileStore) ParentsDeleting(ctx context.Context, projectID string, serviceID string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	state, err := s.loadReadOnly()
	if err != nil {
		return false, err
	}
	return parentsDeletingInState(state, projectID, serviceID), nil
}

func (s *FileStore) updateDeletionRecord(ctx context.Context, key string, lease DeletionLease, update func(record)) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return err
	}
	rows := recordSlice(state, key)
	idx := findRecordIndex(rows, lease.ID)
	if idx < 0 || !recordOwnsDeletionLease(rows[idx], lease) {
		return ErrDeletionLeaseLost
	}
	update(rows[idx])
	setRecordSlice(state, key, rows)
	return s.save(state)
}

func (s *FileStore) renewDeletionLease(ctx context.Context, key string, lease DeletionLease, renewedAt time.Time) (DeletionLease, error) {
	if err := ctx.Err(); err != nil {
		return lease, err
	}
	if renewedAt.IsZero() {
		renewedAt = time.Now().UTC()
	} else {
		renewedAt = renewedAt.UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return lease, err
	}
	rows := recordSlice(state, key)
	idx := findRecordIndex(rows, lease.ID)
	if idx < 0 || !recordOwnsDeletionLease(rows[idx], lease) {
		return lease, ErrDeletionLeaseLost
	}
	rows[idx]["updatedAt"] = renewedAt.Format(time.RFC3339Nano)
	setRecordSlice(state, key, rows)
	if err := s.save(state); err != nil {
		return lease, err
	}
	return DeletionLease{ID: lease.ID, ClaimedAt: renewedAt}, nil
}

func (s *FileStore) ClaimNextDeployment(ctx context.Context, options ClaimOptions) (*Deployment, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return nil, err
	}
	rows := recordSlice(state, "deployments")
	sort.SliceStable(rows, func(i, j int) bool { return stringField(rows[i], "id") < stringField(rows[j], "id") })
	claimNow := options.Now
	if claimNow.IsZero() {
		claimNow = time.Now().UTC()
	}
	lease := options.Lease
	if lease <= 0 {
		lease = 15 * time.Minute
	}
	workerID := strings.TrimSpace(options.WorkerID)
	if workerID == "" {
		workerID = "raibitserver-orchestrator"
	}
	for _, row := range rows {
		if parentsDeletingInState(state, stringField(row, "projectId"), stringField(row, "serviceId")) {
			continue
		}
		action, ready := deploymentActionForClaim(row, claimNow, lease)
		if !ready {
			continue
		}
		row["status"] = DeploymentStatusDeploying
		row["reconcileAction"] = action
		row["reconcileLockedBy"] = workerID
		row["reconcileLockedAt"] = claimNow.Format(time.RFC3339Nano)
		row["reconcileAttempts"] = intField(row, "reconcileAttempts") + 1
		row["updatedAt"] = claimNow.Format(time.RFC3339Nano)
		setRecordSlice(state, "deployments", rows)
		if err := s.save(state); err != nil {
			return nil, err
		}
		return deploymentFromRecord(row), nil
	}
	return nil, nil
}

func (s *FileStore) RenewDeploymentLease(ctx context.Context, lease DeploymentLease, renewedAt time.Time) error {
	if renewedAt.IsZero() {
		renewedAt = time.Now().UTC()
	}
	return s.updateDeploymentLease(ctx, lease, func(row record) {
		row["reconcileLockedAt"] = renewedAt.Format(time.RFC3339Nano)
		row["updatedAt"] = renewedAt.Format(time.RFC3339Nano)
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
	row := findRecord(recordSlice(state, "projects"), projectID)
	if row == nil {
		return nil, notFound("project", projectID)
	}
	project := projectFromRecord(row)
	organization := findRecord(recordSlice(state, "organizations"), project.OrganizationID)
	if organization != nil {
		project.OrganizationSlug = coalesceString(project.OrganizationSlug, stringField(organization, "slug"), stringField(organization, "name"))
	}
	project.OrganizationSlug = coalesceString(project.OrganizationSlug, project.OrganizationID)
	return project, nil
}

func (s *FileStore) GetService(ctx context.Context, serviceID string) (*Service, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	state, err := s.loadReadOnly()
	if err != nil {
		return nil, err
	}
	row := findRecord(recordSlice(state, "services"), serviceID)
	if row == nil {
		return nil, notFound("service", serviceID)
	}
	return serviceFromRecord(row), nil
}

func (s *FileStore) UpdateDeployment(ctx context.Context, deploymentID string, updates map[string]any) (*Deployment, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return nil, err
	}
	rows := recordSlice(state, "deployments")
	idx := findRecordIndex(rows, deploymentID)
	if idx < 0 {
		return nil, notFound("deployment", deploymentID)
	}
	for key, value := range updates {
		rows[idx][key] = MaskSecrets(value)
	}
	rows[idx]["updatedAt"] = now()
	setRecordSlice(state, "deployments", rows)
	if err := s.save(state); err != nil {
		return nil, err
	}
	return deploymentFromRecord(rows[idx]), nil
}

func (s *FileStore) TransitionDeployment(ctx context.Context, lease DeploymentLease, updates map[string]any) (*Deployment, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return nil, err
	}
	rows := recordSlice(state, "deployments")
	idx := findRecordIndex(rows, lease.DeploymentID)
	if idx < 0 {
		return nil, notFound("deployment", lease.DeploymentID)
	}
	if !recordOwnsDeploymentLease(rows[idx], lease) {
		return nil, ErrDeploymentLeaseLost
	}
	if strings.EqualFold(fmt.Sprint(updates["status"]), DeploymentStatusReady) && parentsDeletingInState(state, stringField(rows[idx], "projectId"), stringField(rows[idx], "serviceId")) {
		return nil, ErrParentDeletionRequested
	}
	for key, value := range updates {
		rows[idx][key] = MaskSecrets(value)
	}
	rows[idx]["reconcileAction"] = nil
	rows[idx]["reconcileLockedBy"] = nil
	rows[idx]["reconcileLockedAt"] = nil
	rows[idx]["updatedAt"] = now()
	setRecordSlice(state, "deployments", rows)
	if err := s.save(state); err != nil {
		return nil, err
	}
	return deploymentFromRecord(rows[idx]), nil
}

func (s *FileStore) updateDeploymentLease(ctx context.Context, lease DeploymentLease, update func(record)) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return err
	}
	rows := recordSlice(state, "deployments")
	idx := findRecordIndex(rows, lease.DeploymentID)
	if idx < 0 {
		return notFound("deployment", lease.DeploymentID)
	}
	if !recordOwnsDeploymentLease(rows[idx], lease) {
		return ErrDeploymentLeaseLost
	}
	update(rows[idx])
	setRecordSlice(state, "deployments", rows)
	return s.save(state)
}

func (s *FileStore) AppendDeploymentEvent(ctx context.Context, input DeploymentEventInput) error {
	return s.appendRecord(ctx, "deploymentEvents", record{"id": stableID("devevt", input.DeploymentID, input.Type, input.Message, now()), "deploymentId": input.DeploymentID, "type": defaultString(input.Type, "deployment.event"), "message": Redact(input.Message), "metadata": MaskSecrets(input.Metadata), "timestamp": now()})
}

func (s *FileStore) AppendRuntimeLog(ctx context.Context, input RuntimeLogInput) error {
	if strings.TrimSpace(input.Line) == "" {
		return nil
	}
	return s.appendRecord(ctx, "runtimeLogs", record{"id": stableID("rlog", input.ServiceID, input.DeploymentID, input.Line, now()), "serviceId": input.ServiceID, "deploymentId": nullable(input.DeploymentID), "podName": defaultString(input.PodName, "orchestrator"), "containerName": defaultString(input.ContainerName, "app"), "line": Redact(input.Line), "level": defaultString(input.Level, "info"), "timestamp": now()})
}

func (s *FileStore) appendRecord(ctx context.Context, key string, row record) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return err
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
	var bytes []byte
	err := retryFileContention(func() error {
		var readErr error
		bytes, readErr = os.ReadFile(s.path)
		return readErr
	})
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
	return retryFileContention(func() error { return os.Rename(tmp, s.path) })
}

func retryFileContention(operation func() error) error {
	const attempts = 100
	const delay = 5 * time.Millisecond

	var err error
	for attempt := 0; attempt < attempts; attempt++ {
		err = operation()
		if err == nil || !errors.Is(err, os.ErrPermission) {
			return err
		}
		time.Sleep(delay)
	}
	return err
}

type record map[string]any

func projectFromRecord(row record) *Project {
	return &Project{
		ID: stringField(row, "id"), OrganizationID: stringField(row, "organizationId"), OrganizationSlug: stringField(row, "organizationSlug"), Name: stringField(row, "name"), Slug: stringField(row, "slug"),
		Status: stringField(row, "status"), DeletionRequestedAt: parseTimestamp(stringField(row, "deletionRequestedAt")), UpdatedAt: parseTimestamp(stringField(row, "updatedAt")),
	}
}

func serviceFromRecord(row record) *Service {
	desiredSpec := mapField(row, "desiredSpec")
	desiredState := mapField(row, "desiredState")
	service := &Service{
		ID: stringField(row, "id"), ProjectID: stringField(row, "projectId"), Name: stringField(row, "name"), Slug: stringField(row, "slug"), Type: defaultString(stringField(row, "type"), "web"),
		ImageURL: coalesceString(stringField(row, "imageUrl"), stringField(row, "image"), stringField(desiredState, "imageUrl"), stringField(desiredState, "image")),
		Port:     intField(row, "port"), Replicas: intField(desiredState, "replicas"), BaseDomain: coalesceString(stringField(row, "baseDomain"), stringField(desiredState, "baseDomain")), DesiredSpec: desiredSpec, DesiredState: desiredState,
		Status: stringField(row, "status"), DeletionRequestedAt: parseTimestamp(stringField(row, "deletionRequestedAt")), UpdatedAt: parseTimestamp(stringField(row, "updatedAt")),
	}
	if service.Port == 0 {
		service.Port = intField(desiredState, "port")
	}
	if service.Port == 0 {
		service.Port = 3000
	}
	if service.Replicas == 0 {
		service.Replicas = 1
	}
	return service
}

func deploymentFromRecord(row record) *Deployment {
	return &Deployment{ID: stringField(row, "id"), ServiceID: stringField(row, "serviceId"), ProjectID: stringField(row, "projectId"), Status: stringField(row, "status"), DeploymentType: stringField(row, "deploymentType"), TriggerType: stringField(row, "triggerType"), Branch: stringField(row, "branch"), CommitSHA: coalesceString(stringField(row, "commitSha"), stringField(row, "commitHash")), ImageURL: stringField(row, "imageUrl"), ImageDigest: stringField(row, "imageDigest"), PreviewURL: stringField(row, "previewUrl"), PreviousImageURL: coalesceString(stringField(row, "previousImageUrl"), stringField(mapField(row, "desiredState"), "previousImageUrl")), PullRequestNumber: intField(row, "pullRequestNumber"), ReconcileAction: stringField(row, "reconcileAction"), ReconcileLockedBy: stringField(row, "reconcileLockedBy"), ReconcileLockedAt: parseTimestamp(stringField(row, "reconcileLockedAt")), ReconcileAttempts: intField(row, "reconcileAttempts"), DesiredSpecSnapshot: snapshotJSONFromRecord(row), SnapshotVersion: snapshotVersionFromRecord(row), SourceDeploymentID: stringField(row, "sourceDeploymentId"), RetryOfDeploymentID: stringField(row, "retryOfDeploymentId")}
}

func deletionClaimClock(options ClaimOptions) (time.Time, time.Duration) {
	claimNow := options.Now
	if claimNow.IsZero() {
		claimNow = time.Now().UTC()
	}
	lease := options.Lease
	if lease <= 0 {
		lease = 15 * time.Minute
	}
	return claimNow.UTC(), lease
}

func sortDeletionRecords(rows []record) {
	sort.SliceStable(rows, func(i, j int) bool {
		left := coalesceString(stringField(rows[i], "deletionRequestedAt"), stringField(rows[i], "createdAt"), stringField(rows[i], "id"))
		right := coalesceString(stringField(rows[j], "deletionRequestedAt"), stringField(rows[j], "createdAt"), stringField(rows[j], "id"))
		if left == right {
			return stringField(rows[i], "id") < stringField(rows[j], "id")
		}
		return left < right
	})
}

func deletionRecordClaimable(row record, claimNow time.Time, lease time.Duration) bool {
	status := strings.ToUpper(stringField(row, "status"))
	if status == DeletionStatusDeleteRequested {
		return true
	}
	if status != DeletionStatusDeleting {
		return false
	}
	updatedAt := parseTimestamp(stringField(row, "updatedAt"))
	return !updatedAt.IsZero() && !updatedAt.Add(lease).After(claimNow)
}

func recordOwnsDeletionLease(row record, lease DeletionLease) bool {
	return lease.ID != "" && !lease.ClaimedAt.IsZero() &&
		strings.EqualFold(stringField(row, "status"), DeletionStatusDeleting) &&
		parseTimestamp(stringField(row, "updatedAt")).Equal(lease.ClaimedAt)
}

func projectHasChildren(state map[string]any, projectID string) bool {
	for _, key := range []string{"services", "resources"} {
		for _, row := range recordSlice(state, key) {
			if stringField(row, "projectId") == projectID {
				return true
			}
		}
	}
	return false
}

func serviceHasActiveDeployment(state map[string]any, serviceID string) bool {
	for _, row := range recordSlice(state, "deployments") {
		if stringField(row, "serviceId") != serviceID {
			continue
		}
		if stringField(row, "reconcileLockedBy") != "" || !terminalDeploymentForDeletion(stringField(row, "status")) {
			return true
		}
	}
	return false
}

func terminalDeploymentForDeletion(status string) bool {
	switch strings.ToUpper(status) {
	case DeploymentStatusReady, DeploymentStatusFailed, "BUILD_FAILED", "CANCELLED", DeploymentStatusCleanedUp:
		return true
	default:
		return false
	}
}

func parentsDeletingInState(state map[string]any, projectID string, serviceID string) bool {
	service := findRecord(recordSlice(state, "services"), serviceID)
	if service == nil || deletionStatus(stringField(service, "status")) {
		return true
	}
	projectID = coalesceString(projectID, stringField(service, "projectId"))
	project := findRecord(recordSlice(state, "projects"), projectID)
	return project == nil || deletionStatus(stringField(project, "status"))
}

func deletionStatus(status string) bool {
	switch strings.ToUpper(status) {
	case DeletionStatusDeleteRequested, DeletionStatusDeleting, DeletionStatusDeleted:
		return true
	default:
		return false
	}
}

func cascadeFileService(state map[string]any, serviceID string) {
	deploymentIDs := map[string]struct{}{}
	for _, row := range recordSlice(state, "deployments") {
		if stringField(row, "serviceId") == serviceID {
			deploymentIDs[stringField(row, "id")] = struct{}{}
		}
	}
	setRecordSlice(state, "deployments", filterRecords(recordSlice(state, "deployments"), func(row record) bool {
		return stringField(row, "serviceId") != serviceID
	}))
	for _, key := range []string{"deploymentEvents", "buildLogs"} {
		setRecordSlice(state, key, filterRecords(recordSlice(state, key), func(row record) bool {
			_, deleted := deploymentIDs[stringField(row, "deploymentId")]
			return !deleted
		}))
	}
	for _, key := range []string{"runtimeLogs", "domains", "environmentVariables", "resourceAttachments", "usageRecords"} {
		setRecordSlice(state, key, filterRecords(recordSlice(state, key), func(row record) bool {
			return stringField(row, "serviceId") != serviceID
		}))
	}
}

func filterRecords(rows []record, keep func(record) bool) []record {
	filtered := make([]record, 0, len(rows))
	for _, row := range rows {
		if keep(row) {
			filtered = append(filtered, row)
		}
	}
	return filtered
}

func deploymentActionForClaim(row record, claimNow time.Time, lease time.Duration) (string, bool) {
	status := strings.ToUpper(stringField(row, "status"))
	switch status {
	case DeploymentStatusImageReady:
		return DeploymentActionApply, true
	case DeploymentStatusRollbackRequested:
		return DeploymentActionRollback, true
	case DeploymentStatusCleanupRequested, "CLEANUP_REQUESTED":
		return DeploymentActionCleanup, true
	case DeploymentStatusDeploying:
		action := stringField(row, "reconcileAction")
		if !validDeploymentAction(action) {
			return "", false
		}
		lockedAt := parseTimestamp(stringField(row, "reconcileLockedAt"))
		return action, !lockedAt.IsZero() && !lockedAt.Add(lease).After(claimNow)
	default:
		return "", false
	}
}

func validDeploymentAction(action string) bool {
	return action == DeploymentActionApply || action == DeploymentActionRollback || action == DeploymentActionCleanup
}

func recordOwnsDeploymentLease(row record, lease DeploymentLease) bool {
	return strings.EqualFold(stringField(row, "status"), DeploymentStatusDeploying) &&
		stringField(row, "reconcileLockedBy") == lease.WorkerID &&
		intField(row, "reconcileAttempts") == lease.Attempt &&
		stringField(row, "reconcileAction") == lease.Action &&
		lease.DeploymentID != "" && lease.WorkerID != "" && lease.Attempt > 0 && validDeploymentAction(lease.Action)
}

func parseTimestamp(value string) time.Time {
	parsed, _ := time.Parse(time.RFC3339Nano, value)
	return parsed
}

func recordSlice(state map[string]any, key string) []record {
	items, ok := state[key].([]any)
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
	if row == nil || row[key] == nil {
		return ""
	}
	switch typed := row[key].(type) {
	case string:
		return typed
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
	if row == nil || row[key] == nil {
		return 0
	}
	switch typed := row[key].(type) {
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
	if row == nil || row[key] == nil {
		return map[string]any{}
	}
	if typed, ok := row[key].(map[string]any); ok {
		return cloneMap(typed)
	}
	return map[string]any{}
}

func cloneMap(input map[string]any) map[string]any {
	out := make(map[string]any, len(input))
	for key, value := range input {
		if nested, ok := value.(map[string]any); ok {
			out[key] = cloneMap(nested)
		} else {
			out[key] = value
		}
	}
	return out
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
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

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func stableID(parts ...string) string {
	hash := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return parts[0] + "_" + hex.EncodeToString(hash[:])[:16]
}

func notFound(kind, id string) error { return fmt.Errorf("%s not found: %s", kind, id) }

var (
	secretAssignmentPattern = regexp.MustCompile(`(?i)([A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|KEY|DATABASE_URL|MONGODB_URI|REDIS_URL)[A-Z0-9_]*=)([^\s]+)`)
	knownTokenPattern       = regexp.MustCompile(`(?i)(ghp_|github_pat_|glpat-|sk-[A-Za-z0-9_-]*|xox[baprs]-)[A-Za-z0-9_\-]+`)
)

func Redact(value string) string {
	redacted := secretAssignmentPattern.ReplaceAllString(value, `$1****`)
	return knownTokenPattern.ReplaceAllString(redacted, `$1****`)
}

func MaskSecrets(input any) any {
	switch typed := input.(type) {
	case string:
		return Redact(typed)
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, value := range typed {
			if isSecretKey(key) {
				out[key] = "****"
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

func isSecretKey(key string) bool {
	upper := strings.ToUpper(key)
	return strings.Contains(upper, "SECRET") || strings.Contains(upper, "PASSWORD") || strings.Contains(upper, "TOKEN") || strings.Contains(upper, "KEY") || strings.Contains(upper, "DATABASE_URL") || strings.Contains(upper, "MONGODB_URI") || strings.Contains(upper, "REDIS_URL")
}
