package reconciler

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/orchestrator/internal/command"
	"github.com/raibitserver/orchestrator/internal/kube"
	"github.com/raibitserver/orchestrator/internal/store"
)

func TestRunOnceHonorsContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	r := NewServiceReconciler(Config{DryRun: true})
	if _, err := r.RunOnceResult(ctx); err != context.Canceled {
		t.Fatalf("expected context cancellation, got %v", err)
	}
}

func TestRunOnceDryRunCompletesWithoutExternalSideEffects(t *testing.T) {
	r := NewServiceReconciler(Config{DryRun: true})
	result, err := r.RunOnceResult(context.Background())
	if err != nil {
		t.Fatalf("expected dry-run reconcile to complete: %v", err)
	}
	if result.Processed != 0 || result.Reason != "no-control-plane-store" {
		t.Fatalf("unexpected dry-run result: %#v", result)
	}
}

func TestRunOnceRenewsDeploymentLeaseWhileKubectlIsRunning(t *testing.T) {
	stateFile := writeWorkloadState(t, "worker", nil, nil)
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	runner := &fakeRunner{started: started, release: release}
	r := NewServiceReconcilerWithStore(Config{DryRun: true, OutputDir: t.TempDir(), BaseDomain: "test.local", ClaimLease: 60 * time.Millisecond}, store.NewFileStore(stateFile), runner)

	type outcome struct {
		result *ReconcileResult
		err    error
	}
	finished := make(chan outcome, 1)
	go func() {
		result, err := r.RunOnceResult(context.Background())
		finished <- outcome{result: result, err: err}
	}()

	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("kubectl runner did not start")
	}
	initialLockedAt := firstByID(t, readState(t, stateFile), "deployments", "dep_1")["reconcileLockedAt"]
	deadline := time.Now().Add(time.Second)
	renewed := false
	for time.Now().Before(deadline) {
		select {
		case got := <-finished:
			t.Fatalf("reconcile finished before lease renewal: %#v %v", got.result, got.err)
		default:
		}
		current := firstByID(t, readState(t, stateFile), "deployments", "dep_1")["reconcileLockedAt"]
		if current != initialLockedAt {
			renewed = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !renewed {
		t.Fatal("deployment lease was not renewed while kubectl was blocked")
	}
	close(release)
	select {
	case got := <-finished:
		if got.err != nil || got.result == nil || got.result.Status != store.DeploymentStatusReady {
			t.Fatalf("reconcile failed after lease renewal: %#v %v", got.result, got.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("reconcile did not finish after releasing kubectl")
	}
}

func TestRunOnceRenewsServiceDeletionLeaseWhileKubectlIsRunning(t *testing.T) {
	stateFile := writeState(t, map[string]any{
		"projects":    []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "name": "Demo", "slug": "demo", "status": "ACTIVE"}},
		"services":    []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "web", "slug": "web", "type": "web", "status": store.DeletionStatusDeleteRequested}},
		"deployments": []any{},
	})
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	released := false
	defer func() {
		if !released {
			close(release)
		}
	}()
	runner := &fakeRunner{started: started, release: release}
	r := NewServiceReconcilerWithStore(Config{DryRun: false, OutputDir: t.TempDir(), BaseDomain: "test.local", ClaimLease: 60 * time.Millisecond}, store.NewFileStore(stateFile), runner)

	type outcome struct {
		result *ReconcileResult
		err    error
	}
	finished := make(chan outcome, 1)
	go func() {
		result, err := r.RunOnceResult(context.Background())
		finished <- outcome{result: result, err: err}
	}()

	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("service deletion kubectl runner did not start")
	}
	initialUpdatedAt := firstByID(t, readState(t, stateFile), "services", "svc_1")["updatedAt"]
	deadline := time.Now().Add(time.Second)
	renewed := false
	for time.Now().Before(deadline) {
		current := firstByID(t, readState(t, stateFile), "services", "svc_1")["updatedAt"]
		if current != initialUpdatedAt {
			renewed = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	close(release)
	released = true
	if !renewed {
		t.Fatal("service deletion lease was not renewed while kubectl was blocked")
	}
	select {
	case got := <-finished:
		if got.err != nil || got.result == nil || got.result.Status != store.DeletionStatusDeleted {
			t.Fatalf("service deletion failed after lease renewal: %#v %v", got.result, got.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("service deletion did not finish after releasing kubectl")
	}
}

func TestStaleServiceDeletionLeaseCannotRunKubectl(t *testing.T) {
	stateFile := writeState(t, map[string]any{
		"projects":    []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "name": "Demo", "slug": "demo", "status": "ACTIVE"}},
		"services":    []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "web", "slug": "web", "type": "web", "status": store.DeletionStatusDeleteRequested}},
		"deployments": []any{},
	})
	fileStore := store.NewFileStore(stateFile)
	runner := &fakeRunner{}
	r := NewServiceReconcilerWithStore(
		Config{DryRun: false, OutputDir: t.TempDir(), BaseDomain: "test.local", ClaimLease: time.Minute},
		&stealServiceDeletionLeaseOnProjectReadStore{ReconcileStore: fileStore, stateFile: stateFile},
		runner,
	)

	if _, err := r.RunOnceResult(context.Background()); !errors.Is(err, store.ErrDeletionLeaseLost) {
		t.Fatalf("expected stolen deletion lease to be fenced, got %v", err)
	}
	if len(runner.commands) != 0 {
		t.Fatalf("stale deletion owner ran kubectl before fencing: %#v", runner.commands)
	}
}

