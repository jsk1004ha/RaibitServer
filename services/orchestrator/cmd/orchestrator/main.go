package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	orchestratorconfig "github.com/raibitserver/orchestrator/internal/config"
	"github.com/raibitserver/orchestrator/internal/controller"
	"github.com/raibitserver/orchestrator/internal/reconciler"
	"github.com/raibitserver/orchestrator/internal/store"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cfg := orchestratorconfig.FromEnv()
	reconcilerConfig := reconciler.Config{DryRun: cfg.DryRun, Kubeconfig: cfg.Kubeconfig, KubeContext: cfg.KubeContext, OutputDir: cfg.OutputDir, BaseDomain: cfg.BaseDomain, IngressGatewayNamespace: cfg.IngressGatewayNamespace, IngressClassName: cfg.IngressClassName, IngressCustomHTTPErrors: cfg.IngressCustomHTTPErrors, IngressErrorMiddleware: cfg.IngressErrorMiddleware, Timeout: cfg.Timeout, WorkerID: cfg.WorkerID, ClaimLease: cfg.ClaimLease}
	var r *reconciler.ServiceReconciler
	var domainController *controller.DomainController
	var closeStore func() error
	persistent := false
	if cfg.StateFile != "" {
		state := store.NewFileStore(cfg.StateFile)
		r = reconciler.NewServiceReconcilerWithStore(reconcilerConfig, state, nil)
		domainController = controller.NewDomainController(domainControllerConfig(cfg), state, nil)
	} else if cfg.DatabaseURL != "" {
		postgresStore, closeFn, err := store.OpenPostgresStore(ctx, cfg.DatabaseURL)
		if err != nil {
			fmt.Fprintf(os.Stderr, "orchestrator control-plane connection failed: %v\n", err)
			os.Exit(1)
		}
		closeStore = closeFn
		r = reconciler.NewServiceReconcilerWithStore(reconcilerConfig, postgresStore, nil)
		domainController = controller.NewDomainController(domainControllerConfig(cfg), postgresStore, nil)
		persistent = true
	} else {
		fmt.Fprintln(os.Stderr, "orchestrator requires DATABASE_URL in production or RAIBITSERVER_CONTROL_PLANE_FILE for deterministic local mode")
		os.Exit(1)
	}
	if closeStore != nil {
		defer closeStore()
	}
	for {
		domainResult, domainErr := domainController.RunOnce(ctx)
		if domainErr != nil {
			fmt.Fprintf(os.Stderr, "domain reconcile failed: %v\n", domainErr)
			if !persistent { os.Exit(1) }
		} else if domainResult.Processed {
			_ = json.NewEncoder(os.Stdout).Encode(domainResult)
			if !persistent { return }
		}
		result, err := r.RunOnceResult(ctx)
		if err != nil {
			fmt.Fprintf(os.Stderr, "orchestrator reconcile failed: %v\n", err)
		} else {
			_ = json.NewEncoder(os.Stdout).Encode(result)
		}
		if !persistent {
			if err != nil {
				os.Exit(1)
			}
			return
		}
		timer := time.NewTimer(cfg.PollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func domainControllerConfig(cfg orchestratorconfig.Config) controller.DomainControllerConfig {
	return controller.DomainControllerConfig{WorkerID: cfg.WorkerID, OutputDir: cfg.OutputDir, Kubeconfig: cfg.Kubeconfig, KubeContext: cfg.KubeContext, ClusterIssuer: cfg.DomainClusterIssuer, IngressClassName: cfg.IngressClassName, Lease: cfg.ClaimLease, RetryAfter: cfg.DomainRetryAfter, Timeout: cfg.Timeout, DryRun: cfg.DryRun}
}
