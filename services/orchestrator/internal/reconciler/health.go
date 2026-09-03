package reconciler

import (
	"context"
	"fmt"
	"time"

	"github.com/raibitserver/orchestrator/internal/health"
	"github.com/raibitserver/orchestrator/internal/kube"
	"github.com/raibitserver/orchestrator/internal/store"
)

func (r *ServiceReconciler) observeRollout(ctx context.Context, plan kube.DeploymentPlan, deployment *store.Deployment) (*store.HealthObservation, error) {
	if r.config.DryRun || plan.Kind != "Deployment" {
		return nil, nil
	}
	observed, err := r.observeWorkload(ctx, plan.Service)
	if err != nil {
		return nil, fmt.Errorf("observe rollout: %w", err)
	}
	observation := &store.HealthObservation{
		Version: 1, ProjectID: plan.Service.ProjectID, ServiceID: plan.Service.ServiceID, DeploymentID: deployment.ID,
		Namespace: plan.Service.Namespace, WorkloadName: plan.WorkloadName, WorkloadUID: observed.UID,
		RolloutAttempt: deployment.ReconcileAttempts, ObservedGeneration: observed.Generation,
		GeneratedHost: plan.Service.Host, EffectivePath: plan.Service.EffectivePublicHealthPath(), Public: plan.Service.ServiceType == "web",
	}
	if !observation.Public {
		observation.GeneratedHost, observation.EffectivePath = "", ""
	}
	return observation, nil
}

func (r *ServiceReconciler) observeWorkload(ctx context.Context, spec kube.AppServiceSpec) (kube.WorkloadObservation, error) {
	observeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	result, err := r.runKubectl(observeCtx, []string{"get", "deployment/" + spec.Name, "--namespace", spec.Namespace, "-o", "json"})
	if err != nil {
		return kube.WorkloadObservation{}, fmt.Errorf("read workload identity: %w", kube.ErrWorkloadObservation)
	}
	return kube.ObserveDeployment([]byte(result.Stdout), spec)
}

func (r *ServiceReconciler) runNextHealth(ctx context.Context) (*ReconcileResult, error) {
	healthCtx, stop := context.WithTimeout(ctx, 45*time.Second)
	defer stop()
	job, err := r.store.ClaimNextHealth(healthCtx, store.ClaimOptions{WorkerID: r.config.WorkerID, Now: r.now().UTC(), Lease: 30 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("claim public health: %w", err)
	}
	if job == nil {
		return nil, nil
	}
	result := &ReconcileResult{Processed: 1, DeploymentID: job.Payload.DeploymentID, Status: store.DeploymentStatusReady, Reason: "public_health_observation"}
	processCtx, cancel := context.WithCancel(healthCtx)
	defer cancel()
	done := make(chan struct{})
	renewed := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				renewed <- nil
				return
			case <-processCtx.Done():
				renewed <- nil
				return
			case <-ticker.C:
				if err := r.store.RenewHealthLease(processCtx, job.Lease(), r.now().UTC()); err != nil {
					cancel()
					renewed <- err
					return
				}
			}
		}
	}()
	observation, observeErr := r.checkHealth(processCtx, job)
	close(done)
	if err := <-renewed; err != nil {
		return result, fmt.Errorf("renew public health: %w", err)
	}
	if observeErr != nil {
		result.Reason = "public_health_cancelled"
		return result, r.store.CancelHealth(healthCtx, job.Lease(), r.now().UTC())
	}
	finishedAt := r.now().UTC()
	if !finishedAt.Before(job.Payload.AbsoluteDeadline) {
		observation = health.Result{Status: "DEGRADED", FailureCode: "PUBLIC_HEALTH_TIMEOUT"}
	}
	result.PublicHealthStatus = observation.Status
	if observation.Retryable && job.Attempts < 3 {
		delay := 5 * time.Second
		if job.Attempts == 2 {
			delay = 15 * time.Second
		}
		if finishedAt.Add(delay).Before(job.Payload.AbsoluteDeadline) {
			result.PublicHealthStatus = "CHECKING"
			result.Reason = "public_health_retry_scheduled"
		}
	}
	return result, r.store.FinishHealth(healthCtx, store.HealthCompletion{Lease: job.Lease(), Now: finishedAt, Status: observation.Status, FailureCode: observation.FailureCode, Retryable: observation.Retryable})
}

func (r *ServiceReconciler) checkHealth(ctx context.Context, job *store.HealthJob) (health.Result, error) {
	payload := job.Payload
	project, err := r.store.GetProject(ctx, payload.ProjectID)
	if err != nil {
		return health.Result{}, fmt.Errorf("health project: %w", err)
	}
	service, err := r.store.GetService(ctx, payload.ServiceID)
	if err != nil {
		return health.Result{}, fmt.Errorf("health service: %w", err)
	}
	route := kube.SpecFromState(project, service, &store.Deployment{ID: payload.DeploymentID, ProjectID: payload.ProjectID, ServiceID: payload.ServiceID, DeploymentType: job.DeploymentType, PullRequestNumber: job.PullRequestNumber}, r.config.BaseDomain)
	if route.Host != payload.GeneratedHost || route.Name != payload.WorkloadName || route.Namespace != payload.Namespace {
		return health.Result{}, kube.ErrWorkloadObservation
	}
	spec := kube.AppServiceSpec{Name: payload.WorkloadName, Namespace: payload.Namespace, ProjectID: payload.ProjectID, ServiceID: payload.ServiceID, DeploymentID: payload.DeploymentID}
	if err := r.store.RenewHealthLease(ctx, job.Lease(), r.now().UTC()); err != nil {
		return health.Result{}, err
	}
	before, err := r.observeWorkload(ctx, spec)
	if err != nil || before.UID != payload.WorkloadUID || before.Generation != payload.ObservedGeneration {
		return health.Result{}, kube.ErrWorkloadObservation
	}
	if !r.now().Before(payload.AbsoluteDeadline) {
		return health.Result{Status: "DEGRADED", FailureCode: "PUBLIC_HEALTH_TIMEOUT"}, nil
	}
	observed := r.checker.Check(ctx, health.Request{Hostname: payload.GeneratedHost, Path: payload.EffectivePath, Deadline: payload.AbsoluteDeadline})
	if err := r.store.RenewHealthLease(ctx, job.Lease(), r.now().UTC()); err != nil {
		return health.Result{}, err
	}
	after, err := r.observeWorkload(ctx, spec)
	if err != nil || after != before {
		return health.Result{}, kube.ErrWorkloadObservation
	}
	return observed, nil
}