func TestStaleProjectDeletionLeaseCannotRunKubectl(t *testing.T) {
	stateFile := writeState(t, map[string]any{
		"projects": []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "name": "Demo", "slug": "demo", "status": store.DeletionStatusDeleteRequested}},
		"services": []any{}, "resources": []any{}, "deployments": []any{},
	})
	runner := &fakeRunner{}
	fileStore := store.NewFileStore(stateFile)
	r := NewServiceReconcilerWithStore(
		Config{DryRun: false, OutputDir: t.TempDir(), BaseDomain: "test.local", ClaimLease: time.Minute},
		&rejectProjectDeletionRenewalStore{ReconcileStore: fileStore},
		runner,
	)

	if _, err := r.RunOnceResult(context.Background()); !errors.Is(err, store.ErrDeletionLeaseLost) {
		t.Fatalf("expected stolen project deletion lease to be fenced, got %v", err)
	}
	if len(runner.commands) != 0 {
		t.Fatalf("stale project deletion owner ran kubectl before fencing: %#v", runner.commands)
	}
}

func TestRunOnceRenewsProjectDeletionLeaseWhileKubectlIsRunning(t *testing.T) {
	stateFile := writeState(t, map[string]any{
		"projects": []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "name": "Demo", "slug": "demo", "status": store.DeletionStatusDeleteRequested}},
		"services": []any{}, "resources": []any{}, "deployments": []any{},
	})
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	released := false
	defer func() {
		if !released {
			close(release)
		}
	}()
	runner := &fakeRunner{
		started: started,
		release: release,
		stdoutFor: func(commandText string) string {
			if strings.Contains(commandText, "get namespace/org-1--demo") {
				return `{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"org-1--demo","uid":"11111111-2222-3333-4444-555555555555","labels":{"app.kubernetes.io/managed-by":"raibitserver","raibitserver.io/managed":"true","raibitserver.io/namespace-kind":"application","raibitserver.io/project-id":"prj_1"}}}`
			}
			return "ok\n"
		},
	}
	r := NewServiceReconcilerWithStore(Config{DryRun: false, OutputDir: t.TempDir(), BaseDomain: "test.local", ClaimLease: 60 * time.Millisecond}, store.NewFileStore(stateFile), runner)
	type outcome struct {
		result *ReconcileResult
		err    error
	}
	finished := make(chan outcome, 1)
	go func() {
		result, err := r.RunOnceResult(context.Background())
		finished <- outcome{result: result, err: err}
	}()

	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("project deletion kubectl runner did not start")
	}
	initialUpdatedAt := firstByID(t, readState(t, stateFile), "projects", "prj_1")["updatedAt"]
	deadline := time.Now().Add(time.Second)
	renewed := false
	for time.Now().Before(deadline) {
		current := firstByID(t, readState(t, stateFile), "projects", "prj_1")["updatedAt"]
		if current != initialUpdatedAt {
			renewed = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	close(release)
	released = true
	if !renewed {
		t.Fatal("project deletion lease was not renewed while kubectl was blocked")
	}
	select {
	case got := <-finished:
		if got.err != nil || got.result == nil || got.result.Status != store.DeletionStatusDeleted {
			t.Fatalf("project deletion failed after lease renewal: %#v %v", got.result, got.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("project deletion did not finish after releasing kubectl")
	}
}

func TestRunOnceAppliesImageReadyDeploymentAndPersistsReadyState(t *testing.T) {
	digest := "sha256:" + strings.Repeat("a", 64)
	stateFile := writeState(t, map[string]any{
		"projects":    []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "name": "Demo", "slug": "demo"}},
		"services":    []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "web", "slug": "web", "type": "web", "port": 8080}},
		"deployments": []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "IMAGE_READY", "deploymentType": "production", "imageUrl": "registry.local/demo/web:abc123", "imageDigest": digest}},
	})
	runner := &fakeRunner{}
	r := NewServiceReconcilerWithStore(Config{DryRun: true, OutputDir: t.TempDir(), BaseDomain: "test.local", Timeout: time.Minute}, store.NewFileStore(stateFile), runner)
	result, err := r.RunOnceResult(context.Background())
	if err != nil {
		t.Fatalf("RunOnceResult failed: %v", err)
	}
	if result.Status != store.DeploymentStatusReady || result.ManifestFile == "" {
		t.Fatalf("unexpected result: %#v", result)
	}
	manifest, err := os.ReadFile(result.ManifestFile)
	if err != nil {
		t.Fatal(err)
	}
	text := string(manifest)
	if !strings.Contains(text, "registry.local/demo/web@"+digest) || !strings.Contains(text, "NetworkPolicy") || !strings.Contains(text, "Ingress") || !strings.Contains(text, "apps--org-1--demo.test.local") {
		t.Fatalf("manifest missing expected workload pieces: %s", text)
	}
	state := readState(t, stateFile)
	deployment := firstByID(t, state, "deployments", "dep_1")
	if deployment["status"] != store.DeploymentStatusReady {
		t.Fatalf("deployment not ready: %#v", deployment)
	}
	logs := marshalString(t, state["runtimeLogs"])
	if !strings.Contains(logs, "kubectl apply") || !strings.Contains(logs, "rollout status") {
		t.Fatalf("runtime logs missing kubectl commands: %s", logs)
	}
	events := marshalString(t, state["deploymentEvents"])
	if !strings.Contains(events, "rollout.ready") {
		t.Fatalf("deployment events missing rollout.ready: %s", events)
	}
}

