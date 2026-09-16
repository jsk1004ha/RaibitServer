package reconciler

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"github.com/raibitserver/provisioner/internal/command"
	"github.com/raibitserver/provisioner/internal/provider"
	"github.com/raibitserver/provisioner/internal/store"
)

type Config struct {
	DryRun                  bool
	OutputDir               string
	Timeout                 time.Duration
	ClaimLease              time.Duration
	HealthInterval          time.Duration
	DryRunRecheck           time.Duration
	Images                  map[string]string
	ServiceAccountName      string
	ServiceAccountNamespace string
	TenantRoleName          string
}

type Result struct {
	Processed    int    `json:"processed"`
	ResourceID   string `json:"resourceId,omitempty"`
	Status       string `json:"status,omitempty"`
	ManifestFile string `json:"manifestFile,omitempty"`
	Command      string `json:"command,omitempty"`
	DryRun       bool   `json:"dryRun"`
}

type Reconciler struct {
	config           Config
	store            store.Store
	runner           command.Runner
	preferHealthNext atomic.Bool
	preferWorkNext   atomic.Bool
}

func New(config Config, state store.Store, runner command.Runner) *Reconciler {
	if config.OutputDir == "" {
		config.OutputDir = filepath.Join(os.TempDir(), "raibitserver-provisioner")
	}
	if config.Timeout <= 0 {
		config.Timeout = 10 * time.Minute
	}
	if config.HealthInterval <= 0 {
		config.HealthInterval = 5 * time.Minute
	}
	if config.DryRunRecheck <= 0 {
		config.DryRunRecheck = 5 * time.Second
	}
	minimumClaimLease := 2*config.Timeout + time.Minute
	if config.ClaimLease < minimumClaimLease {
		config.ClaimLease = minimumClaimLease
	}
	if runner == nil {
		runner = &command.OSRunner{}
	}
	return &Reconciler{config: config, store: state, runner: runner}
}

