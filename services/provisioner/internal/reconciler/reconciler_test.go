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

	"github.com/raibitserver/provisioner/internal/command"
	"github.com/raibitserver/provisioner/internal/provider"
	"github.com/raibitserver/provisioner/internal/store"
)

const (
	testCredentialSecretUID        = "5c0c1aa2-e18f-43be-9dc7-3dfbf158cd21"
	testCredentialSecretGeneration = "dGhpcy1pcy1hLTMyaWJ5dGUtcmFuZG9tLW5vbmNlMDA"
)

func credentialState(updates map[string]any) map[string]any {
	state := map[string]any{"credentialSecretUID": testCredentialSecretUID}
	for key, value := range updates {
		state[key] = value
	}
	return state
}

func postgresqlLiveConfig(outputDir string) Config {
	return Config{
		OutputDir:               outputDir,
		Timeout:                 time.Minute,
		Images:                  map[string]string{"postgresql": "registry.example/postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
		ServiceAccountName:      "raibitserver-provisioner",
		ServiceAccountNamespace: "raibitserver-system",
		TenantRoleName:          "raibitserver-provisioner-tenant",
	}
}

func TestManifestOutputCannotEscapeConfiguredDirectory(t *testing.T) {
	outputDir := t.TempDir()
	path, err := New(Config{OutputDir: outputDir}, &fakeStore{}, &fakeRunner{}).writeManifest(`..\..\provider-secret`, map[string]any{"kind": "List"})
	if err != nil {
		t.Fatal(err)
	}
	relative, err := filepath.Rel(outputDir, path)
	if err != nil {
		t.Fatal(err)
	}
	if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		t.Fatalf("manifest escaped configured output directory: %s", path)
	}
}

func TestClaimLeaseCannotExpireDuringAReadinessFailurePath(t *testing.T) {
	timeout := 2 * time.Minute
	worker := New(Config{Timeout: timeout, ClaimLease: time.Minute}, &fakeStore{}, &fakeRunner{})
	if worker.config.ClaimLease < 2*timeout+time.Minute {
		t.Fatalf("claim lease %s can expire while a rollout and readiness check are still running", worker.config.ClaimLease)
	}
}

func TestProvisionFailurePreservesTheCauseAndFailedTransitionError(t *testing.T) {
	transitionErr := errors.New("control-plane failed transition unavailable")
	state := &fakeStore{
		resource: &store.Resource{
			ID:             "res-1",
			ProjectID:      "project-1",
			OrganizationID: "org-1",
			ProjectSlug:    "demo",
			Name:           "db",
			Engine:         "postgresql",
			Status:         store.StatusProvisioning,
		},
		transitionFailure: transitionErr,
	}

	result, err := New(Config{DryRun: false, OutputDir: t.TempDir()}, state, &fakeRunner{}).RunOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "pinned by sha256 digest") {
		t.Fatalf("provider compile failure must remain visible: result=%#v err=%v", result, err)
	}
	if !errors.Is(err, transitionErr) {
		t.Fatalf("failed status persistence error must not be masked: result=%#v err=%v", result, err)
	}
}