func TestFailureTransitionErrorIsNotMaskedByReconcileCause(t *testing.T) {
	stateFile := writeState(t, map[string]any{
		"projects": []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "name": "Demo", "slug": "demo", "status": "ACTIVE"}},
		"services": []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "web", "slug": "web", "type": "web", "status": "READY"}},
		"deployments": []any{map[string]any{
			"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": store.DeploymentStatusImageReady,
		}},
	})
	transitionFailure := errors.New("control-plane transition unavailable")
	state := &rejectFailedTransitionStore{ReconcileStore: store.NewFileStore(stateFile), failure: transitionFailure}
	r := NewServiceReconcilerWithStore(Config{DryRun: true, OutputDir: t.TempDir(), BaseDomain: "test.local"}, state, &fakeRunner{})

	result, err := r.RunOnceResult(context.Background())
	if !errors.Is(err, transitionFailure) {
		t.Fatalf("failed durable transition was masked: result=%#v error=%v", result, err)
	}
	if err == nil || !strings.Contains(err.Error(), "missing imageUrl") {
		t.Fatalf("reconcile cause must remain visible beside the transition failure: %v", err)
	}
}

func TestProductionWorkloadTransitionPrunesStalePublicExposureBeforeReadiness(t *testing.T) {
	stateFile := writeWorkloadState(t, "worker", nil, nil)
	runner := &fakeRunner{}
	r := NewServiceReconcilerWithStore(Config{DryRun: true, OutputDir: t.TempDir(), BaseDomain: "test.local", Timeout: time.Minute}, store.NewFileStore(stateFile), runner)

	result, err := r.RunOnceResult(context.Background())
	if err != nil {
		t.Fatalf("worker transition reconcile failed: %v", err)
	}
	if result.Status != store.DeploymentStatusReady {
		t.Fatalf("worker transition did not become ready: %#v", result)
	}

	commands := strings.Join(runner.commands, "\n")
	applyAt := strings.Index(commands, "kubectl apply")
	pruneAt := strings.Index(commands, "kubectl delete deployments,cronjobs,jobs,services,ingresses,networkpolicies")
	readyAt := strings.Index(commands, "kubectl rollout status")
	if applyAt < 0 || pruneAt <= applyAt || readyAt <= pruneAt {
		t.Fatalf("transition must apply desired objects, prune obsolete exposure, then check readiness: %s", commands)
	}
	for _, expected := range []string{
		"--namespace org-1--demo",
		"raibitserver.io/service-id=svc_1",
		"!raibitserver.io/preview",
		"raibitserver.io/deployment-id!=dep_1",
		"--ignore-not-found=true",
		"--wait=true",
	} {
		if !strings.Contains(commands, expected) {
			t.Fatalf("stale production prune is missing %q: %s", expected, commands)
		}
	}
}

func TestDisablingPublicEgressPrunesStaleNetworkPolicyWithoutTouchingCurrentDeployment(t *testing.T) {
	stateFile := writeWorkloadState(t, "worker", map[string]any{"publicEgress": false}, nil)
	runner := &fakeRunner{}
	r := NewServiceReconcilerWithStore(Config{DryRun: true, OutputDir: t.TempDir(), BaseDomain: "test.local", Timeout: time.Minute}, store.NewFileStore(stateFile), runner)

	if _, err := r.RunOnceResult(context.Background()); err != nil {
		t.Fatalf("public egress disable reconcile failed: %v", err)
	}
	commands := strings.Join(runner.commands, "\n")
	if !strings.Contains(commands, "kubectl delete deployments,cronjobs,jobs,services,ingresses,networkpolicies") ||
		!strings.Contains(commands, "raibitserver.io/deployment-id!=dep_1") {
		t.Fatalf("stale public-egress NetworkPolicy was not pruned by deployment ownership: %s", commands)
	}
	if strings.Contains(commands, "raibitserver.io/deployment-id=dep_1,") {
		t.Fatalf("prune selector must not target current desired objects: %s", commands)
	}
}