func (r *Reconciler) RunOnce(ctx context.Context) (*Result, error) {
	deletionDeferred := r.preferWorkNext.Swap(false)
	if !deletionDeferred {
		deletion, err := r.store.ClaimNextResourceDeletion(ctx, r.config.ClaimLease, r.dryRunRecheck())
		if err != nil {
			return nil, err
		}
		if deletion != nil {
			r.preferWorkNext.Store(true)
			return r.reconcileDeletion(ctx, deletion)
		}
	}
	healthChecked := false
	if !r.config.DryRun && r.preferHealthNext.Swap(false) {
		healthChecked = true
		healthResource, healthErr := r.store.ClaimNextReadyResource(ctx, r.config.HealthInterval)
		if healthErr != nil {
			return nil, healthErr
		}
		if healthResource != nil {
			return r.reconcileHealth(ctx, healthResource)
		}
	}
	resource, err := r.store.ClaimNextResource(ctx, r.config.ClaimLease, r.dryRunRecheck())
	if err != nil {
		return nil, err
	}
	if resource == nil {
		if !r.config.DryRun && !healthChecked {
			healthResource, healthErr := r.store.ClaimNextReadyResource(ctx, r.config.HealthInterval)
			if healthErr != nil {
				return nil, healthErr
			}
			if healthResource != nil {
				return r.reconcileHealth(ctx, healthResource)
			}
		}
		if deletionDeferred {
			deletion, deletionErr := r.store.ClaimNextResourceDeletion(ctx, r.config.ClaimLease, r.dryRunRecheck())
			if deletionErr != nil {
				return nil, deletionErr
			}
			if deletion != nil {
				return r.reconcileDeletion(ctx, deletion)
			}
		}
		return &Result{DryRun: r.config.DryRun}, nil
	}
	if !r.config.DryRun {
		r.preferHealthNext.Store(true)
	}
	image := r.providerImage(resource.Engine)
	if image == "" && r.config.DryRun {
		image = "registry.invalid/raibitserver/" + slug(resource.Engine) + "@sha256:" + strings.Repeat("0", 64)
	}
	plan, err := provider.Compile(resource, image)
	if err != nil {
		return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, DryRun: r.config.DryRun}, r.fail(ctx, resource, err)
	}
	if !r.config.DryRun && requiresPrimitiveBootstrap(plan.Engine) {
		err = fmt.Errorf("live %s provisioning is disabled until authenticated primitive bootstrap is implemented", plan.Engine)
		return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, DryRun: false}, r.fail(ctx, resource, err)
	}
	if !r.config.DryRun && len(plan.ProbeCommand) == 0 {
		err = fmt.Errorf("provider %s has no authenticated readiness probe", plan.Engine)
		return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, DryRun: false}, r.fail(ctx, resource, err)
	}
	credentialGeneration := ""
	if !r.config.DryRun {
		if err := r.store.PersistProviderIdentity(ctx, resource, plan.Namespace, plan.Name); err != nil {
			return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusReconciling, DryRun: false}, err
		}
		credentialGeneration, err = r.reserveCredentialSecretGeneration(ctx, resource)
		if err != nil {
			return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusReconciling, DryRun: false}, err
		}
	}

	manifestItems := plan.PublicManifests
	if !r.config.DryRun {
		manifestItems = plan.PublicManifests[1:]
	}
	manifest := map[string]any{"apiVersion": "v1", "kind": "List", "items": manifestItems}
	manifestFile, err := r.writeManifest(resource.ID, manifest)
	if err != nil {
		return nil, r.fail(ctx, resource, err)
	}
	if r.config.DryRun {
		applyCommand, applyErr := r.runner.Run(ctx, "kubectl", []string{"apply", "--server-side", "-f", manifestFile}, true, r.config.Timeout)
		if applyErr != nil {
			return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, ManifestFile: manifestFile, Command: applyCommand, DryRun: true}, r.fail(ctx, resource, applyErr)
		}
		desiredState := mergeState(resource.DesiredState, map[string]any{"lastDryRunPlan": publicProviderPlan(plan), "lastDryRunAt": time.Now().UTC().Format(time.RFC3339Nano)})
		if err := r.store.TransitionResource(ctx, resource, store.StatusReconciling, store.StatusProvisioning, desiredState); err != nil {
			return nil, err
		}
		return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusProvisioning, ManifestFile: manifestFile, Command: applyCommand, DryRun: true}, nil
	}
	runner := r.runnerFor(resource)

	roleBinding, err := plan.TenantAccessManifest(r.config.ServiceAccountName, r.config.ServiceAccountNamespace, r.config.TenantRoleName)
	if err != nil {
		return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, ManifestFile: manifestFile, DryRun: false}, r.fail(ctx, resource, err)
	}
	bootstrapManifests := []map[string]any{plan.PublicManifests[0], roleBinding}
	applyCommand := ""
	for _, bootstrapManifest := range bootstrapManifests {
		payload, marshalErr := json.Marshal(bootstrapManifest)
		if marshalErr != nil {
			return nil, r.fail(ctx, resource, marshalErr)
		}
		applyCommand, err = runner.RunInput(ctx, "kubectl", []string{"apply", "--server-side", "-f", "-"}, payload, false, r.config.Timeout)
		if err != nil {
			return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, ManifestFile: manifestFile, Command: applyCommand, DryRun: false}, r.fail(ctx, resource, err)
		}
	}

	workloadCommand, workloadOutput, workloadErr := runner.RunSensitiveOutput(ctx, "kubectl", []string{"get", "statefulset/" + plan.Name, "--namespace", plan.Namespace, "--ignore-not-found", "-o", "name"}, r.config.Timeout)
	if workloadErr != nil {
		return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, ManifestFile: manifestFile, Command: workloadCommand, DryRun: false}, r.fail(ctx, resource, workloadErr)
	}
	workloadExists := len(strings.TrimSpace(string(workloadOutput))) > 0
	pvcCommand, pvcOutput, pvcErr := runner.RunSensitiveOutput(ctx, "kubectl", []string{"get", "persistentvolumeclaim/" + plan.PVCName, "--namespace", plan.Namespace, "--ignore-not-found", "-o", "name"}, r.config.Timeout)
	if pvcErr != nil {
		return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, ManifestFile: manifestFile, Command: pvcCommand, DryRun: false}, r.fail(ctx, resource, pvcErr)
	}
	providerDataExists := len(strings.TrimSpace(string(pvcOutput))) > 0
	secretCommand, secretMetadata, secretErr := runner.GetSecretMetadata(ctx, plan.Namespace, plan.SecretName, r.config.Timeout)
	secretExists := secretErr == nil
	if secretErr != nil && !errors.Is(secretErr, command.ErrSecretNotFound) {
		return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, ManifestFile: manifestFile, Command: secretCommand, DryRun: false}, r.fail(ctx, resource, secretErr)
	}
	persistedCredentialUID, persistedUIDErr := optionalCredentialSecretUID(resource.DesiredState)
	if persistedUIDErr != nil {
		return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, ManifestFile: manifestFile, Command: secretCommand, DryRun: false}, r.fail(ctx, resource, persistedUIDErr)
	}
	if !secretExists && (workloadExists || providerDataExists || persistedCredentialUID != "") {
		err = fmt.Errorf("provider workload or retained data for %s/%s exists without its immutable credential Secret; refusing credential regeneration", plan.Namespace, plan.Name)
		return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, ManifestFile: manifestFile, Command: secretCommand, DryRun: false}, r.fail(ctx, resource, err)
	}
	credentialUID := ""
	if secretExists {
		credentialUID, err = validateCredentialSecretMetadata(resource, plan, credentialGeneration, persistedCredentialUID, secretMetadata)
		if err != nil {
			return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, ManifestFile: manifestFile, Command: secretCommand, DryRun: false}, r.fail(ctx, resource, err)
		}
	} else {
		secretManifest, manifestErr := plan.OwnedSecretManifest(resource.ID, resource.ProjectID, credentialGeneration)
		if manifestErr != nil {
			return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, ManifestFile: manifestFile, Command: secretCommand, DryRun: false}, r.fail(ctx, resource, manifestErr)
		}
		secretPayload, marshalErr := json.Marshal(secretManifest)
		if marshalErr != nil {
			return nil, r.fail(ctx, resource, marshalErr)
		}
		secretCommand, credentialUID, secretErr = runner.RunCreateInputUID(ctx, "kubectl", []string{"create", "-f", "-", "-o", "jsonpath={.metadata.uid}"}, secretPayload, r.config.Timeout)
		if errors.Is(secretErr, command.ErrAlreadyExists) {
			preemptionErr := secretErr
			secretCommand, secretMetadata, secretErr = runner.GetSecretMetadata(ctx, plan.Namespace, plan.SecretName, r.config.Timeout)
			if secretErr == nil {
				credentialUID, secretErr = validateCredentialSecretMetadata(resource, plan, credentialGeneration, persistedCredentialUID, secretMetadata)
			}
			if secretErr != nil {
				secretErr = errors.Join(preemptionErr, secretErr)
			}
		}
		if secretErr != nil {
			return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, ManifestFile: manifestFile, Command: secretCommand, DryRun: false}, r.fail(ctx, resource, secretErr)
		}
	}
	if persistErr := r.store.PersistCredentialSecretUID(ctx, resource, credentialUID); persistErr != nil {
		return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusReconciling, ManifestFile: manifestFile, Command: secretCommand, DryRun: false}, fmt.Errorf("persist credential Secret identity (commit outcome unknown): %w", persistErr)
	}
	secretCommand, err = runner.VerifySecretUID(ctx, plan.Namespace, plan.SecretName, credentialUID, r.config.Timeout)
	if err != nil {
		return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, ManifestFile: manifestFile, Command: secretCommand, DryRun: false}, r.fail(ctx, resource, err)
	}

	observer := providerImageObserver{plan: plan, runner: runner, timeout: r.config.Timeout}
	waitCommand, provenance, err := observer.applyAndObserve(ctx, manifestFile)
	if err != nil {
		return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, ManifestFile: manifestFile, Command: waitCommand, DryRun: false}, r.fail(ctx, resource, err)
	}
	waitCommand, err = runner.Run(ctx, "kubectl", []string{"get", "service/" + plan.Name, "--namespace", plan.Namespace}, false, r.config.Timeout)
	if err != nil {
		return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, ManifestFile: manifestFile, Command: waitCommand, DryRun: false}, r.fail(ctx, resource, err)
	}
	keys := append([]string(nil), plan.ConnectionKeys...)
	sort.Strings(keys)
	desiredState := mergeState(resource.DesiredState, map[string]any{
		"providerImageProvenance": provenance,
		"providerResult":          publicProviderPlan(plan),
		"reconciledAt":            time.Now().UTC().Format(time.RFC3339Nano),
		"healthManaged":           true,
		"healthStatus":            "HEALTHY",
		"healthFailureCount":      0,
	})
	err = r.store.MarkResourceReady(ctx, resource, plan.Provider, plan.SecretName, plan.Endpoint, keys, desiredState)
	return ordinaryPublicationResult(&Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusReady, ManifestFile: manifestFile, Command: waitCommand, DryRun: false}, err)
}

