package reconciler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/raibitserver/orchestrator/internal/command"
	"github.com/raibitserver/orchestrator/internal/kube"
	"github.com/raibitserver/orchestrator/internal/store"
)

type Config struct {
	DryRun      bool
	Kubeconfig  string
	KubeContext string
	OutputDir   string
	BaseDomain  string
	Timeout     time.Duration
}

type ServiceReconciler struct {
	config Config
	store  store.ReconcileStore
	runner command.Runner
}

type ReconcileResult struct {
	Processed    int      `json:"processed"`
	DeploymentID string   `json:"deploymentId,omitempty"`
	Status       string   `json:"status,omitempty"`
	ManifestFile string   `json:"manifestFile,omitempty"`
	Commands     []string `json:"commands,omitempty"`
	DryRun       bool     `json:"dryRun"`
	Reason       string   `json:"reason,omitempty"`
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
	if config.Timeout <= 0 {
		config.Timeout = 10 * time.Minute
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
	deployments, err := r.store.ListDeploymentsForReconcile(ctx)
	if err != nil {
		return nil, err
	}
	if len(deployments) == 0 {
		return &ReconcileResult{Processed: 0, DryRun: r.config.DryRun, Reason: "no_image_ready_deployments"}, nil
	}
	result, err := r.reconcileDeployment(ctx, deployments[0])
	if err != nil {
		return result, err
	}
	return result, nil
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
	status := strings.ToUpper(deployment.Status)
	if status == store.DeploymentStatusCleanupRequested || status == "CLEANUP_REQUESTED" {
		return r.cleanupPreview(ctx, project, service, &deployment)
	}
	if status == store.DeploymentStatusRollbackRequested {
		if deployment.PreviousImageURL == "" {
			failure := errors.New("rollback requested but previousImageUrl is missing")
			_ = r.markFailed(ctx, &deployment, failure)
			return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, failure
		}
		deployment.ImageURL = deployment.PreviousImageURL
	}
	return r.applyAndWatch(ctx, project, service, &deployment, status == store.DeploymentStatusRollbackRequested)
}

func (r *ServiceReconciler) applyAndWatch(ctx context.Context, project *store.Project, service *store.Service, deployment *store.Deployment, rollback bool) (*ReconcileResult, error) {
	if deployment.ImageURL == "" {
		failure := errors.New("image-ready deployment is missing imageUrl")
		_ = r.markFailed(ctx, deployment, failure)
		return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, failure
	}
	plan := kube.NewDeploymentPlan(kube.SpecFromState(project, service, deployment, r.config.BaseDomain))
	manifestFile, err := r.writeManifest(deployment.ID, plan.Manifests, "apply")
	if err != nil {
		return nil, err
	}
	_, _ = r.store.UpdateDeployment(ctx, deployment.ID, map[string]any{"status": store.DeploymentStatusDeploying, "imageUrl": deployment.ImageURL})
	_ = r.store.AppendDeploymentEvent(ctx, store.DeploymentEventInput{DeploymentID: deployment.ID, Type: "orchestrator.apply.started", Message: "applying Kubernetes desired state", Metadata: map[string]any{"manifestFile": manifestFile, "rollback": rollback, "dryRun": r.config.DryRun}})
	applyResult, err := r.runKubectl(ctx, []string{"apply", "--server-side", "-f", manifestFile})
	commands := []string{applyResult.Command}
	_ = r.appendCommandRuntimeLogs(ctx, service.ID, deployment.ID, "kubectl-apply", applyResult)
	if err != nil {
		_ = r.markFailed(ctx, deployment, err)
		return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, ManifestFile: manifestFile, Commands: commands, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, err
	}
	rolloutArgs := []string{"rollout", "status", "deployment/" + plan.Service.Name, "--namespace", plan.Service.Namespace, "--timeout", timeoutString(r.config.Timeout)}
	rolloutResult, err := r.runKubectl(ctx, rolloutArgs)
	commands = append(commands, rolloutResult.Command)
	_ = r.appendCommandRuntimeLogs(ctx, service.ID, deployment.ID, "rollout", rolloutResult)
	if err != nil {
		_ = r.collectDiagnostics(ctx, service, deployment, plan)
		_ = r.markFailed(ctx, deployment, err)
		return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, ManifestFile: manifestFile, Commands: commands, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, err
	}
	_ = r.collectDiagnostics(ctx, service, deployment, plan)
	_, err = r.store.UpdateDeployment(ctx, deployment.ID, map[string]any{"status": store.DeploymentStatusReady, "deployedAt": time.Now().UTC().Format(time.RFC3339Nano), "finishedAt": time.Now().UTC().Format(time.RFC3339Nano), "errorCode": nil, "errorMessage": nil})
	if err != nil {
		return nil, err
	}
	_ = r.store.AppendDeploymentEvent(ctx, store.DeploymentEventInput{DeploymentID: deployment.ID, Type: "rollout.ready", Message: "Kubernetes rollout is ready", Metadata: map[string]any{"namespace": plan.Service.Namespace, "service": plan.Service.Name, "host": plan.Service.Host, "rollback": rollback}})
	return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, ManifestFile: manifestFile, Commands: commands, DryRun: r.config.DryRun, Status: store.DeploymentStatusReady}, nil
}