func TestRunOnceUsesKindSpecificReadinessCommandsAndEvents(t *testing.T) {
	tests := []struct {
		serviceType  string
		command      string
		event        string
		forbidden    string
		workloadKind string
	}{
		{serviceType: "worker", command: "kubectl rollout status deployment/worker", event: "rollout.ready", forbidden: "job.completed", workloadKind: `"kind": "Deployment"`},
		{serviceType: "job", command: "kubectl wait --for=condition=complete job/job-", event: "job.completed", forbidden: "rollout.ready", workloadKind: `"kind": "Job"`},
		{serviceType: "cron", command: "kubectl get cronjob/cron", event: "cronjob.accepted", forbidden: "rollout.ready", workloadKind: `"kind": "CronJob"`},
	}
	for _, tc := range tests {
		t.Run(tc.serviceType, func(t *testing.T) {
			stateFile := writeWorkloadState(t, tc.serviceType, nil, nil)
			r := NewServiceReconcilerWithStore(Config{DryRun: true, OutputDir: t.TempDir(), BaseDomain: "test.local", Timeout: time.Minute}, store.NewFileStore(stateFile), &fakeRunner{})
			result, err := r.RunOnceResult(context.Background())
			if err != nil {
				t.Fatalf("reconcile %s failed: %v", tc.serviceType, err)
			}
			if result.Status != store.DeploymentStatusReady || !strings.Contains(strings.Join(result.Commands, "\n"), tc.command) {
				t.Fatalf("unexpected %s readiness result: %#v", tc.serviceType, result)
			}
			manifest, err := os.ReadFile(result.ManifestFile)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(manifest), tc.workloadKind) {
				t.Fatalf("%s manifest missing %s: %s", tc.serviceType, tc.workloadKind, manifest)
			}
			events := marshalString(t, readState(t, stateFile)["deploymentEvents"])
			if !strings.Contains(events, tc.event) || strings.Contains(events, tc.forbidden) {
				t.Fatalf("%s events must be kind-specific: %s", tc.serviceType, events)
			}
			if tc.serviceType == "cron" && (!strings.Contains(strings.Join(result.Commands, "\n"), "-o 'jsonpath={.metadata.uid}'") || strings.Contains(strings.Join(result.Commands, "\n"), "--timeout")) {
				t.Fatalf("cron readiness must observe UID without rollout waiting: %#v", result.Commands)
			}
		})
	}
}

func TestJobReadinessFailureMarksFailedAndCollectsDiagnostics(t *testing.T) {
	stateFile := writeWorkloadState(t, "job", map[string]any{"command": []any{"node", "job.js"}}, nil)
	runner := &fakeRunner{failContains: "wait --for=condition=complete", failure: errors.New("job deadline exceeded")}
	r := NewServiceReconcilerWithStore(Config{DryRun: false, OutputDir: t.TempDir(), BaseDomain: "test.local", Timeout: time.Minute}, store.NewFileStore(stateFile), runner)
	result, err := r.RunOnceResult(context.Background())
	if err == nil || !strings.Contains(err.Error(), "job deadline exceeded") {
		t.Fatalf("expected job wait failure, got %#v, %v", result, err)
	}
	deployment := firstByID(t, readState(t, stateFile), "deployments", "dep_1")
	if deployment["status"] != store.DeploymentStatusFailed {
		t.Fatalf("job failure must persist FAILED: %#v", deployment)
	}
	state := readState(t, stateFile)
	events := marshalString(t, state["deploymentEvents"])
	logs := marshalString(t, state["runtimeLogs"])
	if !strings.Contains(events, "job.failed") || strings.Contains(events, "rollout.failed") {
		t.Fatalf("job failure event must not use deployment rollout wording: %s", events)
	}
	if !strings.Contains(logs, "kubectl get events") {
		t.Fatalf("job failure must collect Kubernetes event diagnostics: %s", logs)
	}
	if strings.Contains(logs, "kubectl logs") || strings.Contains(logs, "pod-logs") {
		t.Fatalf("orchestrator diagnostics must not read tenant pod logs: %s", logs)
	}
}

func TestUnknownServiceTypeFailsWithoutApplyingKubernetesObjects(t *testing.T) {
	stateFile := writeWorkloadState(t, "database", nil, nil)
	runner := &fakeRunner{}
	r := NewServiceReconcilerWithStore(Config{DryRun: true, OutputDir: t.TempDir(), BaseDomain: "test.local"}, store.NewFileStore(stateFile), runner)
	result, err := r.RunOnceResult(context.Background())
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "unsupported") {
		t.Fatalf("expected explicit unsupported service type failure, got %#v, %v", result, err)
	}
	if len(runner.commands) != 0 {
		t.Fatalf("unknown service type must fail before kubectl apply: %#v", runner.commands)
	}
	deployment := firstByID(t, readState(t, stateFile), "deployments", "dep_1")
	if deployment["status"] != store.DeploymentStatusFailed {
		t.Fatalf("unknown service type must persist FAILED: %#v", deployment)
	}
}