func (r *Reconciler) dryRunRecheck() time.Duration {
	if r.config.DryRun {
		return r.config.DryRunRecheck
	}
	return 0
}

func (r *Reconciler) reconcileHealth(ctx context.Context, resource *store.Resource) (*Result, error) {
	plan, err := provider.Compile(resource, r.providerImage(resource.Engine))
	if err != nil {
		desiredState := mergeState(resource.DesiredState, map[string]any{
			"healthManaged":       true,
			"healthStatus":        "UNHEALTHY",
			"lastHealthError":     err.Error(),
			"lastHealthFailureAt": time.Now().UTC().Format(time.RFC3339Nano),
		})
		persistErr := r.store.TransitionResource(ctx, resource, store.StatusReconciling, store.StatusFailed, desiredState)
		return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, DryRun: false}, withPersistenceFailure(err, persistErr)
	}
	runner := r.runnerFor(resource)
	if requiresPrimitiveBootstrap(plan.Engine) || len(plan.ProbeCommand) == 0 {
		err = fmt.Errorf("provider %s has no authenticated health reconciliation", plan.Engine)
		return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusFailed, DryRun: false}, r.fail(ctx, resource, err)
	}
	if existing := strings.TrimSpace(resource.ConnectionSecretName); existing != "" && existing != plan.SecretName {
		err = fmt.Errorf("persisted provider credential identity does not match the desired provider workload")
		return r.recordHealthFailure(ctx, resource, plan, err, true, "")
	}
	credentialUID, err := credentialSecretUID(resource.DesiredState)
	if err != nil {
		return r.recordHealthFailure(ctx, resource, plan, err, true, "")
	}
	credentialGeneration, _, err := credentialSecretGeneration(resource.DesiredState)
	if err != nil {
		return r.recordHealthFailure(ctx, resource, plan, err, true, "")
	}
	commandLine, secretMetadata, secretErr := runner.GetSecretMetadata(ctx, plan.Namespace, plan.SecretName, r.config.Timeout)
	if secretErr != nil {
		return r.recordHealthFailure(ctx, resource, plan, secretErr, credentialIntegrityFailure(secretErr), commandLine)
	}
	if _, err = validateCredentialSecretMetadata(resource, plan, credentialGeneration, credentialUID, secretMetadata); err != nil {
		return r.recordHealthFailure(ctx, resource, plan, err, true, commandLine)
	}
	commandLine, err = runner.VerifySecretUID(ctx, plan.Namespace, plan.SecretName, credentialUID, r.config.Timeout)
	if err != nil {
		return r.recordHealthFailure(ctx, resource, plan, err, credentialIntegrityFailure(err), commandLine)
	}
	commandLine, err = waitForStatefulSetReady(ctx, runner, plan.Namespace, plan.Name, r.config.Timeout)
	if err != nil {
		return r.recordHealthFailure(ctx, resource, plan, err, false, commandLine)
	}
	commandLine, err = runner.Run(ctx, "kubectl", []string{"get", "service/" + plan.Name, "--namespace", plan.Namespace}, false, r.config.Timeout)
	if err != nil {
		return r.recordHealthFailure(ctx, resource, plan, err, false, commandLine)
	}
	keys := append([]string(nil), plan.ConnectionKeys...)
	sort.Strings(keys)
	desiredState := mergeState(resource.DesiredState, map[string]any{
		"providerResult":     publicProviderPlan(plan),
		"healthCheckedAt":    time.Now().UTC().Format(time.RFC3339Nano),
		"healthManaged":      true,
		"healthStatus":       "HEALTHY",
		"healthFailureCount": 0,
		"lastHealthError":    "",
	})
	if err := r.store.MarkResourceReady(ctx, resource, plan.Provider, plan.SecretName, plan.Endpoint, keys, desiredState); err != nil {
		return nil, err
	}
	return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusReady, Command: commandLine, DryRun: false}, nil
}

