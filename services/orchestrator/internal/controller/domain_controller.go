package controller

import (
	"context"
	"net"
	"time"

	"github.com/raibitserver/orchestrator/internal/command"
	domainreconciler "github.com/raibitserver/orchestrator/internal/domain"
	"github.com/raibitserver/orchestrator/internal/kube"
	"github.com/raibitserver/orchestrator/internal/store"
)

type DomainControllerConfig struct {
	WorkerID, OutputDir, Kubeconfig, KubeContext string
	ClusterIssuer, IngressClassName              string
	Lease, RetryAfter, Timeout                   time.Duration
	DryRun                                       bool
}

// DomainController verifies domain ownership and reconciles its isolated TLS route.
type DomainController struct{ reconciler *domainreconciler.Reconciler }

func NewDomainController(config DomainControllerConfig, state store.DomainStore, runner command.Runner) *DomainController {
	now := time.Now
	verifier := domainreconciler.NewVerifier(domainreconciler.NewNetResolver(net.DefaultResolver), now)
	cluster := kube.NewKubectlDomainKubernetes(runner, kube.KubectlDomainOptions{OutputDir: config.OutputDir, Kubeconfig: config.Kubeconfig, Context: config.KubeContext, Timeout: config.Timeout, DryRun: config.DryRun})
	reconciler := domainreconciler.NewReconciler(
		domainreconciler.ReconcilerConfig{WorkerID: config.WorkerID, Lease: config.Lease, RetryAfter: config.RetryAfter, ClusterIssuer: config.ClusterIssuer, IngressClassName: config.IngressClassName},
		domainreconciler.ReconcilerDependencies{Store: state, Verifier: verifier, Kube: cluster, Now: now},
	)
	return &DomainController{reconciler: reconciler}
}

func (DomainController) Name() string { return "raibitserver-domain-controller" }

func (c *DomainController) RunOnce(ctx context.Context) (domainreconciler.ReconcileResult, error) {
	return c.reconciler.RunOnce(ctx)
}
