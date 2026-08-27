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
	"github.com/raibitserver/orchestrator/internal/reconciler"
	"github.com/raibitserver/orchestrator/internal/store"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cfg := orchestratorconfig.FromEnv()
	reconcilerConfig := reconciler.Config{DryRun: cfg.DryRun, Kubeconfig: cfg.Kubeconfig, KubeContext: cfg.KubeContext, OutputDir: cfg.OutputDir, BaseDomain: cfg.BaseDomain, IngressGatewayNamespace: cfg.IngressGatewayNamespace, IngressClassName: cfg.IngressClassName, Timeout: cfg.Timeout, WorkerID: cfg.WorkerID, ClaimLease: cfg.ClaimLease}
	var r *reconciler.ServiceReconciler
	var closeStore func() error
	persistent := false
	if cfg.StateFile != "" {
		r = reconciler.NewServiceReconcilerWithStore(reconcilerConfig, store.NewFileStore(cfg.StateFile), nil)
	} else if cfg.DatabaseURL != "" {
		postgresStore, closeFn, err := store.OpenPostgresStore(ctx, cfg.DatabaseURL)
		if err != nil {
			fmt.Fprintf(os.Stderr, "orchestrator control-plane connection failed: %v\n", err)
			os.Exit(1)
		}
		closeStore = closeFn
		r = reconciler.NewServiceReconcilerWithStore(reconcilerConfig, postgresStore, nil)
		persistent = true
	} else {
		fmt.Fprintln(os.Stderr, "orchestrator requires DATABASE_URL in production or RAIBITSERVER_CONTROL_PLANE_FILE for deterministic local mode")
		os.Exit(1)
	}
	if closeStore != nil {
		defer closeStore()
	}
	for {
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