const healthFailureThreshold = 3

func (r *Reconciler) recordHealthFailure(ctx context.Context, resource *store.Resource, plan *provider.Plan, failure error, immediate bool, commandLine string) (*Result, error) {
	count := consecutiveHealthFailures(resource.DesiredState) + 1
	if immediate && count < healthFailureThreshold {
		count = healthFailureThreshold
	}
	desiredState := mergeState(resource.DesiredState, map[string]any{
		"providerResult":      publicProviderPlan(plan),
		"healthManaged":       true,
		"healthStatus":        "UNHEALTHY",
		"healthFailureCount":  count,
		"lastHealthError":     failure.Error(),
		"lastHealthFailureAt": time.Now().UTC().Format(time.RFC3339Nano),
	})
	status := store.StatusReady
	var persistErr error
	if count >= healthFailureThreshold {
		status = store.StatusFailed
		persistErr = r.store.TransitionResource(ctx, resource, store.StatusReconciling, store.StatusFailed, desiredState)
	} else {
		keys := append([]string(nil), plan.ConnectionKeys...)
		sort.Strings(keys)
		persistErr = r.store.MarkResourceReady(ctx, resource, plan.Provider, plan.SecretName, plan.Endpoint, keys, desiredState)
	}
	result := &Result{Processed: 1, ResourceID: resource.ID, Status: status, Command: commandLine, DryRun: false}
	if persistErr != nil {
		return result, fmt.Errorf("record provider health failure: %w", persistErr)
	}
	return result, failure
}