func TestProvisioningAndHealthClaimsAlternateUnderSustainedBacklog(t *testing.T) {
	state := &fakeStore{
		resource:       &store.Resource{ID: "provision-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusProvisioning},
		healthResource: &store.Resource{ID: "health-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusReady, DesiredState: credentialState(nil)},
	}
	runner := &fakeRunner{}
	worker := New(postgresqlLiveConfig(t.TempDir()), state, runner)
	first, err := worker.RunOnce(context.Background())
	if err != nil || first.ResourceID != "provision-1" {
		t.Fatalf("provisioning must receive a bounded share under continuous health load: result=%#v err=%v", first, err)
	}
	state.resource = &store.Resource{ID: "provision-2", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusProvisioning}
	state.healthResource = &store.Resource{ID: "health-2", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusReady, DesiredState: credentialState(nil)}
	// The first reconciliation created a different provider Secret. Model the
	// independently existing credential for the READY resource claimed next.
	runner.secretName = ""
	runner.secretNamespace = ""
	second, err := worker.RunOnce(context.Background())
	if err != nil || second.ResourceID != "health-2" {
		t.Fatalf("READY health must receive a bounded share under continuous provisioning load: result=%#v err=%v", second, err)
	}
}

func TestDeletionIsClaimedBeforeProvisioningAndFinalizedAfterIdempotentProviderDelete(t *testing.T) {
	resource := &store.Resource{ID: "res-delete", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "cache", Slug: "cache", Engine: "redis", Status: "DELETE_REQUESTED", DesiredState: credentialState(map[string]any{"providerRef": "keep-until-delete"})}
	name, _, secretName, pvcName, err := provider.ObjectNames(resource)
	if err != nil {
		t.Fatal(err)
	}
	state := &fakeStore{deletion: resource}
	runner := &fakeRunner{namespaceExists: true}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != store.StatusDeleted || state.finalized != 1 || state.provisionClaims != 0 || state.finalizedClaimToken != "deletion-claim" {
		t.Fatalf("deletion must win and finalize exactly once: result=%#v state=%#v", result, state)
	}
	if len(runner.calls) < 4 {
		t.Fatalf("provider cleanup must delete public/workload objects and credentials last: %#v", runner.calls)
	}
	service := indexContaining(runner.calls, "delete service/"+name)
	serviceWait := indexContaining(runner.calls, "kubectl wait --for=delete service/"+name)
	workload := indexContaining(runner.calls, "delete statefulset/"+name)
	workloadWait := indexContaining(runner.calls, "kubectl wait --for=delete statefulset/"+name)
	networkPolicy := indexContaining(runner.calls, "delete networkpolicy/"+name+"-provider")
	networkPolicyWait := indexContaining(runner.calls, "kubectl wait --for=delete networkpolicy/"+name+"-provider")
	pvc := indexContaining(runner.calls, "delete persistentvolumeclaim/"+pvcName)
	pvcWait := indexContaining(runner.calls, "kubectl wait --for=delete persistentvolumeclaim/"+pvcName)
	secretVerify := indexContaining(runner.calls, "delete secret/"+secretName+" --namespace ")
	secret := lastIndexContaining(runner.calls, "delete secret/"+secretName+" --namespace ")
	secretWait := indexContaining(runner.calls, "kubectl wait --for=delete secret/"+secretName)
	if secretVerify < 0 || service < 0 || serviceWait < 0 || workload < 0 || workloadWait < 0 || networkPolicy < 0 || networkPolicyWait < 0 || pvc < 0 || pvcWait < 0 || secret < 0 || secretWait < 0 ||
		secretVerify > service || service > serviceWait || serviceWait > workload || workload > workloadWait || workloadWait > networkPolicy || networkPolicy > networkPolicyWait || networkPolicyWait > secret || secret > secretWait || secretWait > pvc || pvc > pvcWait {
		t.Fatalf("unexpected safe deletion order: %#v", runner.calls)
	}
	if !strings.Contains(runner.calls[workloadWait], "--for=delete") || !strings.Contains(runner.calls[workloadWait], "--timeout=") {
		t.Fatalf("provider Pod dependents must be gone before NetworkPolicy removal: %#v", runner.calls)
	}
	if len(runner.inputs) < 2 || !strings.Contains(runner.inputs[0], `"kind":"Namespace"`) || !strings.Contains(runner.inputs[1], `"kind":"RoleBinding"`) || indexContaining(runner.calls, "kubectl apply --server-side -f -") > service {
		t.Fatalf("deletion must restore tenant-scoped access before deleting provider objects: calls=%#v inputs=%#v", runner.calls, runner.inputs)
	}
}

func TestDeletionDoesNotFinalizeWhilePersistentVolumeClaimDeletionIsPending(t *testing.T) {
	resource := &store.Resource{ID: "res-delete-pvc-pending", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusDeleteRequested, DesiredState: credentialState(nil)}
	state := &fakeStore{deletion: resource}
	runner := &fakeRunner{
		namespaceExists: true,
		failure:         errors.New("persistent volume claim deletion timed out"),
		failureNeedle:   "kubectl wait --for=delete persistentvolumeclaim/",
	}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "deletion timed out") {
		t.Fatalf("pending PVC deletion must remain retryable: result=%#v err=%v", result, err)
	}
	if result == nil || result.Status != store.StatusDeleting || state.finalized != 0 {
		t.Fatalf("resource row must remain until persistent data is demonstrably absent: result=%#v finalized=%d", result, state.finalized)
	}
}

func TestContinuousDeletionBacklogCannotStarveProvisioning(t *testing.T) {
	state := &fakeStore{
		deletion: &store.Resource{ID: "delete-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "old-db", Engine: "postgresql", Status: store.StatusDeleteRequested},
		resource: &store.Resource{ID: "provision-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "new-db", Engine: "postgresql", Status: store.StatusProvisioning},
	}
	worker := New(Config{DryRun: true, OutputDir: t.TempDir()}, state, &fakeRunner{})
	first, err := worker.RunOnce(context.Background())
	if err != nil || first.ResourceID != "delete-1" {
		t.Fatalf("deletion keeps first priority: result=%#v err=%v", first, err)
	}
	state.deletion = &store.Resource{ID: "delete-2", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "older-db", Engine: "postgresql", Status: store.StatusDeleteRequested}
	second, err := worker.RunOnce(context.Background())
	if err != nil || second.ResourceID != "provision-1" {
		t.Fatalf("a continuous deletion backlog must yield a bounded work slot: result=%#v err=%v", second, err)
	}
}

func TestDeletionFinalizesWithoutCreatingNamespaceWhenTenantNamespaceIsAlreadyGone(t *testing.T) {
	resource := &store.Resource{ID: "res-delete", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusDeleteRequested}
	state := &fakeStore{deletion: resource}
	runner := &fakeRunner{}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != store.StatusDeleted || state.finalized != 1 {
		t.Fatalf("an absent tenant namespace proves all provider objects are absent: result=%#v state=%#v", result, state)
	}
	if indexContaining(runner.calls, "kubectl apply") >= 0 || indexContaining(runner.calls, "kubectl delete") >= 0 {
		t.Fatalf("deletion must not recreate an absent namespace: %#v", runner.calls)
	}
}

func TestProviderDeleteFailureRetainsTombstoneAndConnectionMetadata(t *testing.T) {
	resource := &store.Resource{ID: "res-delete", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Slug: "db", Engine: "postgresql", Status: "DELETE_REQUESTED", ConnectionSecretName: "provider-secret", DesiredState: credentialState(map[string]any{"providerRef": "keep"})}
	state := &fakeStore{deletion: resource}
	runner := &fakeRunner{failure: errors.New("provider api unavailable"), failureNeedle: "kubernetes-api delete", namespaceExists: true}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "provider api unavailable") {
		t.Fatalf("expected provider deletion failure, result=%#v err=%v", result, err)
	}
	if state.finalized != 0 || resource.ConnectionSecretName != "provider-secret" || resource.DesiredState["providerRef"] != "keep" {
		t.Fatalf("failed cleanup must retain row and provider metadata: %#v", state)
	}
}

func TestCredentialUIDMismatchStopsDeletionBeforePersistentData(t *testing.T) {
	resource := &store.Resource{ID: "res-delete-replaced", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusDeleteRequested, DesiredState: credentialState(nil)}
	state := &fakeStore{deletion: resource}
	runner := &fakeRunner{namespaceExists: true, secretExists: true, replacementUIDMismatch: true}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err == nil || result == nil || result.Status != store.StatusDeleting || !strings.Contains(err.Error(), "UID") {
		t.Fatalf("replacement credential must block deletion: result=%#v err=%v", result, err)
	}
	if state.finalized != 0 || indexContaining(runner.calls, "kubectl delete persistentvolumeclaim/") >= 0 || indexContaining(runner.calls, "kubectl delete statefulset/") >= 0 {
		t.Fatalf("UID mismatch must be detected before destructive cleanup: state=%#v calls=%#v", state, runner.calls)
	}
}

func TestUnsupportedDeletionAdapterFailsClosedWithoutFinalizing(t *testing.T) {
	state := &fakeStore{deletion: &store.Resource{ID: "res-delete", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "unknown", Slug: "unknown", Engine: "future-db", Status: "DELETE_REQUESTED"}}
	runner := &fakeRunner{}
	result, err := New(Config{DryRun: false, OutputDir: t.TempDir()}, state, runner).RunOnce(context.Background())
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "unsupported") {
		t.Fatalf("unsupported adapter must fail closed, result=%#v err=%v", result, err)
	}
	if state.finalized != 0 || len(runner.calls) != 0 {
		t.Fatalf("unsupported adapter must not delete or finalize: state=%#v calls=%#v", state, runner.calls)
	}
}

func TestDryRunReturnsResourceToProvisioningWithoutReadyTransition(t *testing.T) {
	state := &fakeStore{resource: &store.Resource{ID: "res-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "cache", Slug: "cache", Engine: "redis", Plan: "shared-small", Status: store.StatusProvisioning}}
	runner := &fakeRunner{}
	result, err := New(Config{DryRun: true, OutputDir: t.TempDir()}, state, runner).RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != store.StatusProvisioning || state.nextStatus != store.StatusProvisioning {
		t.Fatalf("dry-run must remain provisioning, result=%#v next=%s", result, state.nextStatus)
	}
	if state.readyTransitions != 0 {
		t.Fatalf("dry-run made %d ready transitions", state.readyTransitions)
	}
	if len(runner.calls) != 1 || !strings.Contains(runner.calls[0], "kubectl apply") {
		t.Fatalf("dry-run should compile one apply plan without wait: %#v", runner.calls)
	}
}

func TestLiveReconcileWaitsForProviderReadyBeforeReadyTransition(t *testing.T) {
	resource := &store.Resource{ID: "res-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Slug: "db", Engine: "postgresql", Plan: "shared-small", Status: store.StatusProvisioning, ClaimToken: "claim-1"}
	name, _, secretName, _, err := provider.ObjectNames(resource)
	if err != nil {
		t.Fatal(err)
	}
	state := &fakeStore{resource: resource}
	runner := &fakeRunner{}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != store.StatusReady || state.readyTransitions != 1 {
		t.Fatalf("live reconcile did not mark ready after wait: %#v transitions=%d", result, state.readyTransitions)
	}
	if indexContaining(runner.calls, "kubernetes-api patch metadata secret/") < 0 || indexContaining(runner.calls, "kubectl create -f -") < 0 || indexContaining(runner.calls, "kubectl get statefulset/"+name+" --namespace org-1--demo --output=json") < 0 || indexContaining(runner.calls, "kubectl get service/"+name) < 0 {
		t.Fatalf("provider readiness must be observed before ready: %#v", runner.calls)
	}
	if indexContaining(runner.calls, "kubectl exec") >= 0 || indexContaining(runner.calls, "kubectl get secret/") >= 0 {
		t.Fatalf("kubelet readiness and create-only Secret handling must avoid cluster-wide exec/read privileges: %#v", runner.calls)
	}
	if len(runner.inputs) < 2 || !strings.Contains(runner.inputs[0], `"kind":"Namespace"`) || !strings.Contains(runner.inputs[1], `"kind":"RoleBinding"`) {
		t.Fatalf("managed namespace and its scoped tenant RoleBinding must be established before workload access: %#v", runner.inputs)
	}
	publicApply := indexContaining(runner.calls, "kubectl apply --server-side -f "+result.ManifestFile)
	secretApply := indexContaining(runner.calls, "kubectl create -f -")
	if publicApply < 0 || secretApply < 0 || secretApply > publicApply {
		t.Fatalf("credential Secret must exist before provider workload objects are applied: %#v", runner.calls)
	}
	if state.readySecretName != secretName || state.readyEndpoint == "" || state.readyClaimToken != "claim-1" {
		t.Fatalf("READY transition must persist only fenced public secret metadata: %#v", state)
	}
	if state.lastDesiredState["credentialSecretUID"] != testCredentialSecretUID || state.persistedCredentialUID != testCredentialSecretUID || state.lastDesiredState["healthManaged"] != true {
		t.Fatalf("READY state must retain the server-assigned credential Secret UID: %#v", state)
	}
	if strings.Contains(strings.Join(runner.calls, "\n"), "password") {
		t.Fatalf("secret values must not appear in command arguments: %#v", runner.calls)
	}
	if state.renewals != len(runner.calls) {
		t.Fatalf("every live Kubernetes command must renew its resource claim first: renewals=%d calls=%#v", state.renewals, runner.calls)
	}
}

func TestProviderReadinessUsesNamedGetWithoutListOrWatch(t *testing.T) {
	resource := &store.Resource{ID: "res-rbac", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusProvisioning}
	name, _, _, _, err := provider.ObjectNames(resource)
	if err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{}
	result, err := New(postgresqlLiveConfig(t.TempDir()), &fakeStore{resource: resource}, runner).RunOnce(context.Background())
	if err != nil || result.Status != store.StatusReady {
		t.Fatalf("named readiness observation must reach READY: result=%#v err=%v", result, err)
	}
	calls := strings.Join(runner.calls, "\n")
	if !strings.Contains(calls, "kubectl get statefulset/"+name) {
		t.Fatalf("readiness must poll the exact StatefulSet with name-scoped get permission: %#v", runner.calls)
	}
	if strings.Contains(calls, "kubectl rollout status") {
		t.Fatalf("rollout status requires list/watch and violates the tenant Role contract: %#v", runner.calls)
	}
}

func TestSecretCreateNamePreemptionRaceFailsClosed(t *testing.T) {
	resource := &store.Resource{ID: "res-race", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusProvisioning}
	state := &fakeStore{resource: resource}
	runner := &fakeRunner{createRace: true}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err == nil || !errors.Is(err, command.ErrAlreadyExists) || result == nil || result.Status != store.StatusFailed {
		t.Fatalf("a Secret created after the absence check must be treated as identity preemption: result=%#v err=%v", result, err)
	}
	if state.readyTransitions != 0 || state.persistedCredentialUID != "" || indexContaining(runner.calls, "kubectl apply --server-side -f "+result.ManifestFile) >= 0 {
		t.Fatalf("preempted credentials must never reach the provider workload: state=%#v calls=%#v", state, runner.calls)
	}
}

func TestSecretIsRetainedWhenIdentityPersistenceOutcomeIsUnknown(t *testing.T) {
	resource := &store.Resource{ID: "res-persist-failure", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusProvisioning}
	state := &fakeStore{resource: resource, persistFailure: errors.New("control-plane write unavailable")}
	runner := &fakeRunner{}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "control-plane write unavailable") || result == nil || result.Status != store.StatusReconciling {
		t.Fatalf("identity persistence failure must remain recoverable: result=%#v err=%v", result, err)
	}
	if hasLiveSecretDelete(runner.calls) || indexContaining(runner.calls, "kubectl apply --server-side -f "+result.ManifestFile) >= 0 {
		t.Fatalf("an ambiguous write must retain the Secret without applying its workload: calls=%#v", runner.calls)
	}
}

func TestRetryAdoptsOwnedSecretAfterProcessLossBeforeUIDPersistence(t *testing.T) {
	resource := &store.Resource{
		ID: "res-crash-recovery", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo",
		Name: "db", Engine: "postgresql", Status: store.StatusReconciling,
		DesiredState: map[string]any{"credentialSecretGeneration": testCredentialSecretGeneration},
	}
	state := &fakeStore{resource: resource}
	runner := &fakeRunner{
		secretExists:     true,
		secretUID:        testCredentialSecretUID,
		secretGeneration: testCredentialSecretGeneration,
		secretResourceID: resource.ID,
		secretProjectID:  resource.ProjectID,
	}

	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err != nil || result == nil || result.Status != store.StatusReady {
		t.Fatalf("a stale retry must adopt the exact owned Secret and reach READY: result=%#v err=%v", result, err)
	}
	if state.persistedCredentialUID != testCredentialSecretUID || state.readyTransitions != 1 {
		t.Fatalf("recovery must durably adopt only the observed Secret UID: state=%#v", state)
	}
	if indexContaining(runner.calls, "kubectl create -f -") >= 0 || hasLiveSecretDelete(runner.calls) {
		t.Fatalf("crash recovery must neither regenerate nor delete the owned Secret: %#v", runner.calls)
	}
}

func TestAmbiguousUIDPersistenceNeverDeletesAndRetryRecovers(t *testing.T) {
	resource := &store.Resource{ID: "res-ambiguous-commit", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusProvisioning}
	state := &fakeStore{
		resource:                    resource,
		persistFailure:              errors.New("database timeout after commit"),
		persistCommitsBeforeFailure: true,
	}
	runner := &fakeRunner{}
	worker := New(postgresqlLiveConfig(t.TempDir()), state, runner)

	first, firstErr := worker.RunOnce(context.Background())
	if firstErr == nil || first == nil || first.Status != store.StatusReconciling {
		t.Fatalf("ambiguous persistence must leave the claim recoverable: result=%#v err=%v", first, firstErr)
	}
	if hasLiveSecretDelete(runner.calls) {
		t.Fatalf("a timeout may have committed and must never trigger compensating deletion: %#v", runner.calls)
	}

	resource.Status = store.StatusReconciling
	resource.ClaimToken = ""
	state.resource = resource
	state.persistFailure = nil
	state.persistCommitsBeforeFailure = false
	runner.calls = nil
	second, secondErr := worker.RunOnce(context.Background())
	if secondErr != nil || second == nil || second.Status != store.StatusReady {
		t.Fatalf("the stale retry must recover an ambiguously committed UID: result=%#v err=%v", second, secondErr)
	}
	if indexContaining(runner.calls, "kubectl create -f -") >= 0 || hasLiveSecretDelete(runner.calls) {
		t.Fatalf("ambiguous-commit recovery must adopt without recreating or deleting: %#v", runner.calls)
	}
}

func TestSameNameSecretWithWrongOwnershipGenerationIsRejectedWithoutDeletion(t *testing.T) {
	resource := &store.Resource{
		ID: "res-wrong-owner", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo",
		Name: "db", Engine: "postgresql", Status: store.StatusReconciling,
		DesiredState: map[string]any{
			"credentialSecretGeneration": testCredentialSecretGeneration,
			"credentialSecretUID":        testCredentialSecretUID,
		},
	}
	state := &fakeStore{resource: resource}
	runner := &fakeRunner{
		secretExists:     true,
		secretUID:        testCredentialSecretUID,
		secretGeneration: "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE",
		secretResourceID: resource.ID,
		secretProjectID:  resource.ProjectID,
	}

	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err == nil || result == nil || result.Status == store.StatusReady {
		t.Fatalf("a same-name Secret with the wrong generation must be rejected: result=%#v err=%v", result, err)
	}
	if state.persistedCredentialUID != "" || state.readyTransitions != 0 || hasLiveSecretDelete(runner.calls) {
		t.Fatalf("an unowned Secret must never be adopted, trusted, or deleted: state=%#v calls=%#v", state, runner.calls)
	}
}

func TestLiveReconcileFailsClosedWithoutTenantAccessIdentity(t *testing.T) {
	resource := &store.Resource{ID: "res-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusProvisioning}
	state := &fakeStore{resource: resource}
	runner := &fakeRunner{}
	config := postgresqlLiveConfig(t.TempDir())
	config.ServiceAccountName = ""
	result, err := New(config, state, runner).RunOnce(context.Background())
	if err == nil || result == nil || result.Status != store.StatusFailed || len(runner.calls) != 0 {
		t.Fatalf("missing tenant identity must fail before Kubernetes mutation: result=%#v err=%v calls=%#v", result, err, runner.calls)
	}
}

func TestAuthenticatedProviderProbeFailureNeverMarksReady(t *testing.T) {
	resource := &store.Resource{ID: "res-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusProvisioning, ClaimToken: "claim-1"}
	state := &fakeStore{resource: resource}
	runner := &fakeRunner{failure: errors.New("authenticated readiness rejected"), failureNeedle: "--output=json"}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err == nil || result == nil || result.Status != store.StatusFailed {
		t.Fatalf("failed authenticated probe must fail the resource: result=%#v err=%v", result, err)
	}
	if state.readyTransitions != 0 {
		t.Fatal("an engine that rejected its credential must never be marked READY")
	}
}

func TestLiveRetryReusesImmutableProviderSecretAndStillAuthenticates(t *testing.T) {
	resource := &store.Resource{ID: "res-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Slug: "db", Engine: "postgresql", Plan: "shared-small", Status: store.StatusReconciling, ClaimToken: "claim-2", DesiredState: credentialState(nil)}
	plan, err := provider.Compile(resource, "registry.example/postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{secretExists: true, workloadOutput: []byte("statefulset.apps/" + plan.Name)}
	state := &fakeStore{resource: resource}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != store.StatusReady || state.readyTransitions != 1 {
		t.Fatalf("retry did not reach fenced READY with the existing Secret: %#v", result)
	}
	if indexContaining(runner.calls, "kubernetes-api patch metadata secret/"+plan.SecretName) < 0 || indexContaining(runner.calls, "kubectl create -f -") >= 0 {
		t.Fatalf("retry must use metadata-only identity lookup without reading or rotating credentials: %#v", runner.calls)
	}
	if indexContaining(runner.calls, "kubernetes-api delete secret/"+plan.SecretName+" --namespace "+plan.Namespace+" --uid-precondition --dry-run=server") < 0 {
		t.Fatalf("retry must prove that the existing Secret still has the persisted UID: %#v", runner.calls)
	}
	if indexContaining(runner.calls, "kubectl get statefulset/"+plan.Name+" --namespace "+plan.Namespace+" --output=json") < 0 || indexContaining(runner.calls, "kubectl exec") >= 0 {
		t.Fatalf("retry must rely on the workload's authenticated readiness probe: %#v", runner.calls)
	}
}

func TestExistingUnownedSecretWithoutPersistedUIDFailsClosed(t *testing.T) {
	resource := &store.Resource{ID: "res-unfenced", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusReconciling}
	state := &fakeStore{resource: resource}
	runner := &fakeRunner{secretExists: true}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err == nil || result == nil || result.Status != store.StatusFailed || !strings.Contains(err.Error(), "ownership") {
		t.Fatalf("an existing credential without the reserved ownership generation must fail closed: result=%#v err=%v", result, err)
	}
	if state.readyTransitions != 0 || hasLiveSecretDelete(runner.calls) || indexContaining(runner.calls, "kubectl apply --server-side -f "+result.ManifestFile) >= 0 {
		t.Fatalf("an unfenced Secret must not be attached to a provider workload: state=%#v calls=%#v", state, runner.calls)
	}
}

func TestProviderIdentityPersistenceFailurePrecedesEveryKubernetesMutation(t *testing.T) {
	resource := &store.Resource{ID: "res-identity", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "original", Name: "db", Engine: "postgresql", Status: store.StatusProvisioning}
	state := &fakeStore{resource: resource, providerIdentityFailure: errors.New("control-plane identity write unavailable")}
	runner := &fakeRunner{}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "identity write unavailable") || result == nil || result.Status != store.StatusReconciling {
		t.Fatalf("provider identity persistence failure must leave a retryable claim: result=%#v err=%v", result, err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("no Kubernetes side effect may precede durable provider identity: %#v", runner.calls)
	}
}

func TestPreReadyRetryKeepsPersistedProviderIdentityAfterProjectSlugChange(t *testing.T) {
	resource := &store.Resource{
		ID: "res-retry", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "renamed", Name: "db", Engine: "postgresql", Status: store.StatusReconciling,
		DesiredState: credentialState(map[string]any{"providerIdentity": map[string]any{"namespace": "org-1--original", "name": "res-retry-0123456789ab"}}),
	}
	state := &fakeStore{resource: resource}
	runner := &fakeRunner{secretExists: true}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err != nil || result == nil || result.Status != store.StatusReady {
		t.Fatalf("pre-READY retry must use its durable object identity: result=%#v err=%v", result, err)
	}
	joined := strings.Join(runner.calls, "\n")
	if !strings.Contains(joined, "--namespace org-1--original") || strings.Contains(joined, "--namespace org-1--renamed") {
		t.Fatalf("retry drifted to the mutable project slug: %#v", runner.calls)
	}
}

func TestReplacementSecretUIDMismatchFailsBeforeWorkloadMutation(t *testing.T) {
	resource := &store.Resource{ID: "res-replaced", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusReconciling, DesiredState: credentialState(nil)}
	state := &fakeStore{resource: resource}
	runner := &fakeRunner{secretExists: true, replacementUIDMismatch: true}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err == nil || result == nil || result.Status != store.StatusFailed || !strings.Contains(err.Error(), "UID") {
		t.Fatalf("a same-name replacement Secret must fail its UID fence: result=%#v err=%v", result, err)
	}
	if state.readyTransitions != 0 || indexContaining(runner.calls, "kubectl apply --server-side -f "+result.ManifestFile) >= 0 {
		t.Fatalf("replacement credentials must be rejected before workload mutation: state=%#v calls=%#v", state, runner.calls)
	}
}

func TestMissingSecretForExistingProviderWorkloadFailsClosed(t *testing.T) {
	resource := &store.Resource{ID: "res-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Slug: "db", Engine: "postgresql", Status: store.StatusReconciling, ClaimToken: "claim-3"}
	plan, err := provider.Compile(resource, "registry.example/postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{workloadOutput: []byte("statefulset.apps/" + plan.Name)}
	state := &fakeStore{resource: resource}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err == nil || result == nil || result.Status != store.StatusFailed {
		t.Fatalf("missing Secret for an initialized provider must fail closed, result=%#v err=%v", result, err)
	}
	if state.readyTransitions != 0 || indexContaining(runner.calls, "kubectl create -f -") >= 0 {
		t.Fatalf("missing credential must never be silently regenerated for existing data: state=%#v calls=%#v", state, runner.calls)
	}
}

func TestMissingSecretForRetainedProviderPVCFailsClosed(t *testing.T) {
	resource := &store.Resource{ID: "res-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Slug: "db", Engine: "postgresql", Status: store.StatusReconciling, ClaimToken: "claim-4"}
	plan, err := provider.Compile(resource, "registry.example/postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{pvcOutput: []byte("persistentvolumeclaim/" + plan.PVCName)}
	state := &fakeStore{resource: resource}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err == nil || result == nil || result.Status != store.StatusFailed {
		t.Fatalf("missing Secret for retained provider data must fail closed, result=%#v err=%v", result, err)
	}
	if state.readyTransitions != 0 || indexContaining(runner.calls, "kubectl create -f -") >= 0 {
		t.Fatalf("retained data must never receive regenerated credentials: state=%#v calls=%#v", state, runner.calls)
	}
}

func TestReadyProviderIsPeriodicallyRevalidatedWithoutMutatingWorkload(t *testing.T) {
	resource := &store.Resource{ID: "res-health", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusReady, DesiredState: credentialState(nil)}
	state := &fakeStore{healthResource: resource}
	runner := &fakeRunner{secretExists: true}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != store.StatusReady || state.readyTransitions != 1 || state.healthClaims != 1 {
		t.Fatalf("healthy READY provider must be revalidated and remain READY: result=%#v state=%#v", result, state)
	}
	for _, expected := range []string{"kubernetes-api patch metadata secret/", "kubectl get statefulset/", "--output=json", "kubectl get service/"} {
		if indexContaining(runner.calls, expected) < 0 {
			t.Fatalf("health reconciliation is missing %q: %#v", expected, runner.calls)
		}
	}
	for _, forbidden := range []string{"kubectl create -f -", "kubectl apply", "kubectl exec", "kubectl get secret/"} {
		if indexContaining(runner.calls, forbidden) >= 0 {
			t.Fatalf("health reconciliation must be read-only for provider state (%s): %#v", forbidden, runner.calls)
		}
	}
}

func TestReadyProviderHealthUsesOwnedMetadataObservationCompatibleWithAdmission(t *testing.T) {
	resource := &store.Resource{
		ID: "res-health-owned", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo",
		Name: "db", Engine: "postgresql", Status: store.StatusReady,
		DesiredState: credentialState(map[string]any{"credentialSecretGeneration": testCredentialSecretGeneration}),
	}
	state := &fakeStore{healthResource: resource}
	runner := &fakeRunner{
		secretExists:     true,
		secretUID:        testCredentialSecretUID,
		secretGeneration: testCredentialSecretGeneration,
		secretResourceID: resource.ID,
		secretProjectID:  resource.ProjectID,
	}

	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err != nil || result == nil || result.Status != store.StatusReady {
		t.Fatalf("owned metadata health observation must remain READY: result=%#v err=%v", result, err)
	}
	if indexContaining(runner.calls, "kubernetes-api patch metadata secret/") < 0 {
		t.Fatalf("health must use the admission-compatible metadata-only dry-run PATCH: %#v", runner.calls)
	}
	if indexContaining(runner.calls, "kubectl create --dry-run=server -f -") >= 0 {
		t.Fatalf("health must not submit a second Secret CREATE admission request: %#v", runner.calls)
	}
}

func TestReadyProviderHealthKeepsPersistedNamespaceAfterProjectSlugChange(t *testing.T) {
	resource := &store.Resource{
		ID: "res-health", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "renamed", Name: "db", Engine: "postgresql", Status: store.StatusReady,
		DesiredState: credentialState(map[string]any{"providerResult": map[string]any{"namespace": "org-1--original"}}),
	}
	state := &fakeStore{healthResource: resource}
	runner := &fakeRunner{secretExists: true}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err != nil || result.Status != store.StatusReady {
		t.Fatalf("slug changes must not detach health reconciliation from the existing provider namespace: result=%#v err=%v", result, err)
	}
	joined := strings.Join(runner.calls, "\n")
	if !strings.Contains(joined, "--namespace org-1--original") || strings.Contains(joined, "--namespace org-1--renamed") {
		t.Fatalf("health reconciliation used a mutable project slug instead of persisted provider identity: %#v", runner.calls)
	}
}

func TestReadyProviderWithMissingSecretIsDowngradedWithoutCredentialRegeneration(t *testing.T) {
	resource := &store.Resource{ID: "res-health", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusReady, DesiredState: credentialState(nil)}
	state := &fakeStore{healthResource: resource}
	runner := &fakeRunner{}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if err == nil || result == nil || result.Status != store.StatusFailed || state.nextStatus != store.StatusFailed {
		t.Fatalf("missing READY credential must downgrade health: result=%#v err=%v state=%#v", result, err, state)
	}
	if indexContaining(runner.calls, "kubectl create -f -") >= 0 || indexContaining(runner.calls, "kubectl apply") >= 0 {
		t.Fatalf("health reconciliation must never regenerate credentials or mutate workloads: %#v", runner.calls)
	}
}

func TestReadyProviderWithReplacementSecretIsImmediatelyDowngraded(t *testing.T) {
	resource := &store.Resource{ID: "res-health-replaced", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusReady, DesiredState: credentialState(nil)}
	state := &fakeStore{healthResource: resource}
	runner := &fakeRunner{secretExists: true, replacementUIDMismatch: true}
	result, err := New(postgresqlLiveConfig(t.TempDir()), state, runner).RunOnce(context.Background())
	if !errors.Is(err, command.ErrSecretUIDMismatch) || result == nil || result.Status != store.StatusFailed || state.nextStatus != store.StatusFailed {
		t.Fatalf("same-name Secret replacement is an immediate integrity failure: result=%#v err=%v state=%#v", result, err, state)
	}
	if indexContaining(runner.calls, "kubectl get statefulset/") >= 0 {
		t.Fatalf("replacement credentials must be rejected before workload health is trusted: %#v", runner.calls)
	}
}

func TestCredentialIntegrityClassificationKeepsRateLimitsTransient(t *testing.T) {
	for _, statusCode := range []int{408, 425, 429, 500, 503} {
		if credentialIntegrityFailure(&command.KubernetesAPIError{StatusCode: statusCode}) {
			t.Fatalf("HTTP %d is transient and must use the consecutive-failure threshold", statusCode)
		}
	}
	for _, statusCode := range []int{400, 401, 403, 404, 409, 422} {
		if !credentialIntegrityFailure(&command.KubernetesAPIError{StatusCode: statusCode}) {
			t.Fatalf("HTTP %d is a credential integrity/configuration failure", statusCode)
		}
	}
}

func TestTransientHealthFailureRequiresConsecutiveFailuresAndCanRecover(t *testing.T) {
	resource := &store.Resource{ID: "res-health", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusReady, DesiredState: credentialState(nil)}
	plan, err := provider.Compile(resource, "registry.example/postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err != nil {
		t.Fatal(err)
	}
	resource.ConnectionSecretName = plan.SecretName
	state := &fakeStore{lastDesiredState: credentialState(nil)}
	runner := &fakeRunner{secretExists: true, failure: errors.New("temporary Kubernetes API timeout"), failureNeedle: "--output=json"}
	worker := New(postgresqlLiveConfig(t.TempDir()), state, runner)
	for attempt := 1; attempt <= 3; attempt++ {
		resource.Status = store.StatusReady
		resource.DesiredState = cloneMap(state.lastDesiredState)
		state.healthResource = resource
		result, runErr := worker.RunOnce(context.Background())
		if runErr == nil {
			t.Fatalf("attempt %d must report the transient health error", attempt)
		}
		expectedStatus := store.StatusReady
		if attempt == 3 {
			expectedStatus = store.StatusFailed
		}
		if result.Status != expectedStatus || state.nextStatus != expectedStatus {
			t.Fatalf("attempt %d transitioned too aggressively: result=%#v state=%#v", attempt, result, state)
		}
	}
	if count, _ := state.lastDesiredState["healthFailureCount"].(int); count != 3 {
		t.Fatalf("consecutive health failure count was not persisted: %#v", state.lastDesiredState)
	}

	runner.failure = nil
	resource.Status = store.StatusFailed
	resource.DesiredState = cloneMap(state.lastDesiredState)
	state.healthResource = resource
	recovered, err := worker.RunOnce(context.Background())
	if err != nil || recovered.Status != store.StatusReady || state.nextStatus != store.StatusReady {
		t.Fatalf("health-managed FAILED resource must be recoverable: result=%#v err=%v state=%#v", recovered, err, state)
	}
}

func TestCorruptPersistedHealthFailureCountsFailClosed(t *testing.T) {
	for name, value := range map[string]json.Number{
		"malformed":    json.Number("not-a-number"),
		"negative":     json.Number("-1"),
		"out-of-range": json.Number("9223372036854775808"),
	} {
		t.Run(name, func(t *testing.T) {
			got := consecutiveHealthFailures(map[string]any{"healthFailureCount": value})
			if got != healthFailureThreshold-1 {
				t.Fatalf("corrupt persisted count must make the next failure reach the threshold: got=%d", got)
			}
		})
	}
	if got := consecutiveHealthFailures(map[string]any{"healthFailureCount": json.Number("2")}); got != 2 {
		t.Fatalf("valid persisted count changed: got=%d", got)
	}
}

func TestHealthCompileFailureRemainsRecoverableAfterConfigurationRepair(t *testing.T) {
	resource := &store.Resource{ID: "res-health-config", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusReady, DesiredState: credentialState(nil)}
	plan, err := provider.Compile(resource, "registry.example/postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err != nil {
		t.Fatal(err)
	}
	resource.ConnectionSecretName = plan.SecretName
	state := &fakeStore{healthResource: resource}
	runner := &fakeRunner{secretExists: true}
	config := postgresqlLiveConfig(t.TempDir())
	config.Images = map[string]string{}
	worker := New(config, state, runner)
	failed, runErr := worker.RunOnce(context.Background())
	if runErr == nil || failed.Status != store.StatusFailed || state.lastDesiredState["healthManaged"] != true {
		t.Fatalf("temporary provider configuration failure must remain health-managed: result=%#v err=%v state=%#v", failed, runErr, state)
	}

	worker.config.Images = postgresqlLiveConfig(t.TempDir()).Images
	resource.Status = store.StatusFailed
	resource.DesiredState = cloneMap(state.lastDesiredState)
	state.healthResource = resource
	recovered, runErr := worker.RunOnce(context.Background())
	if runErr != nil || recovered.Status != store.StatusReady {
		t.Fatalf("configuration repair must recover the health-managed resource: result=%#v err=%v", recovered, runErr)
	}
}

func TestLiveProvidersWithoutPrimitiveBootstrapFailClosed(t *testing.T) {
	for _, engine := range []string{"object-storage", "qdrant", "nats"} {
		t.Run(engine, func(t *testing.T) {
			resource := &store.Resource{ID: "res-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "resource", Engine: engine, Status: store.StatusProvisioning, ClaimToken: "claim-1"}
			state := &fakeStore{resource: resource}
			runner := &fakeRunner{}
			result, err := New(Config{DryRun: false, OutputDir: t.TempDir(), Images: map[string]string{engine: "registry.example/provider@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}, state, runner).RunOnce(context.Background())
			var unavailable *provider.CapabilityUnavailableError
			if !errors.As(err, &unavailable) || result == nil || result.Status != store.StatusFailed {
				t.Fatalf("%s live provisioning must fail closed before truthful primitive readiness exists: result=%#v err=%v", engine, result, err)
			}
			if state.readyTransitions != 0 || len(runner.calls) != 0 {
				t.Fatalf("%s must not create partial live provider objects: state=%#v calls=%#v", engine, state, runner.calls)
			}
		})
	}
}

type fakeStore struct {
	resource                     *store.Resource
	healthResource               *store.Resource
	deletion                     *store.Resource
	nextStatus                   string
	readyTransitions             int
	finalized                    int
	provisionClaims              int
	healthClaims                 int
	readySecretName              string
	readyEndpoint                string
	readyClaimToken              string
	finalizedClaimToken          string
	lastDesiredState             map[string]any
	persistedCredentialUID       string
	reservedCredentialGeneration string
	persistedProviderNS          string
	persistedProviderName        string
	renewals                     int
	persistFailure               error
	persistCommitsBeforeFailure  bool
	providerIdentityFailure      error
	transitionFailure            error
}

func (s *fakeStore) ClaimNextResourceDeletion(context.Context, time.Duration, time.Duration) (*store.Resource, error) {
	resource := s.deletion
	s.deletion = nil
	if resource != nil && resource.ClaimToken == "" {
		resource.ClaimToken = "deletion-claim"
	}
	return resource, nil
}

func (s *fakeStore) ClaimNextResource(context.Context, time.Duration, time.Duration) (*store.Resource, error) {
	s.provisionClaims++
	resource := s.resource
	s.resource = nil
	if resource != nil && resource.ClaimToken == "" {
		resource.ClaimToken = "provision-claim"
	}
	return resource, nil
}

func (s *fakeStore) ClaimNextReadyResource(context.Context, time.Duration) (*store.Resource, error) {
	s.healthClaims++
	resource := s.healthResource
	s.healthResource = nil
	if resource != nil {
		resource.Status = store.StatusReconciling
		resource.ClaimToken = "health-claim"
	}
	return resource, nil
}

func (s *fakeStore) FinalizeResourceDeletion(_ context.Context, resource *store.Resource) error {
	if resource == nil || resource.ClaimToken == "" {
		panic("deletion finalization must carry a claim token")
	}
	s.finalized++
	s.finalizedClaimToken = resource.ClaimToken
	return nil
}

func (s *fakeStore) RenewResourceClaim(_ context.Context, resource *store.Resource) error {
	if resource == nil || resource.ClaimToken == "" {
		panic("claim renewal must carry a claim token")
	}
	s.renewals++
	return nil
}

func (s *fakeStore) PersistProviderIdentity(_ context.Context, resource *store.Resource, namespace, name string) error {
	if resource == nil || resource.ClaimToken == "" {
		panic("provider object identity persistence must carry a claim token")
	}
	if s.providerIdentityFailure != nil {
		return s.providerIdentityFailure
	}
	s.persistedProviderNS = namespace
	s.persistedProviderName = name
	identity := map[string]any{"namespace": namespace, "name": name}
	resource.DesiredState = mergeState(resource.DesiredState, map[string]any{"providerIdentity": identity})
	return nil
}

func (s *fakeStore) ReserveCredentialSecretGeneration(_ context.Context, resource *store.Resource, generation string) error {
	if resource == nil || resource.ClaimToken == "" {
		panic("credential generation reservation must carry a claim token")
	}
	s.reservedCredentialGeneration = generation
	resource.DesiredState = mergeState(resource.DesiredState, map[string]any{"credentialSecretGeneration": generation})
	return nil
}

func (s *fakeStore) PersistCredentialSecretUID(_ context.Context, resource *store.Resource, uid string) error {
	if resource == nil || resource.ClaimToken == "" {
		panic("credential identity persistence must carry a claim token")
	}
	if s.persistFailure != nil && !s.persistCommitsBeforeFailure {
		return s.persistFailure
	}
	s.persistedCredentialUID = uid
	resource.DesiredState = mergeState(resource.DesiredState, map[string]any{"credentialSecretUID": uid})
	return s.persistFailure
}

func (s *fakeStore) TransitionResource(_ context.Context, resource *store.Resource, expectedStatus, nextStatus string, desiredState map[string]any) error {
	if expectedStatus != store.StatusReconciling {
		if expectedStatus != store.StatusDeleting {
			panic("transition must be conditional on claimed status")
		}
	}
	if resource == nil || resource.ClaimToken == "" {
		panic("transition must carry a claim token")
	}
	s.nextStatus = nextStatus
	s.lastDesiredState = cloneMap(desiredState)
	if s.transitionFailure != nil {
		return s.transitionFailure
	}
	if nextStatus == store.StatusReady {
		s.readyTransitions++
	}
	return nil
}

func (s *fakeStore) MarkResourceReady(_ context.Context, resource *store.Resource, provider, secretName, endpoint string, _ []string, desiredState map[string]any) error {
	if resource.Status != store.StatusProvisioning && resource.Status != store.StatusReconciling {
		panic("ready transition requires a claimed resource")
	}
	s.readyTransitions++
	s.nextStatus = store.StatusReady
	s.readySecretName = secretName
	s.readyEndpoint = endpoint
	s.readyClaimToken = resource.ClaimToken
	s.lastDesiredState = cloneMap(desiredState)
	return nil
}

func cloneMap(input map[string]any) map[string]any {
	if input == nil {
		return map[string]any{}
	}
	result := make(map[string]any, len(input))
	for key, value := range input {
		result[key] = value
	}
	return result
}

type fakeRunner struct {
	appliedWorkload        []byte
	calls                  []string
	inputs                 []string
	failure                error
	failureNeedle          string
	secretExists           bool
	namespaceExists        bool
	workloadOutput         []byte
	pvcOutput              []byte
	createRace             bool
	replacementUIDMismatch bool
	secretUID              string
	secretGeneration       string
	secretResourceID       string
	secretProjectID        string
	secretName             string
	secretNamespace        string
	secretLabels           map[string]string
	secretAnnotations      map[string]string
}

func (r *fakeRunner) callError(call string) error {
	if r.failure != nil && (r.failureNeedle == "" || strings.Contains(call, r.failureNeedle)) {
		return r.failure
	}
	return nil
}

func (r *fakeRunner) Run(_ context.Context, name string, args []string, _ bool, _ time.Duration) (string, error) {
	call := name + " " + strings.Join(args, " ")
	r.calls = append(r.calls, call)
	return call, r.callError(call)
}

func (r *fakeRunner) RunInput(_ context.Context, name string, args []string, input []byte, _ bool, _ time.Duration) (string, error) {
	call := name + " " + strings.Join(args, " ")
	r.calls = append(r.calls, call)
	r.inputs = append(r.inputs, string(input))
	if strings.Contains(string(input), "provider-secret-password") {
		panic("test secret was exposed through deterministic fixture")
	}
	return call, r.callError(call)
}

func (r *fakeRunner) RunSensitiveOutput(_ context.Context, name string, args []string, _ time.Duration) (string, []byte, error) {
	call := name + " " + strings.Join(args, " ")
	r.calls = append(r.calls, call)
	if strings.Contains(call, "kubectl apply") && strings.Contains(call, "--output=json") {
		payload, err := os.ReadFile(args[3])
		if err != nil {
			return call, nil, err
		}
		var manifest struct {
			Items []map[string]any `json:"items"`
		}
		if err := json.Unmarshal(payload, &manifest); err != nil {
			return call, nil, err
		}
		for _, item := range manifest.Items {
			if item["kind"] != "StatefulSet" {
				continue
			}
			item["metadata"].(map[string]any)["uid"] = provenanceUID
			item["metadata"].(map[string]any)["generation"] = 1
			item["status"] = map[string]any{"observedGeneration": 1, "replicas": 1, "readyReplicas": 1, "updatedReplicas": 1, "currentRevision": "revision-1", "updateRevision": "revision-1"}
			r.appliedWorkload, err = json.Marshal(item)
			if err != nil {
				return call, nil, err
			}
		}
		return call, r.appliedWorkload, r.callError(call)
	}
	if strings.Contains(call, "kubectl get statefulset/") && strings.Contains(call, "--output=json") {
		if r.appliedWorkload != nil {
			return call, r.appliedWorkload, r.callError(call)
		}
		return call, []byte(`{"metadata":{"generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"replicas":1,"readyReplicas":1,"updatedReplicas":1,"currentRevision":"revision-1","updateRevision":"revision-1"}}`), r.callError(call)
	}
	if strings.Contains(call, "kubectl get namespace/") {
		if r.namespaceExists {
			return call, []byte("namespace/tenant"), r.callError(call)
		}
		return call, nil, r.callError(call)
	}
	if strings.Contains(call, "jsonpath={.metadata.uid}") {
		return call, []byte(testCredentialSecretUID), r.callError(call)
	}
	if strings.Contains(call, "kubectl get persistentvolumeclaim/") {
		return call, append([]byte(nil), r.pvcOutput...), r.callError(call)
	}
	return call, append([]byte(nil), r.workloadOutput...), r.callError(call)
}

func (r *fakeRunner) RunCreateInput(_ context.Context, name string, args []string, _ []byte, _ time.Duration) (string, error) {
	call := name + " " + strings.Join(args, " ")
	r.calls = append(r.calls, call)
	if err := r.callError(call); err != nil {
		return call, err
	}
	if r.secretExists {
		return call, command.ErrAlreadyExists
	}
	if !strings.Contains(call, "--dry-run=server") {
		r.secretExists = true
	}
	return call, nil
}

func (r *fakeRunner) RunCreateInputUID(_ context.Context, name string, args []string, input []byte, _ time.Duration) (string, string, error) {
	call := name + " " + strings.Join(args, " ")
	r.calls = append(r.calls, call)
	if err := r.callError(call); err != nil {
		return call, "", err
	}
	if r.createRace {
		r.secretExists = true
		return call, "", command.ErrAlreadyExists
	}
	if r.secretExists {
		return call, "", command.ErrAlreadyExists
	}
	r.secretExists = true
	var manifest struct {
		Metadata struct {
			Name        string            `json:"name"`
			Namespace   string            `json:"namespace"`
			Labels      map[string]string `json:"labels"`
			Annotations map[string]string `json:"annotations"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(input, &manifest); err != nil {
		return call, "", err
	}
	r.secretName = manifest.Metadata.Name
	r.secretNamespace = manifest.Metadata.Namespace
	r.secretLabels = manifest.Metadata.Labels
	r.secretAnnotations = manifest.Metadata.Annotations
	if r.secretUID == "" {
		r.secretUID = testCredentialSecretUID
	}
	return call, r.secretUID, nil
}

func (r *fakeRunner) GetSecretMetadata(_ context.Context, namespace, secretName string, _ time.Duration) (string, *command.SecretMetadata, error) {
	call := "kubernetes-api patch metadata secret/" + secretName + " --namespace " + namespace + " --dry-run=server"
	r.calls = append(r.calls, call)
	if err := r.callError(call); err != nil {
		return call, nil, err
	}
	if !r.secretExists {
		return call, nil, command.ErrSecretNotFound
	}
	uid := r.secretUID
	if uid == "" {
		uid = testCredentialSecretUID
	}
	name := r.secretName
	if name == "" {
		name = secretName
	}
	secretNamespace := r.secretNamespace
	if secretNamespace == "" {
		secretNamespace = namespace
	}
	labels := cloneStringMap(r.secretLabels)
	annotations := cloneStringMap(r.secretAnnotations)
	if r.secretResourceID != "" || r.secretProjectID != "" || r.secretGeneration != "" {
		labels = map[string]string{
			"app.kubernetes.io/name":       strings.TrimSuffix(secretName, "-connection"),
			"app.kubernetes.io/managed-by": "raibitserver",
			"raibitserver.io/managed":      "true",
			"raibitserver.io/project-id":   r.secretProjectID,
			"raibitserver.io/resource-id":  r.secretResourceID,
			"raibitserver.io/provider":     "postgresql",
		}
		annotations = map[string]string{
			"raibitserver.io/credential-owner":      "raibitserver-provisioner",
			"raibitserver.io/credential-generation": r.secretGeneration,
			"raibitserver.io/resource-id":           r.secretResourceID,
			"raibitserver.io/project-id":            r.secretProjectID,
		}
	}
	return call, &command.SecretMetadata{UID: uid, Name: name, Namespace: secretNamespace, Labels: labels, Annotations: annotations}, nil
}

func (r *fakeRunner) VerifySecretUID(_ context.Context, namespace, secretName, uid string, _ time.Duration) (string, error) {
	call := "kubernetes-api delete secret/" + secretName + " --namespace " + namespace + " --uid-precondition --dry-run=server"
	r.calls = append(r.calls, call)
	if err := r.callError(call); err != nil {
		return call, err
	}
	if r.replacementUIDMismatch || uid != testCredentialSecretUID {
		return call, command.ErrSecretUIDMismatch
	}
	return call, nil
}

func (r *fakeRunner) DeleteSecretUID(_ context.Context, namespace, secretName, uid string, _ time.Duration) (string, error) {
	call := "kubernetes-api delete secret/" + secretName + " --namespace " + namespace + " --uid-precondition"
	r.calls = append(r.calls, call)
	if err := r.callError(call); err != nil {
		return call, err
	}
	if r.replacementUIDMismatch || uid != testCredentialSecretUID {
		return call, command.ErrSecretUIDMismatch
	}
	return call, nil
}

func (r *fakeRunner) DeleteObjectUID(_ context.Context, resource, namespace, name, uid string, _ time.Duration) (string, error) {
	call := "kubernetes-api delete " + resource + "/" + name + " --namespace " + namespace + " --uid-precondition"
	r.calls = append(r.calls, call)
	if err := r.callError(call); err != nil {
		return call, err
	}
	if uid != testCredentialSecretUID {
		return call, command.ErrSecretUIDMismatch
	}
	return call, nil
}

func indexContaining(values []string, needle string) int {
	for index, value := range values {
		if strings.Contains(value, needle) {
			return index
		}
	}
	return -1
}

func lastIndexContaining(values []string, needle string) int {
	for index := len(values) - 1; index >= 0; index-- {
		if strings.Contains(values[index], needle) {
			return index
		}
	}
	return -1
}

func cloneStringMap(input map[string]string) map[string]string {
	if input == nil {
		return map[string]string{}
	}
	result := make(map[string]string, len(input))
	for key, value := range input {
		result[key] = value
	}
	return result
}

func hasLiveSecretDelete(calls []string) bool {
	for _, call := range calls {
		if strings.Contains(call, "kubernetes-api delete secret/") && !strings.Contains(call, "--dry-run=server") {
			return true
		}
	}
	return false
}
