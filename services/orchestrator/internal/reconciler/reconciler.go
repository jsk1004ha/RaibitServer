package reconciler

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/raibitserver/orchestrator/internal/command"
	"github.com/raibitserver/orchestrator/internal/kube"
	"github.com/raibitserver/orchestrator/internal/store"
)

type Config struct {
	DryRun                  bool
	Kubeconfig              string
	KubeContext             string
	OutputDir               string
	BaseDomain              string
	IngressGatewayNamespace string
	IngressClassName        string
	IngressCustomHTTPErrors string
	IngressErrorMiddleware  string
	Timeout                 time.Duration
	WorkerID                string
	ClaimLease              time.Duration
}

type ServiceReconciler struct {
	config Config
	store  store.ReconcileStore
	runner command.Runner
}

type ReconcileResult struct {
	Processed    int      `json:"processed"`
	ProjectID    string   `json:"projectId,omitempty"`
	ServiceID    string   `json:"serviceId,omitempty"`
	DeploymentID string   `json:"deploymentId,omitempty"`
	Status       string   `json:"status,omitempty"`
	ManifestFile string   `json:"manifestFile,omitempty"`
	Commands     []string `json:"commands,omitempty"`
	DryRun       bool     `json:"dryRun"`
	Reason       string   `json:"reason,omitempty"`
}

type readinessContract struct {
	args         []string
	step         string
	readyEvent   string
	readyMessage string
	failedEvent  string
}

func NewServiceReconciler(config Config) *ServiceReconciler {
	return NewServiceReconcilerWithStore(config, nil, command.OSRunner{})
}

func NewServiceReconcilerWithStore(config Config, state store.ReconcileStore, runner command.Runner) *ServiceReconciler {
	if config.OutputDir == "" {
		config.OutputDir = filepath.Join(os.TempDir(), "raibitserver-orchestrator")
	}
	if config.BaseDomain == "" {
		config.BaseDomain = "raibitserver.local"
	}
	if config.IngressGatewayNamespace == "" {
		config.IngressGatewayNamespace = "ingress-nginx"
	}
	if config.IngressClassName == "" {
		config.IngressClassName = "nginx"
	}
	if config.IngressCustomHTTPErrors == "" {
		config.IngressCustomHTTPErrors = "500,502,503,504"
	}
	if config.Timeout <= 0 {
		config.Timeout = 10 * time.Minute
	}
	if config.WorkerID == "" {
		config.WorkerID = "raibitserver-orchestrator"
	}
	if config.ClaimLease <= 0 {
		config.ClaimLease = 15 * time.Minute
	}
	if runner == nil {
		runner = command.OSRunner{}
	}
	return &ServiceReconciler{config: config, store: state, runner: runner}
}

func (r *ServiceReconciler) RunOnce(ctx context.Context) error {
	_, err := r.RunOnceResult(ctx)
	return err
}

func (r *ServiceReconciler) RunOnceResult(ctx context.Context) (*ReconcileResult, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	if r.store == nil {
		fmt.Printf("raibitserver orchestrator dryRun=%t action=reconcile-desired-state reason=no-control-plane-store\n", r.config.DryRun)
		return &ReconcileResult{Processed: 0, DryRun: r.config.DryRun, Reason: "no-control-plane-store"}, nil
	}
	claimOptions := store.ClaimOptions{WorkerID: r.config.WorkerID, Lease: r.config.ClaimLease}
	service, err := r.store.ClaimNextServiceDeletion(ctx, claimOptions)
	if err != nil {
		return nil, err
	}
	if service != nil {
		return r.reconcileServiceDeletion(ctx, service)
	}
	project, err := r.store.ClaimNextProjectDeletion(ctx, claimOptions)
	if err != nil {
		return nil, err
	}
	if project != nil {
		return r.reconcileProjectDeletion(ctx, project)
	}
	deployment, err := r.store.ClaimNextDeployment(ctx, claimOptions)
	if err != nil {
		return nil, err
	}
	if deployment == nil {
		return &ReconcileResult{Processed: 0, DryRun: r.config.DryRun, Reason: "no_reconcile_work"}, nil
	}
	result, err := r.reconcileWithHeartbeat(ctx, *deployment)
	if err != nil {
		return result, err
	}
	return result, nil
}