func consecutiveHealthFailures(desiredState map[string]any) int {
	value, exists := desiredState["healthFailureCount"]
	if !exists {
		return 0
	}
	failClosed := healthFailureThreshold - 1
	normalize := func(value int64) int {
		if value < 0 || value >= int64(healthFailureThreshold) {
			return failClosed
		}
		return int(value)
	}
	switch typed := value.(type) {
	case int:
		if typed < 0 || typed >= healthFailureThreshold {
			return failClosed
		}
		return typed
	case int64:
		return normalize(typed)
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) || math.Trunc(typed) != typed || typed < 0 || typed >= float64(healthFailureThreshold) {
			return failClosed
		}
		return int(typed)
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			return failClosed
		}
		return normalize(parsed)
	default:
		return failClosed
	}
}

func credentialSecretUID(desiredState map[string]any) (string, error) {
	uid, err := optionalCredentialSecretUID(desiredState)
	if err != nil {
		return "", err
	}
	if uid == "" {
		return "", errors.New("persisted credential Secret UID is missing or invalid")
	}
	return uid, nil
}

func optionalCredentialSecretUID(desiredState map[string]any) (string, error) {
	value, exists := desiredState["credentialSecretUID"]
	if !exists {
		return "", nil
	}
	uid, ok := value.(string)
	uid = strings.TrimSpace(uid)
	if !ok || !credentialUIDPattern.MatchString(uid) {
		return "", errors.New("persisted credential Secret UID is missing or invalid")
	}
	return uid, nil
}

func credentialSecretGeneration(desiredState map[string]any) (string, bool, error) {
	value, exists := desiredState["credentialSecretGeneration"]
	if !exists {
		return "", false, nil
	}
	generation, ok := value.(string)
	generation = strings.TrimSpace(generation)
	if !ok || !credentialGenerationPattern.MatchString(generation) {
		return "", true, errors.New("persisted credential Secret generation is invalid")
	}
	return generation, true, nil
}

func (r *Reconciler) reserveCredentialSecretGeneration(ctx context.Context, resource *store.Resource) (string, error) {
	generation, exists, err := credentialSecretGeneration(resource.DesiredState)
	if err != nil || exists {
		return generation, err
	}
	if uid, uidErr := optionalCredentialSecretUID(resource.DesiredState); uidErr != nil || uid != "" {
		// Rows provisioned before the generation protocol remain fenced by their
		// already-persisted immutable UID and are never adopted by metadata.
		return "", uidErr
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate credential Secret generation: %w", err)
	}
	generation = base64.RawURLEncoding.EncodeToString(random)
	if err := r.store.ReserveCredentialSecretGeneration(ctx, resource, generation); err != nil {
		return "", fmt.Errorf("reserve credential Secret generation: %w", err)
	}
	return generation, nil
}