func TestLegacyPreviewCleanupFailsClosedWithoutPersistedOwnership(t *testing.T) {
	stateFile := writeState(t, map[string]any{
		"projects":    []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "name": "Demo", "slug": "demo"}},
		"services":    []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "web", "slug": "web", "type": "web", "port": 8080}},
		"deployments": []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "PREVIEW_CLEANUP_REQUESTED", "deploymentType": "preview", "pullRequestNumber": 42, "imageUrl": "registry.local/demo/web:pr42"}},
	})
	runner := &fakeRunner{}
	r := NewServiceReconcilerWithStore(Config{OutputDir: t.TempDir(), BaseDomain: "test.local"}, store.NewFileStore(stateFile), runner)
	result, err := r.RunOnceResult(context.Background())
	if !errors.Is(err, store.ErrPreviewContract) || result.Status == store.DeploymentStatusCleanedUp || len(runner.commands) != 0 {
		t.Fatalf("legacy cleanup mutated Kubernetes: result=%#v commands=%#v err=%v", result, runner.commands, err)
	}
}

func TestOldPreviewCleanupCannotTargetNewerDeploymentForSamePR(t *testing.T) {
	project := &store.Project{ID: "prj_1", OrganizationID: "org_1", Name: "Demo", Slug: "demo"}
	service := &store.Service{ID: "svc_1", ProjectID: project.ID, Name: "web", Slug: "web", Type: "web", Port: 8080, Replicas: 1}
	oldDeployment := &store.Deployment{ID: "dep_old", ServiceID: service.ID, ProjectID: project.ID, DeploymentType: "preview", PullRequestNumber: 42, ImageURL: "registry.local/demo/web:old"}
	newDeployment := &store.Deployment{ID: "dep_new", ServiceID: service.ID, ProjectID: project.ID, DeploymentType: "preview", PullRequestNumber: 42, ImageURL: "registry.local/demo/web:new"}
	oldPlan := kube.NewDeploymentPlan(kube.SpecFromState(project, service, oldDeployment, "test.local"))
	newPlan := kube.NewDeploymentPlan(kube.SpecFromState(project, service, newDeployment, "test.local"))
	if oldPlan.WorkloadName == newPlan.WorkloadName {
		t.Fatalf("test requires deployment-specific preview names, both were %q", oldPlan.WorkloadName)
	}

	stateFile := writeState(t, map[string]any{
		"projects": []any{map[string]any{"id": project.ID, "organizationId": project.OrganizationID, "name": project.Name, "slug": project.Slug}},
		"services": []any{map[string]any{"id": service.ID, "projectId": project.ID, "name": service.Name, "slug": service.Slug, "type": service.Type, "port": service.Port}},
		"deployments": []any{
			map[string]any{"id": oldDeployment.ID, "serviceId": service.ID, "projectId": project.ID, "status": store.DeploymentStatusCleanupRequested, "deploymentType": "preview", "pullRequestNumber": 42, "imageUrl": oldDeployment.ImageURL},
			map[string]any{"id": newDeployment.ID, "serviceId": service.ID, "projectId": project.ID, "status": store.DeploymentStatusReady, "deploymentType": "preview", "pullRequestNumber": 42, "imageUrl": newDeployment.ImageURL},
		},
	})
	runner := &fakeRunner{}
	r := NewServiceReconcilerWithStore(Config{OutputDir: t.TempDir(), BaseDomain: "test.local"}, store.NewFileStore(stateFile), runner)
	result, err := r.RunOnceResult(context.Background())
	if !errors.Is(err, store.ErrPreviewContract) || len(runner.commands) != 0 || result.Status == store.DeploymentStatusCleanedUp {
		t.Fatalf("legacy cleanup should fail closed: result=%#v commands=%#v err=%v", result, runner.commands, err)
	}
}

func TestRunOnceFinalizesServiceDeletionAfterLabelScopedCleanup(t *testing.T) {
	stateFile := writeState(t, map[string]any{
		"projects":    []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "name": "Demo", "slug": "demo", "status": "ACTIVE"}},
		"services":    []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "web", "slug": "web", "type": "web", "status": store.DeletionStatusDeleteRequested}},
		"deployments": []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "CANCELLED"}},
	})
	runner := &fakeRunner{}
	r := NewServiceReconcilerWithStore(Config{DryRun: false, OutputDir: t.TempDir(), BaseDomain: "test.local"}, store.NewFileStore(stateFile), runner)
	result, err := r.RunOnceResult(context.Background())
	if err != nil {
		t.Fatalf("service deletion failed: %v", err)
	}
	if result.Status != store.DeletionStatusDeleted || result.Reason != "service_deleted" {
		t.Fatalf("unexpected service deletion result: %#v", result)
	}
	state := readState(t, stateFile)
	if len(state["services"].([]any)) != 0 {
		t.Fatalf("service tombstone was not finalized: %#v", state["services"])
	}
	commands := strings.Join(runner.commands, "\n")
	for _, expected := range []string{"deployments,cronjobs,jobs,services,ingresses,networkpolicies", "--namespace org-1--demo", "raibitserver.io/project-id=prj_1,raibitserver.io/service-id=svc_1", "--ignore-not-found=true", "--wait=true"} {
		if !strings.Contains(commands, expected) {
			t.Fatalf("service cleanup missing %q in %s", expected, commands)
		}
	}
	if strings.Contains(commands, "raibitserver.io/base-service") {
		t.Fatalf("service cleanup must not use a reusable slug-derived selector: %s", commands)
	}
	if strings.Contains(commands, "delete namespace") {
		t.Fatalf("service cleanup must never delete a shared namespace: %s", commands)
	}
}

