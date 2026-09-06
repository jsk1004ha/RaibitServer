package reconciler

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/raibitserver/orchestrator/internal/kube"
	"github.com/raibitserver/orchestrator/internal/store"
)

func (r *ServiceReconciler) observePreviewInventory(ctx context.Context, plan kube.DeploymentPlan, deployment *store.Deployment) ([]store.PreviewOwnedObject, error) {
	if deployment.PreviewLineageID == "" {
		return nil, nil
	}
	if r.config.DryRun {
		return []store.PreviewOwnedObject{}, nil
	}
	runtime, err := store.ParsePreviewRuntime(deployment.PreviewRuntimeJSON, deployment.PreviewLineageID, deployment.ID, deployment.PreviewGeneration)
	if err != nil {
		return nil, err
	}
	objects := make([]store.PreviewOwnedObject, 0, 3)
	for _, kind := range []string{"Deployment", "Service", "Ingress"} {
		resource := strings.ToLower(kind) + "/" + runtime.WorkloadName
		result, err := r.runKubectl(ctx, []string{"get", resource, "--namespace", runtime.Namespace, "-o", "json"})
		if err != nil {
			return nil, fmt.Errorf("observe preview %s: %w", strings.ToLower(kind), err)
		}
		object, err := kube.ObservePreviewObject([]byte(result.Stdout), runtime, plan.Service.ProjectID, plan.Service.ServiceID, kind)
		if err != nil {
			return nil, err
		}
		objects = append(objects, object)
	}
	return objects, nil
}

func (r *ServiceReconciler) cleanupOwnedPreview(ctx context.Context, _ *store.Project, service *store.Service, deployment *store.Deployment) (*ReconcileResult, error) {
	result := &ReconcileResult{Processed: 1, DeploymentID: deployment.ID, DryRun: r.config.DryRun, Status: store.DeploymentStatusFailed}
	if deployment.PreviewLineageID == "" || r.config.DryRun {
		return result, store.ErrPreviewContract
	}
	runtime, err := store.ParsePreviewRuntime(deployment.PreviewRuntimeJSON, deployment.PreviewLineageID, deployment.ID, deployment.PreviewGeneration)
	if err != nil {
		return result, err
	}
	objects, err := store.ParsePreviewInventory(deployment.PreviewOwnedJSON)
	if err != nil || len(objects) == 0 {
		return result, store.ErrPreviewContract
	}
	commands := make([]string, 0, len(objects)*3)
	for _, object := range objects {
		if object.Namespace != runtime.Namespace || object.Name != runtime.WorkloadName {
			return result, store.ErrPreviewContract
		}
		getResult, getErr := r.runKubectl(ctx, []string{"get", strings.ToLower(object.Kind) + "/" + object.Name, "--namespace", object.Namespace, "--ignore-not-found=true", "-o", "json"})
		commands = append(commands, getResult.Command)
		if getErr != nil {
			return result, getErr
		}
		if strings.TrimSpace(getResult.Stdout) == "" {
			continue
		}
		actual, observeErr := kube.ObservePreviewObject([]byte(getResult.Stdout), runtime, deployment.ProjectID, deployment.ServiceID, object.Kind)
		if observeErr != nil {
			return result, observeErr
		}
		if actual.UID != object.UID {
			continue
		}
		file, err := r.writePreviewDeleteOptions(deployment.ID+"-"+object.Kind, object.UID)
		if err != nil {
			return result, err
		}
		if err := r.store.RenewDeploymentLease(ctx, deployment.Lease(), r.now().UTC()); err != nil {
			return result, err
		}
		deleteResult, deleteErr := r.runKubectl(ctx, []string{"delete", "--raw", previewObjectPath(object), "-f", file})
		commands = append(commands, deleteResult.Command)
		if err := r.store.RenewDeploymentLease(ctx, deployment.Lease(), r.now().UTC()); err != nil {
			return result, err
		}
		after, afterErr := r.runKubectl(ctx, []string{"get", strings.ToLower(object.Kind) + "/" + object.Name, "--namespace", object.Namespace, "--ignore-not-found=true", "-o", "json"})
		commands = append(commands, after.Command)
		if afterErr != nil {
			return result, errors.Join(deleteErr, afterErr)
		}
		if strings.TrimSpace(after.Stdout) != "" {
			remaining, observeErr := kube.ObservePreviewObject([]byte(after.Stdout), runtime, deployment.ProjectID, deployment.ServiceID, object.Kind)
			if observeErr != nil || remaining.UID == object.UID {
				return result, errors.Join(deleteErr, kube.ErrPreviewObject)
			}
		}
	}
	_, err = r.store.TransitionDeployment(ctx, deployment.Lease(), map[string]any{"status": store.DeploymentStatusCleanedUp, "finishedAt": r.now().UTC().Format(time.RFC3339Nano)})
	if err != nil {
		return result, err
	}
	_ = r.store.AppendDeploymentEvent(ctx, store.DeploymentEventInput{DeploymentID: deployment.ID, Type: "preview.cleanup.completed", Message: "preview Kubernetes objects cleaned up", Metadata: map[string]any{"namespace": runtime.Namespace, "workloadName": runtime.WorkloadName}})
	result.Commands, result.Status = commands, store.DeploymentStatusCleanedUp
	return result, nil
}