func validateCredentialSecretMetadata(resource *store.Resource, plan *provider.Plan, generation, persistedUID string, metadata *command.SecretMetadata) (string, error) {
	if metadata == nil || !credentialUIDPattern.MatchString(strings.TrimSpace(metadata.UID)) || metadata.Name != plan.SecretName || metadata.Namespace != plan.Namespace {
		return "", errors.New("credential Secret metadata identity is invalid")
	}
	uid := strings.TrimSpace(metadata.UID)
	if persistedUID != "" && uid != persistedUID {
		return "", command.ErrSecretUIDMismatch
	}
	if generation == "" {
		if persistedUID == "" {
			return "", errors.New("credential Secret cannot be adopted without a persisted ownership generation")
		}
		return uid, nil
	}
	expectedLabels := map[string]string{
		"app.kubernetes.io/name":       plan.Name,
		"app.kubernetes.io/managed-by": "raibitserver",
		"raibitserver.io/managed":      "true",
		"raibitserver.io/project-id":   fmt.Sprint(plan.Labels["raibitserver.io/project-id"]),
		"raibitserver.io/resource-id":  fmt.Sprint(plan.Labels["raibitserver.io/resource-id"]),
		"raibitserver.io/provider":     plan.Engine,
	}
	for key, expected := range expectedLabels {
		if metadata.Labels[key] != expected {
			return "", fmt.Errorf("credential Secret ownership label %q does not match the claimed resource", key)
		}
	}
	expectedAnnotations := map[string]string{
		"raibitserver.io/credential-owner":      "raibitserver-provisioner",
		"raibitserver.io/credential-generation": generation,
		"raibitserver.io/resource-id":           resource.ID,
		"raibitserver.io/project-id":            resource.ProjectID,
	}
	for key, expected := range expectedAnnotations {
		if metadata.Annotations[key] != expected {
			return "", fmt.Errorf("credential Secret ownership annotation %q does not match the claimed resource", key)
		}
	}
	return uid, nil
}

func credentialIntegrityFailure(err error) bool {
	if errors.Is(err, command.ErrSecretNotFound) || errors.Is(err, command.ErrSecretUIDMismatch) {
		return true
	}
	var apiErr *command.KubernetesAPIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode < 400 || apiErr.StatusCode >= 500 {
		return false
	}
	switch apiErr.StatusCode {
	case 408, 425, 429:
		return false
	default:
		return true
	}
}

func requiresPrimitiveBootstrap(engine string) bool {
	switch engine {
	case "object-storage", "qdrant", "nats":
		return true
	default:
		return false
	}
}

func (r *Reconciler) reconcileDeletion(ctx context.Context, resource *store.Resource) (*Result, error) {
	name, namespace, secretName, pvcName, err := provider.ObjectNames(resource)
	if err != nil {
		return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusDeleting, DryRun: r.config.DryRun}, err
	}
	runner := r.runnerFor(resource)
	commandLine := ""
	secretPresent := true
	if !r.config.DryRun {
		commandLine, namespaceOutput, namespaceErr := runner.RunSensitiveOutput(ctx, "kubectl", []string{"get", "namespace/" + namespace, "--ignore-not-found", "-o", "name"}, r.config.Timeout)
		if namespaceErr != nil {
			return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusDeleting, Command: commandLine, DryRun: false}, namespaceErr
		}
		if len(strings.TrimSpace(string(namespaceOutput))) == 0 {
			result := &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusDeleting, Command: commandLine, DryRun: false}
			if err := r.store.FinalizeResourceDeletion(ctx, resource); err != nil {
				return result, err
			}
			result.Status = store.StatusDeleted
			return result, nil
		}
		bootstrapManifests, bootstrapErr := provider.TenantBootstrapManifests(resource, r.config.ServiceAccountName, r.config.ServiceAccountNamespace, r.config.TenantRoleName)
		if bootstrapErr != nil {
			return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusDeleting, Command: commandLine, DryRun: false}, bootstrapErr
		}
		for _, manifest := range bootstrapManifests {
			payload, marshalErr := json.Marshal(manifest)
			if marshalErr != nil {
				return nil, marshalErr
			}
			commandLine, err = runner.RunInput(ctx, "kubectl", []string{"apply", "--server-side", "-f", "-"}, payload, false, r.config.Timeout)
			if err != nil {
				return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusDeleting, Command: commandLine, DryRun: false}, err
			}
		}
		credentialUID, uidErr := credentialSecretUID(resource.DesiredState)
		if uidErr != nil {
			return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusDeleting, Command: commandLine, DryRun: false}, uidErr
		}
		commandLine, uidErr = runner.VerifySecretUID(ctx, namespace, secretName, credentialUID, r.config.Timeout)
		if errors.Is(uidErr, command.ErrSecretNotFound) {
			secretPresent = false
		} else if uidErr != nil {
			return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusDeleting, Command: commandLine, DryRun: false}, uidErr
		}
	}
	deletions := [][2]string{
		{"service", name},
		{"statefulset", name},
		{"networkpolicy", name + "-provider"},
	}
	if r.config.DryRun {
		deletions = append(deletions, [2]string{"secret", secretName}, [2]string{"persistentvolumeclaim", pvcName})
	}
	for _, object := range deletions {
		if r.config.DryRun {
			arguments := []string{"delete", object[0] + "/" + object[1], "--namespace", namespace, "--ignore-not-found=true", "--wait=true"}
			if object[0] == "statefulset" {
				arguments = append(arguments, "--cascade=foreground")
			}
			commandLine, err = runner.Run(ctx, "kubectl", arguments, true, r.config.Timeout)
		} else {
			commandLine, err = deleteUIDFencedObject(ctx, runner, object[0], namespace, object[1], r.config.Timeout)
		}
		if err != nil {
			return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusDeleting, Command: commandLine, DryRun: r.config.DryRun}, err
		}
	}
	if !r.config.DryRun {
		if secretPresent {
			credentialUID, _ := credentialSecretUID(resource.DesiredState)
			commandLine, err = runner.DeleteSecretUID(ctx, namespace, secretName, credentialUID, r.config.Timeout)
			if err != nil {
				return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusDeleting, Command: commandLine, DryRun: false}, err
			}
			commandLine, err = waitForObjectDeletion(ctx, runner, "secret", namespace, secretName, r.config.Timeout)
			if err != nil {
				return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusDeleting, Command: commandLine, DryRun: false}, err
			}
		}
		commandLine, err = deleteUIDFencedObject(ctx, runner, "persistentvolumeclaim", namespace, pvcName, r.config.Timeout)
		if err != nil {
			return &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusDeleting, Command: commandLine, DryRun: false}, err
		}
	}
	result := &Result{Processed: 1, ResourceID: resource.ID, Status: store.StatusDeleting, Command: commandLine, DryRun: r.config.DryRun}
	if r.config.DryRun {
		desiredState := mergeState(resource.DesiredState, map[string]any{"lastDryRunDeletionAt": time.Now().UTC().Format(time.RFC3339Nano)})
		if err := r.store.TransitionResource(ctx, resource, store.StatusDeleting, store.StatusDeleteRequested, desiredState); err != nil {
			return result, err
		}
		result.Status = store.StatusDeleteRequested
		return result, nil
	}
	if err := r.store.FinalizeResourceDeletion(ctx, resource); err != nil {
		return result, err
	}
	result.Status = store.StatusDeleted
	return result, nil
}