func (r *ServiceReconciler) cleanupPreview(ctx context.Context, project *store.Project, service *store.Service, deployment *store.Deployment) (*ReconcileResult, error) {
	plan := kube.NewDeploymentPlan(kube.SpecFromState(project, service, deployment, r.config.BaseDomain))
	manifestFile, err := r.writeManifest(deployment.ID, plan.Manifests, "cleanup")
	if err != nil {
		return nil, err
	}
	_ = r.store.AppendDeploymentEvent(ctx, store.DeploymentEventInput{DeploymentID: deployment.ID, Type: "preview.cleanup.started", Message: "deleting preview Kubernetes desired state", Metadata: map[string]any{"manifestFile": manifestFile, "dryRun": r.config.DryRun}})
	deleteResult, err := r.runKubectl(ctx, []string{"delete", "--ignore-not-found", "-f", manifestFile})
	_ = r.appendCommandRuntimeLogs(ctx, service.ID, deployment.ID, "preview-cleanup", deleteResult)
	if err != nil {
		_ = r.markFailed(ctx, deployment, err)
		return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, ManifestFile: manifestFile, Commands: []string{deleteResult.Command}, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, err
	}
	_, err = r.store.UpdateDeployment(ctx, deployment.ID, map[string]any{"status": store.DeploymentStatusCleanedUp, "finishedAt": time.Now().UTC().Format(time.RFC3339Nano)})
	if err != nil {
		return nil, err
	}
	_ = r.store.AppendDeploymentEvent(ctx, store.DeploymentEventInput{DeploymentID: deployment.ID, Type: "preview.cleanup.completed", Message: "preview Kubernetes objects cleaned up", Metadata: map[string]any{"namespace": plan.Service.Namespace, "service": plan.Service.Name}})
	return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, ManifestFile: manifestFile, Commands: []string{deleteResult.Command}, DryRun: r.config.DryRun, Status: store.DeploymentStatusCleanedUp}, nil
}

func (r *ServiceReconciler) collectDiagnostics(ctx context.Context, service *store.Service, deployment *store.Deployment, plan kube.DeploymentPlan) error {
	if r.config.DryRun {
		_ = r.store.AppendRuntimeLog(ctx, store.RuntimeLogInput{ServiceID: service.ID, DeploymentID: deployment.ID, PodName: "dry-run", ContainerName: "orchestrator", Line: "dry-run rollout status assumed ready after manifest compile/apply plan", Level: "info"})
		return r.store.AppendDeploymentEvent(ctx, store.DeploymentEventInput{DeploymentID: deployment.ID, Type: "orchestrator.diagnostics", Message: "dry-run diagnostics captured", Metadata: map[string]any{"namespace": plan.Service.Namespace, "service": plan.Service.Name}})
	}
	events, _ := r.runKubectl(ctx, []string{"get", "events", "--namespace", plan.Service.Namespace, "--field-selector", "involvedObject.name=" + plan.Service.Name, "--sort-by=.lastTimestamp"})
	_ = r.appendCommandRuntimeLogs(ctx, service.ID, deployment.ID, "events", events)
	logs, _ := r.runKubectl(ctx, []string{"logs", "--namespace", plan.Service.Namespace, "-l", "app.kubernetes.io/name=" + plan.Service.Name, "--tail", "100"})
	return r.appendCommandRuntimeLogs(ctx, service.ID, deployment.ID, "pod-logs", logs)
}

func (r *ServiceReconciler) markFailed(ctx context.Context, deployment *store.Deployment, failure error) error {
	errorSpec := store.ErrorSpecForFailure(failure, store.ErrorCodeKubernetesReconcileFailed)
	_, err := r.store.UpdateDeployment(ctx, deployment.ID, map[string]any{"status": store.DeploymentStatusFailed, "finishedAt": time.Now().UTC().Format(time.RFC3339Nano), "errorCode": errorSpec.Code, "errorMessage": errorSpec.Message})
	if err != nil {
		return err
	}
	return r.store.AppendDeploymentEvent(ctx, store.DeploymentEventInput{DeploymentID: deployment.ID, Type: "rollout.failed", Message: errorSpec.Message, Metadata: map[string]any{"errorSpec": errorSpec}})
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