func TestRunOnceFinalizesChildFreeProjectDeletion(t *testing.T) {
	stateFile := writeState(t, map[string]any{
		"projects": []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "name": "Demo", "slug": "demo", "status": store.DeletionStatusDeleteRequested}},
		"services": []any{}, "resources": []any{}, "deployments": []any{},
	})
	runner := &fakeRunner{stdoutFor: func(commandText string) string {
		if strings.Contains(commandText, "get namespace/org-1--demo") {
			return `{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"org-1--demo","uid":"11111111-2222-3333-4444-555555555555","labels":{"app.kubernetes.io/managed-by":"raibitserver","raibitserver.io/managed":"true","raibitserver.io/namespace-kind":"application","raibitserver.io/project-id":"prj_1"}}}`
		}
		return "ok\n"
	}}
	outputDir := t.TempDir()
	r := NewServiceReconcilerWithStore(Config{DryRun: false, OutputDir: outputDir, BaseDomain: "test.local"}, store.NewFileStore(stateFile), runner)
	result, err := r.RunOnceResult(context.Background())
	if err != nil {
		t.Fatalf("project deletion failed: %v", err)
	}
	if result.Status != store.DeletionStatusDeleted || result.Reason != "project_deleted" {
		t.Fatalf("unexpected project deletion result: %#v", result)
	}
	if len(readState(t, stateFile)["projects"].([]any)) != 0 {
		t.Fatal("project tombstone was not finalized")
	}
	commandText := strings.Join(runner.commands, "\n")
	for _, expected := range []string{
		"kubectl get namespace/org-1--demo --ignore-not-found=true --output=json",
		"kubectl delete --raw /api/v1/namespaces/org-1--demo -f",
		"kubectl wait --for=delete namespace/org-1--demo",
	} {
		if !strings.Contains(commandText, expected) {
			t.Fatalf("project cleanup missing UID-fenced step %q: %s", expected, commandText)
		}
	}
	deleteOptions, err := filepath.Glob(filepath.Join(outputDir, "*delete-options*.json"))
	if err != nil || len(deleteOptions) != 1 {
		t.Fatalf("expected one UID delete-options file, files=%#v error=%v", deleteOptions, err)
	}
	payload, err := os.ReadFile(deleteOptions[0])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(payload), `"uid": "11111111-2222-3333-4444-555555555555"`) {
		t.Fatalf("project delete options are not UID fenced: %s", payload)
	}
}

func TestProjectDeletionRejectsNamespaceOwnedByReplacementProject(t *testing.T) {
	stateFile := writeState(t, map[string]any{
		"projects": []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "name": "Demo", "slug": "demo", "status": store.DeletionStatusDeleteRequested}},
		"services": []any{}, "resources": []any{}, "deployments": []any{},
	})
	runner := &fakeRunner{stdoutFor: func(commandText string) string {
		if strings.Contains(commandText, "get namespace/org-1--demo") {
			return `{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"org-1--demo","uid":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","labels":{"app.kubernetes.io/managed-by":"raibitserver","raibitserver.io/managed":"true","raibitserver.io/namespace-kind":"application","raibitserver.io/project-id":"replacement-project"}}}`
		}
		return "ok\n"
	}}
	r := NewServiceReconcilerWithStore(Config{DryRun: false, OutputDir: t.TempDir(), BaseDomain: "test.local"}, store.NewFileStore(stateFile), runner)

	if _, err := r.RunOnceResult(context.Background()); err == nil || !strings.Contains(err.Error(), "namespace ownership mismatch") {
		t.Fatalf("expected replacement namespace ownership rejection, got %v", err)
	}
	commands := strings.Join(runner.commands, "\n")
	if strings.Contains(commands, "delete --raw") {
		t.Fatalf("replacement namespace must not be deleted: %s", commands)
	}
	if len(readState(t, stateFile)["projects"].([]any)) != 1 {
		t.Fatal("project tombstone finalized after namespace ownership mismatch")
	}
}