func deleteUIDFencedObject(ctx context.Context, runner command.Runner, resource, namespace, name string, timeout time.Duration) (string, error) {
	commandLine, output, err := runner.RunSensitiveOutput(ctx, "kubectl", []string{"get", resource + "/" + name, "--namespace", namespace, "--ignore-not-found", "-o", "jsonpath={.metadata.uid}"}, timeout)
	if err != nil {
		return commandLine, err
	}
	uid := strings.TrimSpace(string(output))
	if uid == "" {
		return commandLine, nil
	}
	if !command.ValidKubernetesUID(uid) {
		return commandLine, fmt.Errorf("Kubernetes %s/%s returned an invalid UID", resource, name)
	}
	commandLine, err = runner.DeleteObjectUID(ctx, resource, namespace, name, uid, timeout)
	if err != nil {
		return commandLine, err
	}
	return waitForObjectDeletion(ctx, runner, resource, namespace, name, timeout)
}

func waitForObjectDeletion(ctx context.Context, runner command.Runner, resource, namespace, name string, timeout time.Duration) (string, error) {
	waitTimeout := timeout
	if waitTimeout <= 0 {
		waitTimeout = 10 * time.Minute
	}
	return runner.Run(ctx, "kubectl", []string{"wait", "--for=delete", resource + "/" + name, "--namespace", namespace, "--timeout=" + waitTimeout.String()}, false, timeout)
}

type statefulSetSnapshot struct {
	Metadata struct {
		Generation int64 `json:"generation"`
	} `json:"metadata"`
	Spec struct {
		Replicas *int32 `json:"replicas"`
	} `json:"spec"`
	Status struct {
		ObservedGeneration int64  `json:"observedGeneration"`
		Replicas           int32  `json:"replicas"`
		ReadyReplicas      int32  `json:"readyReplicas"`
		UpdatedReplicas    int32  `json:"updatedReplicas"`
		CurrentRevision    string `json:"currentRevision"`
		UpdateRevision     string `json:"updateRevision"`
	} `json:"status"`
}