const serviceDeletionResourceKinds = "deployments,cronjobs,jobs,services,ingresses,networkpolicies"

const productionReconcileResourceKinds = "deployments,cronjobs,jobs,services,ingresses,networkpolicies"

var kubernetesLabelValuePattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$`)

func (r *ServiceReconciler) reconcileServiceDeletion(ctx context.Context, service *store.Service) (*ReconcileResult, error) {
	project, err := r.store.GetProject(ctx, service.ProjectID)
	if err != nil {
		return nil, err
	}
	var commands []string
	lease, err := r.reconcileDeletionWithHeartbeat(ctx, service.DeletionLease(), r.store.RenewServiceDeletionLease, func(processCtx context.Context, fence func(context.Context) error) error {
		var cleanupErr error
		commands, cleanupErr = r.cleanupServiceKubernetes(processCtx, project, service, fence)
		return cleanupErr
	})
	result := &ReconcileResult{Processed: 1, ProjectID: project.ID, ServiceID: service.ID, Commands: commands, DryRun: r.config.DryRun, Status: store.DeletionStatusDeleting}
	if err != nil {
		result.Reason = "service_cleanup_failed"
		return result, err
	}
	if r.config.DryRun {
		if err := r.store.ReleaseServiceDeletion(ctx, lease); err != nil {
			return result, err
		}
		result.Status = store.DeletionStatusDeleteRequested
		result.Reason = "service_deletion_dry_run"
		return result, nil
	}
	if err := r.store.FinalizeServiceDeletion(ctx, lease); err != nil {
		result.Reason = "service_finalization_deferred"
		return result, err
	}
	result.Status = store.DeletionStatusDeleted
	result.Reason = "service_deleted"
	return result, nil
}

func (r *ServiceReconciler) reconcileProjectDeletion(ctx context.Context, project *store.Project) (*ReconcileResult, error) {
	namespace := deletionNamespace(project, nil)
	var commands []string
	lease, err := r.reconcileDeletionWithHeartbeat(ctx, project.DeletionLease(), r.store.RenewProjectDeletionLease, func(processCtx context.Context, fence func(context.Context) error) error {
		var cleanupErr error
		commands, cleanupErr = r.cleanupProjectKubernetes(processCtx, project, namespace, fence)
		return cleanupErr
	})
	result := &ReconcileResult{
		Processed: 1, ProjectID: project.ID, Commands: commands, DryRun: r.config.DryRun,
		Status: store.DeletionStatusDeleting,
	}
	if err != nil {
		result.Reason = "project_cleanup_failed"
		return result, err
	}
	if r.config.DryRun {
		if err := r.store.ReleaseProjectDeletion(ctx, lease); err != nil {
			return result, err
		}
		result.Status = store.DeletionStatusDeleteRequested
		result.Reason = "project_deletion_dry_run"
		return result, nil
	}
	if err := r.store.FinalizeProjectDeletion(ctx, lease); err != nil {
		result.Reason = "project_finalization_deferred"
		return result, err
	}
	result.Status = store.DeletionStatusDeleted
	result.Reason = "project_deleted"
	return result, nil
}

func (r *ServiceReconciler) cleanupServiceKubernetes(ctx context.Context, project *store.Project, service *store.Service, beforeDelete func(context.Context) error) ([]string, error) {
	namespace := deletionNamespace(project, service)
	if !kubernetesLabelValuePattern.MatchString(project.ID) || !kubernetesLabelValuePattern.MatchString(service.ID) {
		return nil, errors.New("service deletion identifiers must be valid Kubernetes label values")
	}
	if beforeDelete != nil {
		if err := beforeDelete(ctx); err != nil {
			return nil, err
		}
	}
	selector := "raibitserver.io/project-id=" + project.ID + ",raibitserver.io/service-id=" + service.ID
	result, err := r.runKubectl(ctx, []string{
		"delete", serviceDeletionResourceKinds, "--namespace", namespace, "--selector", selector,
		"--ignore-not-found=true", "--wait=true",
	})
	commands := []string{result.Command}
	if err != nil {
		return commands, err
	}
	return commands, nil
}

type namespaceMetadata struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Metadata   struct {
		Name   string            `json:"name"`
		UID    string            `json:"uid"`
		Labels map[string]string `json:"labels"`
	} `json:"metadata"`
}

func (r *ServiceReconciler) cleanupProjectKubernetes(ctx context.Context, project *store.Project, namespace string, beforeDelete func(context.Context) error) ([]string, error) {
	if err := beforeDelete(ctx); err != nil {
		return nil, err
	}
	if r.config.DryRun {
		result, err := r.runKubectl(ctx, []string{"delete", "namespace/" + namespace, "--ignore-not-found=true", "--wait=true"})
		return []string{result.Command}, err
	}

	metadataResult, err := r.runKubectl(ctx, []string{"get", "namespace/" + namespace, "--ignore-not-found=true", "--output=json"})
	commands := []string{metadataResult.Command}
	if err != nil {
		return commands, err
	}
	if strings.TrimSpace(metadataResult.Stdout) == "" {
		return commands, nil
	}
	metadata, err := ownedProjectNamespace(metadataResult.Stdout, namespace, project.ID)
	if err != nil {
		return commands, err
	}
	deleteOptionsFile, err := r.writeProjectDeleteOptions(project.ID, metadata.Metadata.UID)
	if err != nil {
		return commands, err
	}
	if err := beforeDelete(ctx); err != nil {
		return commands, err
	}
	deleteResult, err := r.runKubectl(ctx, []string{"delete", "--raw", "/api/v1/namespaces/" + url.PathEscape(namespace), "-f", deleteOptionsFile})
	commands = append(commands, deleteResult.Command)
	if err != nil {
		return commands, err
	}
	waitResult, err := r.runKubectl(ctx, []string{"wait", "--for=delete", "namespace/" + namespace, "--timeout", timeoutString(r.config.Timeout)})
	commands = append(commands, waitResult.Command)
	return commands, err
}

func ownedProjectNamespace(raw, expectedName, expectedProjectID string) (namespaceMetadata, error) {
	var metadata namespaceMetadata
	if err := json.Unmarshal([]byte(raw), &metadata); err != nil {
		return namespaceMetadata{}, fmt.Errorf("decode project namespace metadata: %w", err)
	}
	labels := metadata.Metadata.Labels
	if metadata.APIVersion != "v1" || metadata.Kind != "Namespace" || metadata.Metadata.Name != expectedName || metadata.Metadata.UID == "" ||
		labels["app.kubernetes.io/managed-by"] != "raibitserver" || labels["raibitserver.io/managed"] != "true" ||
		labels["raibitserver.io/namespace-kind"] != "application" || labels["raibitserver.io/project-id"] != expectedProjectID {
		return namespaceMetadata{}, fmt.Errorf("namespace ownership mismatch for project %s", expectedProjectID)
	}
	return metadata, nil
}

func (r *ServiceReconciler) writeProjectDeleteOptions(projectID, uid string) (string, error) {
	if err := os.MkdirAll(r.config.OutputDir, 0o755); err != nil {
		return "", err
	}
	identity := sha256.Sum256([]byte(projectID))
	file := filepath.Join(r.config.OutputDir, fmt.Sprintf("project-%x-delete-options.json", identity[:8]))
	payload, err := json.MarshalIndent(map[string]any{
		"apiVersion": "v1",
		"kind":       "DeleteOptions",
		"preconditions": map[string]any{
			"uid": uid,
		},
		"propagationPolicy": "Foreground",
	}, "", "  ")
	if err != nil {
		return "", err
	}
	payload = append(payload, '\n')
	return file, os.WriteFile(file, payload, 0o600)
}

func deletionNamespace(project *store.Project, service *store.Service) string {
	if service == nil {
		service = &store.Service{ID: "project-deletion", ProjectID: project.ID, Name: "project-deletion", Slug: "project-deletion", Type: "worker"}
	}
	return kube.SpecFromState(project, service, &store.Deployment{ID: "deletion-namespace"}, "raibitserver.local").Namespace
}

func (r *ServiceReconciler) abortIfParentDeleting(ctx context.Context, project *store.Project, service *store.Service, deployment *store.Deployment, manifestFile string, priorCommands []string) (*ReconcileResult, error) {
	deleting, err := r.store.ParentsDeleting(ctx, project.ID, service.ID)
	if err != nil {
		return nil, err
	}
	if !deleting {
		return nil, nil
	}
	failure := store.ErrParentDeletionRequested
	cleanupCommands, cleanupErr := r.cleanupServiceKubernetes(ctx, project, service, nil)
	commands := append(append([]string{}, priorCommands...), cleanupCommands...)
	markErr := r.markFailed(ctx, deployment, failure)
	result := &ReconcileResult{
		Processed: 1, ProjectID: project.ID, ServiceID: service.ID, DeploymentID: deployment.ID,
		ManifestFile: manifestFile, Commands: commands, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed,
		Reason: "parent_deletion_requested",
	}
	if cleanupErr != nil {
		return result, cleanupErr
	}
	if markErr != nil && !errors.Is(markErr, store.ErrDeploymentLeaseLost) {
		return result, markErr
	}
	return result, failure
}

func (r *ServiceReconciler) reconcileWithHeartbeat(ctx context.Context, deployment store.Deployment) (*ReconcileResult, error) {
	processCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	heartbeatResult := make(chan error, 1)
	go func() {
		heartbeatResult <- r.renewLeaseUntilDone(processCtx, deployment.Lease(), done, cancel)
	}()

	result, reconcileErr := r.reconcileDeployment(processCtx, deployment)
	close(done)
	heartbeatErr := <-heartbeatResult
	cancel()
	if heartbeatErr != nil {
		// A successful fenced terminal transition clears the lease. A heartbeat
		// racing just after that transition may observe the intentional release;
		// the successful transition is authoritative in that narrow case.
		if reconcileErr == nil && result != nil && isTerminalReconcileStatus(result.Status) {
			return result, nil
		}
		return result, heartbeatErr
	}
	return result, reconcileErr
}

func isTerminalReconcileStatus(status string) bool {
	return status == store.DeploymentStatusReady || status == store.DeploymentStatusFailed || status == store.DeploymentStatusCleanedUp
}

func (r *ServiceReconciler) renewLeaseUntilDone(ctx context.Context, lease store.DeploymentLease, done <-chan struct{}, cancel context.CancelFunc) error {
	interval := r.config.ClaimLease / 3
	if interval < 10*time.Millisecond {
		interval = 10 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return nil
		case <-ctx.Done():
			return nil
		case renewedAt := <-ticker.C:
			if err := r.store.RenewDeploymentLease(ctx, lease, renewedAt.UTC()); err != nil {
				cancel()
				return err
			}
		}
	}
}

type deletionLeaseRenewal func(context.Context, store.DeletionLease, time.Time) (store.DeletionLease, error)

type deletionLeaseGuard struct {
	mu    sync.Mutex
	lease store.DeletionLease
	renew deletionLeaseRenewal
}

func (g *deletionLeaseGuard) renewAt(ctx context.Context, renewedAt time.Time) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	renewedLease, err := g.renew(ctx, g.lease, renewedAt.UTC())
	if err != nil {
		return err
	}
	g.lease = renewedLease
	return nil
}

func (g *deletionLeaseGuard) fence(ctx context.Context) error {
	return g.renewAt(ctx, time.Now().UTC())
}

func (g *deletionLeaseGuard) currentLease() store.DeletionLease {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.lease
}

func (r *ServiceReconciler) reconcileDeletionWithHeartbeat(ctx context.Context, lease store.DeletionLease, renew deletionLeaseRenewal, reconcile func(context.Context, func(context.Context) error) error) (store.DeletionLease, error) {
	guard := &deletionLeaseGuard{lease: lease, renew: renew}
	if err := guard.fence(ctx); err != nil {
		return lease, err
	}
	processCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	heartbeatResult := make(chan error, 1)
	go func() {
		heartbeatResult <- r.renewDeletionLeaseUntilDone(processCtx, guard, done, cancel)
	}()

	reconcileErr := reconcile(processCtx, guard.fence)
	close(done)
	heartbeatErr := <-heartbeatResult
	cancel()
	currentLease := guard.currentLease()
	if heartbeatErr != nil {
		return currentLease, heartbeatErr
	}
	return currentLease, reconcileErr
}

func (r *ServiceReconciler) renewDeletionLeaseUntilDone(ctx context.Context, guard *deletionLeaseGuard, done <-chan struct{}, cancel context.CancelFunc) error {
	interval := r.config.ClaimLease / 3
	if interval < 10*time.Millisecond {
		interval = 10 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return nil
		case <-ctx.Done():
			return nil
		case renewedAt := <-ticker.C:
			if err := guard.renewAt(ctx, renewedAt.UTC()); err != nil {
				cancel()
				return err
			}
		}
	}
}

func (r *ServiceReconciler) reconcileDeployment(ctx context.Context, deployment store.Deployment) (*ReconcileResult, error) {
	service, err := r.store.GetService(ctx, deployment.ServiceID)
	if err != nil {
		return nil, err
	}
	project, err := r.store.GetProject(ctx, firstNonEmpty(deployment.ProjectID, service.ProjectID))
	if err != nil {
		return nil, err
	}
	if result, err := r.abortIfParentDeleting(ctx, project, service, &deployment, "", nil); result != nil || err != nil {
		return result, err
	}
	action := deployment.ReconcileAction
	if action == store.DeploymentActionCleanup {
		return r.cleanupPreview(ctx, project, service, &deployment)
	}
	if action == store.DeploymentActionRollback {
		if deployment.PreviousImageURL == "" {
			failure := errors.New("rollback requested but previousImageUrl is missing")
			return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, r.persistFailure(ctx, &deployment, failure)
		}
		previousImage, err := kube.ResolveImageReference(deployment.PreviousImageURL, "", false)
		if err != nil {
			failure := fmt.Errorf("rollback previousImageUrl must be digest-pinned: %w", err)
			return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, r.persistFailure(ctx, &deployment, failure)
		}
		deployment.ImageURL = previousImage
		deployment.ImageDigest = ""
	}
	if action != store.DeploymentActionApply && action != store.DeploymentActionRollback {
		failure := fmt.Errorf("unsupported persisted deployment action %q", action)
		return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, r.persistFailure(ctx, &deployment, failure)
	}
	return r.applyAndWatch(ctx, project, service, &deployment, action == store.DeploymentActionRollback)
}

func (r *ServiceReconciler) applyAndWatch(ctx context.Context, project *store.Project, service *store.Service, deployment *store.Deployment, rollback bool) (*ReconcileResult, error) {
	if deployment.ImageURL == "" {
		failure := errors.New("image-ready deployment is missing imageUrl")
		return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, r.persistFailure(ctx, deployment, failure)
	}
	image, err := kube.ResolveImageReference(firstNonEmpty(deployment.ImageURL, service.ImageURL), deployment.ImageDigest, r.config.DryRun)
	if err != nil {
		return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, r.persistFailure(ctx, deployment, err)
	}
	spec := kube.SpecFromState(project, service, deployment, r.config.BaseDomain)
	spec.Image = image
	plan := r.newDeploymentPlan(spec)
	if !plan.Safe {
		failure := errors.New(plan.Error)
		return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, r.persistFailure(ctx, deployment, failure, "workload.failed")
	}
	pruneSelector, err := productionPruneSelector(plan)
	if err != nil {
		return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, r.persistFailure(ctx, deployment, err, "workload.failed")
	}
	manifestFile, err := r.writeManifest(deployment.ID, plan.Manifests, "apply")
	if err != nil {
		return nil, err
	}
	_ = r.store.AppendDeploymentEvent(ctx, store.DeploymentEventInput{DeploymentID: deployment.ID, Type: "orchestrator.apply.started", Message: "applying Kubernetes desired state", Metadata: map[string]any{"manifestFile": manifestFile, "rollback": rollback, "dryRun": r.config.DryRun, "workloadKind": plan.Kind, "workloadName": plan.WorkloadName}})
	applyResult, err := r.runKubectl(ctx, []string{"apply", "--server-side", "-f", manifestFile})
	commands := []string{applyResult.Command}
	_ = r.appendCommandRuntimeLogs(ctx, service.ID, deployment.ID, "kubectl-apply", applyResult)
	if err != nil {
		return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, ManifestFile: manifestFile, Commands: commands, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, r.persistFailure(ctx, deployment, err)
	}
	if pruneSelector != "" {
		pruneResult, pruneErr := r.runKubectl(ctx, []string{
			"delete", productionReconcileResourceKinds,
			"--namespace", plan.Service.Namespace,
			"--selector", pruneSelector,
			"--ignore-not-found=true", "--wait=true",
		})
		commands = append(commands, pruneResult.Command)
		_ = r.appendCommandRuntimeLogs(ctx, service.ID, deployment.ID, "kubectl-prune", pruneResult)
		if pruneErr != nil {
			return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, ManifestFile: manifestFile, Commands: commands, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, r.persistFailure(ctx, deployment, pruneErr, "workload.failed")
		}
	}
	readiness, err := readinessFor(plan, r.config.Timeout)
	if err != nil {
		return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, ManifestFile: manifestFile, Commands: commands, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, r.persistFailure(ctx, deployment, err, "workload.failed")
	}
	readinessResult, err := r.runKubectl(ctx, readiness.args)
	commands = append(commands, readinessResult.Command)
	_ = r.appendCommandRuntimeLogs(ctx, service.ID, deployment.ID, readiness.step, readinessResult)
	if err != nil {
		_ = r.collectDiagnostics(ctx, service, deployment, plan)
		return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, ManifestFile: manifestFile, Commands: commands, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, r.persistFailure(ctx, deployment, err, readiness.failedEvent)
	}
	_ = r.collectDiagnostics(ctx, service, deployment, plan)
	if result, err := r.abortIfParentDeleting(ctx, project, service, deployment, manifestFile, commands); result != nil || err != nil {
		return result, err
	}
	_, err = r.store.TransitionDeployment(ctx, deployment.Lease(), map[string]any{"status": store.DeploymentStatusReady, "deployedAt": time.Now().UTC().Format(time.RFC3339Nano), "finishedAt": time.Now().UTC().Format(time.RFC3339Nano), "errorCode": nil, "errorMessage": nil})
	if err != nil {
		if result, parentErr := r.abortIfParentDeleting(ctx, project, service, deployment, manifestFile, commands); result != nil || parentErr != nil {
			return result, parentErr
		}
		return nil, err
	}
	_ = r.store.AppendDeploymentEvent(ctx, store.DeploymentEventInput{DeploymentID: deployment.ID, Type: readiness.readyEvent, Message: readiness.readyMessage, Metadata: map[string]any{"namespace": plan.Service.Namespace, "service": plan.Service.Name, "host": plan.Service.Host, "rollback": rollback, "workloadKind": plan.Kind, "workloadName": plan.WorkloadName}})
	return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, ManifestFile: manifestFile, Commands: commands, DryRun: r.config.DryRun, Status: store.DeploymentStatusReady}, nil
}

func productionPruneSelector(plan kube.DeploymentPlan) (string, error) {
	if plan.Service.Preview {
		return "", nil
	}
	if !kubernetesLabelValuePattern.MatchString(plan.Service.ServiceID) {
		return "", errors.New("service ID is not a safe Kubernetes ownership label")
	}
	if !kubernetesLabelValuePattern.MatchString(plan.Service.DeploymentID) {
		return "", errors.New("deployment ID is not a safe Kubernetes ownership label")
	}
	return strings.Join([]string{
		"raibitserver.io/service-id=" + plan.Service.ServiceID,
		"!raibitserver.io/preview",
		"raibitserver.io/deployment-id!=" + plan.Service.DeploymentID,
	}, ","), nil
}

func (r *ServiceReconciler) cleanupPreview(ctx context.Context, project *store.Project, service *store.Service, deployment *store.Deployment) (*ReconcileResult, error) {
	plan := r.newDeploymentPlan(kube.SpecFromState(project, service, deployment, r.config.BaseDomain))
	if !plan.Safe {
		failure := errors.New(plan.Error)
		return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, r.persistFailure(ctx, deployment, failure, "workload.failed")
	}
	cleanupManifests := kube.CleanupManifests(plan)
	if len(cleanupManifests) == 0 {
		failure := errors.New("preview cleanup plan contains no exact deployment-owned resources")
		return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, r.persistFailure(ctx, deployment, failure)
	}
	manifestFile, err := r.writeManifest(deployment.ID, cleanupManifests, "cleanup")
	if err != nil {
		return nil, err
	}
	_ = r.store.AppendDeploymentEvent(ctx, store.DeploymentEventInput{DeploymentID: deployment.ID, Type: "preview.cleanup.started", Message: "deleting preview Kubernetes desired state", Metadata: map[string]any{"manifestFile": manifestFile, "dryRun": r.config.DryRun}})
	deleteResult, err := r.runKubectl(ctx, []string{"delete", "--ignore-not-found", "-f", manifestFile})
	_ = r.appendCommandRuntimeLogs(ctx, service.ID, deployment.ID, "preview-cleanup", deleteResult)
	if err != nil {
		return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, ManifestFile: manifestFile, Commands: []string{deleteResult.Command}, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, r.persistFailure(ctx, deployment, err)
	}
	_, err = r.store.TransitionDeployment(ctx, deployment.Lease(), map[string]any{"status": store.DeploymentStatusCleanedUp, "finishedAt": time.Now().UTC().Format(time.RFC3339Nano)})
	if err != nil {
		return nil, err
	}
	_ = r.store.AppendDeploymentEvent(ctx, store.DeploymentEventInput{DeploymentID: deployment.ID, Type: "preview.cleanup.completed", Message: "preview Kubernetes objects cleaned up", Metadata: map[string]any{"namespace": plan.Service.Namespace, "service": plan.Service.Name, "workloadKind": plan.Kind, "workloadName": plan.WorkloadName}})
	return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, ManifestFile: manifestFile, Commands: []string{deleteResult.Command}, DryRun: r.config.DryRun, Status: store.DeploymentStatusCleanedUp}, nil
}

func (r *ServiceReconciler) newDeploymentPlan(spec kube.AppServiceSpec) kube.DeploymentPlan {
	return kube.NewDeploymentPlan(spec, kube.DeploymentOptions{
		IngressGatewayNamespace: r.config.IngressGatewayNamespace,
		IngressClassName:        r.config.IngressClassName,
		IngressCustomHTTPErrors: r.config.IngressCustomHTTPErrors,
		IngressErrorMiddleware:  r.config.IngressErrorMiddleware,
	})
}

func (r *ServiceReconciler) collectDiagnostics(ctx context.Context, service *store.Service, deployment *store.Deployment, plan kube.DeploymentPlan) error {
	if r.config.DryRun {
		_ = r.store.AppendRuntimeLog(ctx, store.RuntimeLogInput{ServiceID: service.ID, DeploymentID: deployment.ID, PodName: "dry-run", ContainerName: "orchestrator", Line: "dry-run workload readiness assumed after manifest compile/apply plan", Level: "info"})
		return r.store.AppendDeploymentEvent(ctx, store.DeploymentEventInput{DeploymentID: deployment.ID, Type: "orchestrator.diagnostics", Message: "dry-run diagnostics captured", Metadata: map[string]any{"namespace": plan.Service.Namespace, "service": plan.Service.Name, "workloadKind": plan.Kind, "workloadName": plan.WorkloadName}})
	}
	events, _ := r.runKubectl(ctx, []string{"get", "events", "--namespace", plan.Service.Namespace, "--field-selector", "involvedObject.name=" + plan.WorkloadName, "--sort-by=.lastTimestamp"})
	return r.appendCommandRuntimeLogs(ctx, service.ID, deployment.ID, "events", events)
}

func (r *ServiceReconciler) markFailed(ctx context.Context, deployment *store.Deployment, failure error, eventTypes ...string) error {
	errorSpec := store.ErrorSpecForFailure(failure, store.ErrorCodeKubernetesReconcileFailed)
	_, err := r.store.TransitionDeployment(ctx, deployment.Lease(), map[string]any{"status": store.DeploymentStatusFailed, "finishedAt": time.Now().UTC().Format(time.RFC3339Nano), "errorCode": errorSpec.Code, "errorMessage": errorSpec.Message})
	if err != nil {
		return err
	}
	eventType := "workload.failed"
	if len(eventTypes) > 0 && strings.TrimSpace(eventTypes[0]) != "" {
		eventType = eventTypes[0]
	}
	// The FAILED transition is authoritative. A supplemental event must not turn
	// an already-durable terminal state into a retryable reconcile failure.
	_ = r.store.AppendDeploymentEvent(ctx, store.DeploymentEventInput{DeploymentID: deployment.ID, Type: eventType, Message: errorSpec.Message, Metadata: map[string]any{"errorSpec": errorSpec}})
	return nil
}

func (r *ServiceReconciler) persistFailure(ctx context.Context, deployment *store.Deployment, failure error, eventTypes ...string) error {
	return errors.Join(failure, r.markFailed(ctx, deployment, failure, eventTypes...))
}

func readinessFor(plan kube.DeploymentPlan, timeout time.Duration) (readinessContract, error) {
	switch plan.ReadinessStrategy {
	case kube.ReadinessDeploymentRollout:
		return readinessContract{
			args: []string{"rollout", "status", "deployment/" + plan.WorkloadName, "--namespace", plan.Service.Namespace, "--timeout", timeoutString(timeout)},
			step: "deployment-rollout", readyEvent: "rollout.ready", readyMessage: "Kubernetes deployment rollout is ready", failedEvent: "rollout.failed",
		}, nil
	case kube.ReadinessJobCompletion:
		return readinessContract{
			args: []string{"wait", "--for=condition=complete", "job/" + plan.WorkloadName, "--namespace", plan.Service.Namespace, "--timeout", timeoutString(timeout)},
			step: "job-completion", readyEvent: "job.completed", readyMessage: "Kubernetes job completed", failedEvent: "job.failed",
		}, nil
	case kube.ReadinessCronJobObserved:
		return readinessContract{
			args: []string{"get", "cronjob/" + plan.WorkloadName, "--namespace", plan.Service.Namespace, "-o", "jsonpath={.metadata.uid}"},
			step: "cronjob-observed", readyEvent: "cronjob.accepted", readyMessage: "Kubernetes cron job was accepted", failedEvent: "cronjob.failed",
		}, nil
	default:
		return readinessContract{}, fmt.Errorf("unsupported readiness strategy %q", plan.ReadinessStrategy)
	}
}

func (r *ServiceReconciler) runKubectl(ctx context.Context, args []string) (command.Result, error) {
	fullArgs := append([]string{}, args...)
	if r.config.Kubeconfig != "" {
		fullArgs = append(fullArgs, "--kubeconfig", r.config.Kubeconfig)
	}
	if r.config.KubeContext != "" {
		fullArgs = append(fullArgs, "--context", r.config.KubeContext)
	}
	return r.runner.Run(ctx, command.Command{Name: "kubectl", Args: fullArgs}, r.config.DryRun, r.config.Timeout)
}

func (r *ServiceReconciler) appendCommandRuntimeLogs(ctx context.Context, serviceID string, deploymentID string, step string, result command.Result) error {
	if result.Command != "" {
		if err := r.store.AppendRuntimeLog(ctx, store.RuntimeLogInput{ServiceID: serviceID, DeploymentID: deploymentID, PodName: step, ContainerName: "orchestrator", Line: "$ " + result.Command, Level: "info"}); err != nil {
			return err
		}
	}
	for _, line := range splitLines(result.Stdout) {
		if err := r.store.AppendRuntimeLog(ctx, store.RuntimeLogInput{ServiceID: serviceID, DeploymentID: deploymentID, PodName: step, ContainerName: "orchestrator", Line: line, Level: "info"}); err != nil {
			return err
		}
	}
	for _, line := range splitLines(result.Stderr) {
		if err := r.store.AppendRuntimeLog(ctx, store.RuntimeLogInput{ServiceID: serviceID, DeploymentID: deploymentID, PodName: step, ContainerName: "orchestrator", Line: line, Level: "warn"}); err != nil {
			return err
		}
	}
	return nil
}

func (r *ServiceReconciler) writeManifest(deploymentID string, manifests []map[string]any, suffix string) (string, error) {
	if err := os.MkdirAll(r.config.OutputDir, 0o755); err != nil {
		return "", err
	}
	file := filepath.Join(r.config.OutputDir, deploymentID+"-"+suffix+".json")
	payload, err := kube.ListJSON(manifests)
	if err != nil {
		return "", err
	}
	payload = append(payload, '\n')
	return file, os.WriteFile(file, payload, 0o600)
}

func splitLines(value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return strings.Split(strings.ReplaceAll(value, "\r\n", "\n"), "\n")
}

func timeoutString(timeout time.Duration) string {
	if timeout <= 0 {
		return "600s"
	}
	return fmt.Sprintf("%ds", int(timeout.Seconds()))
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func ResultJSON(result *ReconcileResult) string {
	if result == nil {
		return "{}"
	}
	bytes, _ := json.Marshal(result)
	return string(bytes)
}