func TestServiceDeletionFailureLeavesRetryableTombstone(t *testing.T) {
	stateFile := writeState(t, map[string]any{
		"projects":    []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "slug": "demo", "status": "ACTIVE"}},
		"services":    []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "slug": "web", "type": "web", "status": store.DeletionStatusDeleteRequested}},
		"deployments": []any{},
	})
	runner := &fakeRunner{failContains: "delete deployments,cronjobs", failure: errors.New("cluster unavailable")}
	r := NewServiceReconcilerWithStore(Config{DryRun: false, OutputDir: t.TempDir(), BaseDomain: "test.local"}, store.NewFileStore(stateFile), runner)
	if _, err := r.RunOnceResult(context.Background()); err == nil || !strings.Contains(err.Error(), "cluster unavailable") {
		t.Fatalf("expected cleanup failure, got %v", err)
	}
	service := firstByID(t, readState(t, stateFile), "services", "svc_1")
	if service["status"] != store.DeletionStatusDeleting {
		t.Fatalf("failed cleanup must retain a stale-retryable DELETING row: %#v", service)
	}
}

func TestServiceDeletionDryRunReleasesTombstoneWithoutHardDelete(t *testing.T) {
	stateFile := writeState(t, map[string]any{
		"projects":    []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "slug": "demo", "status": "ACTIVE"}},
		"services":    []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "slug": "web", "type": "web", "status": store.DeletionStatusDeleteRequested}},
		"deployments": []any{},
	})
	r := NewServiceReconcilerWithStore(Config{DryRun: true, OutputDir: t.TempDir(), BaseDomain: "test.local"}, store.NewFileStore(stateFile), &fakeRunner{})
	result, err := r.RunOnceResult(context.Background())
	if err != nil {
		t.Fatalf("dry-run deletion failed: %v", err)
	}
	if result.Status != store.DeletionStatusDeleteRequested || result.Reason != "service_deletion_dry_run" {
		t.Fatalf("unexpected dry-run result: %#v", result)
	}
	service := firstByID(t, readState(t, stateFile), "services", "svc_1")
	if service["status"] != store.DeletionStatusDeleteRequested {
		t.Fatalf("dry-run must retain and release tombstone: %#v", service)
	}
}

func TestParentDeletionDuringReadinessCannotResurrectDeployment(t *testing.T) {
	stateFile := writeWorkloadState(t, "worker", nil, nil)
	runner := &fakeRunner{onRun: func(commandText string) {
		if !strings.Contains(commandText, "rollout status") {
			return
		}
		state := readState(t, stateFile)
		firstByID(t, state, "services", "svc_1")["status"] = store.DeletionStatusDeleteRequested
		payload, err := json.MarshalIndent(state, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(stateFile, payload, 0o600); err != nil {
			t.Fatal(err)
		}
	}}
	r := NewServiceReconcilerWithStore(Config{DryRun: true, OutputDir: t.TempDir(), BaseDomain: "test.local"}, store.NewFileStore(stateFile), runner)
	result, err := r.RunOnceResult(context.Background())
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "being deleted") {
		t.Fatalf("parent deletion race must abort reconciliation, got %#v %v", result, err)
	}
	deployment := firstByID(t, readState(t, stateFile), "deployments", "dep_1")
	if deployment["status"] == store.DeploymentStatusReady {
		t.Fatalf("deployment was resurrected after tombstone: %#v", deployment)
	}
	if !strings.Contains(strings.Join(runner.commands, "\n"), "raibitserver.io/service-id=svc_1") {
		t.Fatalf("race cleanup did not remove newly applied workload: %#v", runner.commands)
	}
}

func TestRollbackRequiresDigestPinnedPreviousImage(t *testing.T) {
	stateFile := writeState(t, rollbackState("registry.example.test/demo/web:previous", "sha256:"+strings.Repeat("a", 64)))
	r := NewServiceReconcilerWithStore(Config{DryRun: true, OutputDir: t.TempDir(), BaseDomain: "test.local"}, store.NewFileStore(stateFile), &fakeRunner{})
	result, err := r.RunOnceResult(context.Background())
	if err == nil || !strings.Contains(err.Error(), "previousImageUrl must be digest-pinned") {
		t.Fatalf("expected mutable rollback rejection, got %#v, %v", result, err)
	}
}

func TestRollbackUsesPreviousEmbeddedDigestInsteadOfCurrentDigest(t *testing.T) {
	currentDigest := "sha256:" + strings.Repeat("a", 64)
	previousDigest := "sha256:" + strings.Repeat("b", 64)
	stateFile := writeState(t, rollbackState("registry.example.test/demo/web@"+previousDigest, currentDigest))
	r := NewServiceReconcilerWithStore(Config{DryRun: true, OutputDir: t.TempDir(), BaseDomain: "test.local"}, store.NewFileStore(stateFile), &fakeRunner{})
	result, err := r.RunOnceResult(context.Background())
	if err != nil {
		t.Fatalf("digest-pinned rollback failed: %v", err)
	}
	manifest, err := os.ReadFile(result.ManifestFile)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(manifest), "registry.example.test/demo/web@"+previousDigest) || strings.Contains(string(manifest), "registry.example.test/demo/web@"+currentDigest) {
		t.Fatalf("rollback used wrong digest: %s", string(manifest))
	}
}