func waitForStatefulSetReady(ctx context.Context, runner command.Runner, namespace, name string, timeout time.Duration) (string, error) {
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	waitContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	arguments := []string{"get", "statefulset/" + name, "--namespace", namespace, "--output=json"}
	commandTimeout := min(timeout, 10*time.Second)
	commandLine := "kubectl " + strings.Join(arguments, " ")
	for {
		var payload []byte
		var err error
		commandLine, payload, err = runner.RunSensitiveOutput(waitContext, "kubectl", arguments, commandTimeout)
		if err != nil {
			return commandLine, err
		}
		ready, err := statefulSetReady(payload)
		if err != nil {
			return commandLine, err
		}
		if ready {
			return commandLine, nil
		}
		timer := time.NewTimer(time.Second)
		select {
		case <-waitContext.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return commandLine, fmt.Errorf("StatefulSet %s/%s did not become ready: %w", namespace, name, waitContext.Err())
		case <-timer.C:
		}
	}
}

func statefulSetReady(payload []byte) (bool, error) {
	var snapshot statefulSetSnapshot
	if err := json.Unmarshal(payload, &snapshot); err != nil {
		return false, fmt.Errorf("decode StatefulSet readiness: %w", err)
	}
	if snapshot.Metadata.Generation < 1 || snapshot.Spec.Replicas == nil || *snapshot.Spec.Replicas < 1 {
		return false, errors.New("StatefulSet readiness response has an invalid desired replica contract")
	}
	desired := *snapshot.Spec.Replicas
	return snapshot.Status.ObservedGeneration >= snapshot.Metadata.Generation &&
		snapshot.Status.Replicas == desired &&
		snapshot.Status.ReadyReplicas == desired &&
		snapshot.Status.UpdatedReplicas == desired &&
		snapshot.Status.CurrentRevision != "" &&
		snapshot.Status.CurrentRevision == snapshot.Status.UpdateRevision, nil
}

func (r *Reconciler) providerImage(engine string) string {
	normalized := strings.ToLower(strings.TrimSpace(engine))
	aliases := map[string]string{"postgres": "postgresql", "pg": "postgresql", "mongo": "mongodb", "s3": "object-storage", "minio": "object-storage", "vector-db": "qdrant", "message-queue": "nats"}
	if value := aliases[normalized]; value != "" {
		normalized = value
	}
	return strings.TrimSpace(r.config.Images[normalized])
}

func publicProviderPlan(plan *provider.Plan) map[string]any {
	return map[string]any{
		"engine": plan.Engine, "provider": plan.Provider, "name": plan.Name, "namespace": plan.Namespace, "database": plan.Database, "user": plan.User,
		"secretName": plan.SecretName, "environmentKeys": plan.ConnectionKeys, "endpoint": plan.Endpoint,
		"objects": []any{"Namespace/" + plan.Namespace, "PersistentVolumeClaim/" + plan.PVCName, "Service/" + plan.Name, "StatefulSet/" + plan.Name, "NetworkPolicy/" + plan.Name + "-provider"},
	}
}

func (r *Reconciler) fail(ctx context.Context, resource *store.Resource, failure error) error {
	desiredState := mergeState(resource.DesiredState, map[string]any{"lastError": failure.Error(), "failedAt": time.Now().UTC().Format(time.RFC3339Nano)})
	return withPersistenceFailure(failure, r.store.TransitionResource(ctx, resource, store.StatusReconciling, store.StatusFailed, desiredState))
}

func withPersistenceFailure(failure, persistErr error) error {
	if persistErr == nil {
		return failure
	}
	return errors.Join(failure, fmt.Errorf("persist failed resource status: %w", persistErr))
}

func (r *Reconciler) writeManifest(resourceID string, manifest map[string]any) (string, error) {
	if err := os.MkdirAll(r.config.OutputDir, 0o700); err != nil {
		return "", err
	}
	payload, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return "", err
	}
	path := filepath.Join(r.config.OutputDir, manifestFileName(resourceID))
	return path, os.WriteFile(path, append(payload, '\n'), 0o600)
}

func manifestFileName(resourceID string) string {
	name := slug(resourceID)
	if len(name) > 48 {
		name = strings.Trim(name[:48], "-")
	}
	digest := sha256.Sum256([]byte(resourceID))
	return fmt.Sprintf("%s-%x.json", name, digest[:6])
}

func mergeState(current map[string]any, updates map[string]any) map[string]any {
	result := make(map[string]any, len(current)+len(updates))
	for key, value := range current {
		result[key] = value
	}
	for key, value := range updates {
		result[key] = value
	}
	return result
}

var (
	slugPattern                 = regexp.MustCompile(`[^a-z0-9]+`)
	credentialUIDPattern        = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	credentialGenerationPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

func slug(value string) string {
	value = slugPattern.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "-")
	value = strings.Trim(value, "-")
	if value == "" {
		return "item"
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
