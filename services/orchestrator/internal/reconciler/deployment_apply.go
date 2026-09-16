package reconciler

import (
	"context"
	"errors"

	"github.com/raibitserver/orchestrator/internal/kube"
	"github.com/raibitserver/orchestrator/internal/store"
)

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
	_ = r.appendCommandRuntimeLogs(ctx, service.ID, deployment, "kubectl-apply", applyResult)
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
		_ = r.appendCommandRuntimeLogs(ctx, service.ID, deployment, "kubectl-prune", pruneResult)
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
	_ = r.appendCommandRuntimeLogs(ctx, service.ID, deployment, readiness.step, readinessResult)
	if err != nil {
		_ = r.collectDiagnostics(ctx, service, deployment, plan)
		return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, ManifestFile: manifestFile, Commands: commands, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}, r.persistFailure(ctx, deployment, err, readiness.failedEvent)
	}
	_ = r.collectDiagnostics(ctx, service, deployment, plan)
	if result, err := r.abortIfParentDeleting(ctx, project, service, deployment, manifestFile, commands); result != nil || err != nil {
		return result, err
	}
	observation, observeErr := r.observeRollout(ctx, plan, deployment)
	if observeErr != nil {
		return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, ManifestFile: manifestFile, Commands: commands, Status: store.DeploymentStatusFailed}, r.persistFailure(ctx, deployment, observeErr)
	}
	owned, inventoryErr := r.observePreviewInventory(ctx, plan, deployment)
	if inventoryErr != nil {
		return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, ManifestFile: manifestFile, Commands: commands, Status: store.DeploymentStatusFailed}, r.persistFailure(ctx, deployment, inventoryErr)
	}
	_, err = r.store.CompleteRollout(ctx, store.RolloutCompletion{Lease: deployment.Lease(), Now: r.now().UTC(), Observation: observation, ImageURL: spec.Image, LeaseDuration: r.config.ClaimLease, PreviewOwned: owned})
	if err != nil {
		if result, parentErr := r.abortIfParentDeleting(ctx, project, service, deployment, manifestFile, commands); result != nil || parentErr != nil {
			return result, parentErr
		}
		return nil, err
	}
	_ = r.store.AppendDeploymentEvent(ctx, store.DeploymentEventInput{DeploymentID: deployment.ID, Type: readiness.readyEvent, Message: readiness.readyMessage, Metadata: map[string]any{"namespace": plan.Service.Namespace, "service": plan.Service.Name, "host": plan.Service.Host, "rollback": rollback, "workloadKind": plan.Kind, "workloadName": plan.WorkloadName}})
	return &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, ManifestFile: manifestFile, Commands: commands, DryRun: r.config.DryRun, Status: store.DeploymentStatusReady}, nil
}