func rollbackState(previousImageURL, currentDigest string) map[string]any {
	return map[string]any{
		"projects":    []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "name": "Demo", "slug": "demo"}},
		"services":    []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "web", "slug": "web", "type": "web", "port": 8080}},
		"deployments": []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": store.DeploymentStatusRollbackRequested, "imageUrl": "registry.example.test/demo/web:current", "imageDigest": currentDigest, "previousImageUrl": previousImageURL}},
	}
}

type fakeRunner struct {
	commands     []string
	failContains string
	failure      error
	started      chan<- struct{}
	release      <-chan struct{}
	onRun        func(string)
	stdoutFor    func(string) string
}

func (f *fakeRunner) Run(ctx context.Context, spec command.Command, dryRun bool, timeout time.Duration) (command.Result, error) {
	printable := command.CommandString(spec)
	f.commands = append(f.commands, printable)
	if f.onRun != nil {
		f.onRun(printable)
	}
	if f.started != nil {
		select {
		case f.started <- struct{}{}:
		default:
		}
	}
	if f.release != nil {
		select {
		case <-f.release:
		case <-ctx.Done():
			return command.Result{Command: printable, DryRun: dryRun, ExitCode: 1, Stderr: ctx.Err().Error()}, ctx.Err()
		}
	}
	stdout := "ok\n"
	if f.stdoutFor != nil {
		stdout = f.stdoutFor(printable)
	}
	result := command.Result{Command: printable, DryRun: dryRun, ExitCode: 0, Stdout: stdout}
	if f.failContains != "" && strings.Contains(printable, f.failContains) {
		result.ExitCode = 1
		result.Stderr = f.failure.Error()
		return result, f.failure
	}
	return result, nil
}

type stealServiceDeletionLeaseOnProjectReadStore struct {
	store.ReconcileStore
	stateFile string
}

type rejectProjectDeletionRenewalStore struct {
	store.ReconcileStore
}

type rejectFailedTransitionStore struct {
	store.ReconcileStore
	failure error
}

func (s *rejectFailedTransitionStore) TransitionDeployment(_ context.Context, _ store.DeploymentLease, updates map[string]any) (*store.Deployment, error) {
	if updates["status"] == store.DeploymentStatusFailed {
		return nil, s.failure
	}
	return nil, errors.New("unexpected deployment transition")
}

func (s *rejectProjectDeletionRenewalStore) RenewProjectDeletionLease(_ context.Context, lease store.DeletionLease, _ time.Time) (store.DeletionLease, error) {
	return lease, store.ErrDeletionLeaseLost
}

func (s *stealServiceDeletionLeaseOnProjectReadStore) GetProject(ctx context.Context, projectID string) (*store.Project, error) {
	project, err := s.ReconcileStore.GetProject(ctx, projectID)
	if err != nil {
		return nil, err
	}
	state, err := os.ReadFile(s.stateFile)
	if err != nil {
		return nil, err
	}
	var decoded map[string]any
	if err := json.Unmarshal(state, &decoded); err != nil {
		return nil, err
	}
	services := decoded["services"].([]any)
	services[0].(map[string]any)["updatedAt"] = time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)
	payload, err := json.MarshalIndent(decoded, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(s.stateFile, payload, 0o600); err != nil {
		return nil, err
	}
	return project, nil
}

func writeWorkloadState(t *testing.T, serviceType string, desiredSpec, desiredState map[string]any) string {
	t.Helper()
	digest := "sha256:" + strings.Repeat("a", 64)
	return writeState(t, map[string]any{
		"projects": []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "name": "Demo", "slug": "demo"}},
		"services": []any{map[string]any{
			"id": "svc_1", "projectId": "prj_1", "name": serviceType, "slug": serviceType, "type": serviceType, "port": 8080,
			"desiredSpec": desiredSpec, "desiredState": desiredState,
		}},
		"deployments": []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "IMAGE_READY", "deploymentType": "production", "imageUrl": "registry.local/demo/workload:abc123", "imageDigest": digest}},
	})
}

func writeState(t *testing.T, state map[string]any) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state.json")
	bytes, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, bytes, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func readState(t *testing.T, path string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	var bytes []byte
	var err error
	for {
		bytes, err = os.ReadFile(path)
		if err == nil || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err := json.Unmarshal(bytes, &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func firstByID(t *testing.T, state map[string]any, key, id string) map[string]any {
	t.Helper()
	for _, item := range state[key].([]any) {
		row, ok := item.(map[string]any)
		if ok && row["id"] == id {
			return row
		}
	}
	t.Fatalf("%s %s not found", key, id)
	return nil
}

func marshalString(t *testing.T, value any) string {
	t.Helper()
	bytes, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(bytes)
}
