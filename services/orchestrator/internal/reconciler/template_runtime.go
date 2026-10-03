package reconciler

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/raibitserver/orchestrator/internal/command"
	"github.com/raibitserver/orchestrator/internal/kube"
	"github.com/raibitserver/orchestrator/internal/store"
)

var (
	ErrTemplateRuntimeSource     = errors.New("template runtime source is unavailable")
	ErrTemplateRuntimeProjection = errors.New("template runtime projection is invalid")
	ErrTemplateSecretOwnership   = errors.New("template runtime Secret ownership conflict")
	ErrTemplateSecretCleanup     = errors.New("template runtime Secret cleanup failed")
)

type TemplateRuntimeProjectionRequest struct {
	Source                     store.TemplateRuntimeSource
	Runner                     command.Runner
	Project                    *store.Project
	Service                    *store.Service
	Deployment                 *store.Deployment
	OutputDir                  string
	BaseDomain                 string
	Kubeconfig                 string
	KubeContext                string
	DryRun                     bool
	Timeout                    time.Duration
	ClaimLease                 time.Duration
	DeploymentOptions          kube.DeploymentOptions
	SecretClusterRole          string
	OrchestratorServiceAccount string
	ControlPlaneNamespace      string
}

type TemplateRuntimeProjection struct {
	Deployment     *store.Deployment
	SecretName     string
	Cleanup        func() error                `json:"-"`
	CheckAuthority func(context.Context) error `json:"-"`
	CollectUnused  func(context.Context) error `json:"-"`
}

func ProjectTemplateRuntime(ctx context.Context, request TemplateRuntimeProjectionRequest) (_ *TemplateRuntimeProjection, resultErr error) {
	if request.Deployment == nil || request.Project == nil || request.Service == nil || request.Runner == nil {
		return nil, ErrTemplateRuntimeProjection
	}
	template, err := templateRuntimeMarker(request.Deployment.DesiredSpecSnapshot)
	if err != nil {
		return nil, err
	}
	if !template {
		return &TemplateRuntimeProjection{Deployment: request.Deployment, Cleanup: func() error { return nil }, CheckAuthority: func(context.Context) error { return nil }, CollectUnused: func(context.Context) error { return nil }}, nil
	}
	if request.Source == nil {
		return nil, ErrTemplateRuntimeSource
	}
	lease := request.Deployment.Lease()
	inputs, err := request.Source.LoadTemplateRuntimeInputs(ctx, lease, request.ClaimLease)
	if err != nil {
		return nil, fmt.Errorf("load template runtime inputs: %w", err)
	}
	if inputs == nil || inputs.ProjectID != request.Project.ID || inputs.ProjectID != request.Deployment.ProjectID || inputs.EnvironmentID != request.Service.EnvironmentID || inputs.EnvironmentID != request.Deployment.EnvironmentID || inputs.ServiceID != request.Service.ID || inputs.ServiceID != request.Deployment.ServiceID || inputs.DeploymentID != request.Deployment.ID {
		return nil, store.ErrTemplateRuntimeScope
	}
	checkAuthority := func(effectCtx context.Context) error {
		current, err := request.Source.LoadTemplateRuntimeInputs(effectCtx, lease, request.ClaimLease)
		if err != nil {
			return fmt.Errorf("recheck template runtime inputs: %w", err)
		}
		if !reflect.DeepEqual(current, inputs) {
			return store.ErrTemplateRuntimeScope
		}
		return nil
	}
	// Immutable attempt identities keep retries and old cleanup away from live references.
	secretIdentity := templateSecretIdentity(inputs.ProjectID, inputs.EnvironmentID, inputs.ServiceID+"\x00"+lease.DeploymentID+"\x00"+lease.WorkerID+"\x00"+strconv.Itoa(lease.Attempt))
	secretLabel := secretIdentity[:40]
	secretName := "rb-template-" + secretLabel
	secretEnv := make([]map[string]any, 0, len(inputs.ResourceRefs)+len(inputs.SealedSecrets))
	seen := make(map[string]bool, cap(secretEnv))
	for _, ref := range inputs.ResourceRefs {
		if seen[ref.EnvName] {
			return nil, ErrTemplateRuntimeProjection
		}
		seen[ref.EnvName] = true
		secretEnv = append(secretEnv, templateSecretEnv(ref.EnvName, ref.SecretName, ref.SecretKey))
	}
	secretData := make(map[string]string, len(inputs.SealedSecrets))
	for _, secret := range inputs.SealedSecrets {
		if seen[secret.EnvName] {
			return nil, ErrTemplateRuntimeProjection
		}
		opened, openErr := store.OpenTemplateSealedSecret(secret.SealedValue)
		if openErr != nil {
			return nil, openErr
		}
		seen[secret.EnvName] = true
		secretData[secret.EnvName] = base64.StdEncoding.EncodeToString(opened)
		clear(opened)
		secretEnv = append(secretEnv, templateSecretEnv(secret.EnvName, secretName, secret.EnvName))
	}
	projected, err := projectTemplateSnapshot(request.Deployment, secretEnv)
	if err != nil {
		return nil, err
	}
	spec := kube.SpecFromState(request.Project, request.Service, projected, request.BaseDomain)
	if spec.InvalidReason != "" || spec.Namespace == "" {
		return nil, ErrTemplateRuntimeProjection
	}
	projection := &TemplateRuntimeProjection{Deployment: projected, SecretName: secretName, Cleanup: func() error { return nil }, CheckAuthority: checkAuthority}
	plan := kube.NewDeploymentPlan(spec, request.DeploymentOptions)
	if !plan.Safe || spec.Preview {
		return nil, ErrTemplateRuntimeProjection
	}
	if err := establishTemplateNamespace(ctx, request, plan, checkAuthority); err != nil {
		return nil, err
	}
	projection.CollectUnused = func(effectCtx context.Context) error {
		return collectTemplateSecrets(effectCtx, request, spec.Namespace, inputs.ProjectID, inputs.EnvironmentID, inputs.ServiceID, secretName, checkAuthority)
	}
	if err := projection.CollectUnused(ctx); err != nil {
		return nil, err
	}
	if len(secretData) == 0 {
		return projection, nil
	}
	labels := map[string]string{
		"app.kubernetes.io/managed-by":       "raibitserver-template-runtime",
		"raibitserver.io/template-secret-id": secretLabel,
		"raibitserver.io/project-id":         inputs.ProjectID,
		"raibitserver.io/environment-id":     inputs.EnvironmentID,
		"raibitserver.io/service-id":         inputs.ServiceID,
		"raibitserver.io/deployment-id":      inputs.DeploymentID,
	}
	manifest := map[string]any{"apiVersion": "v1", "kind": "Secret", "immutable": true, "type": "Opaque", "metadata": map[string]any{"name": secretName, "namespace": spec.Namespace, "labels": labels}, "data": secretData}
	if !request.DryRun {
		existing, err := runTemplateKubectl(ctx, request, []string{"get", "secret/" + secretName, "--namespace", spec.Namespace, "--ignore-not-found=true", "-o", "json"})
		if err != nil || existing.ExitCode != 0 {
			return nil, ErrTemplateSecretOwnership
		}
		if strings.TrimSpace(existing.Stdout) != "" {
			if !sameTemplateSecret(existing.Stdout, secretName, spec.Namespace, labels, secretData) {
				return nil, ErrTemplateSecretOwnership
			}
			return projection, nil
		}
	}
	payload, err := json.Marshal(manifest)
	if err != nil {
		return nil, ErrTemplateRuntimeProjection
	}
	if err := os.MkdirAll(request.OutputDir, 0o755); err != nil {
		return nil, ErrTemplateRuntimeProjection
	}
	file, err := os.CreateTemp(request.OutputDir, "raibit-template-secret-*.json")
	if err != nil {
		return nil, ErrTemplateRuntimeProjection
	}
	path := filepath.Clean(file.Name())
	defer func() {
		clear(payload)
		if err := file.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
			resultErr = errors.Join(resultErr, ErrTemplateSecretCleanup)
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			resultErr = errors.Join(resultErr, ErrTemplateSecretCleanup)
		}
	}()
	if err := file.Chmod(0o600); err != nil {
		return nil, ErrTemplateRuntimeProjection
	}
	if _, err := file.Write(payload); err != nil {
		return nil, ErrTemplateRuntimeProjection
	}
	if err := file.Close(); err != nil {
		return nil, ErrTemplateRuntimeProjection
	}
	if err := checkAuthority(ctx); err != nil {
		return nil, err
	}
	result, err := runTemplateKubectl(ctx, request, []string{"create", "-f", path})
	if err != nil || result.ExitCode != 0 {
		// Another delivery of this exact attempt may have won create. Never
		// overwrite: reuse requires immutable identity and identical content.
		if !request.DryRun {
			existing, readErr := runTemplateKubectl(ctx, request, []string{"get", "secret/" + secretName, "--namespace", spec.Namespace, "--ignore-not-found=true", "-o", "json"})
			if readErr == nil && existing.ExitCode == 0 && sameTemplateSecret(existing.Stdout, secretName, spec.Namespace, labels, secretData) {
				return projection, nil
			}
		}
		return nil, ErrTemplateSecretOwnership
	}
	// A failed or cancelled apply may already reference this Secret. Retain it for
	// restart/rescheduling; reclamation requires a separate proof of no references.
	return projection, nil
}

func (r *ServiceReconciler) projectTemplateRuntime(ctx context.Context, project *store.Project, service *store.Service, deployment *store.Deployment) (*TemplateRuntimeProjection, error) {
	source, _ := r.store.(store.TemplateRuntimeSource)
	return ProjectTemplateRuntime(ctx, TemplateRuntimeProjectionRequest{Source: source, Runner: r.runner, Project: project, Service: service, Deployment: deployment, OutputDir: r.config.OutputDir, BaseDomain: r.config.BaseDomain, Kubeconfig: r.config.Kubeconfig, KubeContext: r.config.KubeContext, DryRun: r.config.DryRun, Timeout: r.config.Timeout, ClaimLease: r.config.ClaimLease, SecretClusterRole: os.Getenv("RAIBITSERVER_TEMPLATE_SECRET_CLUSTER_ROLE"), OrchestratorServiceAccount: os.Getenv("RAIBITSERVER_ORCHESTRATOR_SERVICE_ACCOUNT"), ControlPlaneNamespace: os.Getenv("POD_NAMESPACE"), DeploymentOptions: kube.DeploymentOptions{IngressGatewayNamespace: r.config.IngressGatewayNamespace, IngressClassName: r.config.IngressClassName, IngressCustomHTTPErrors: r.config.IngressCustomHTTPErrors, IngressErrorMiddleware: r.config.IngressErrorMiddleware}})
}

func templateRuntimeMarker(raw json.RawMessage) (bool, error) {
	var marker struct {
		SourceType string `json:"sourceType"`
		Source     struct {
			Type string `json:"type"`
		} `json:"source"`
	}
	if len(raw) == 0 {
		return false, nil
	}
	if json.Unmarshal(raw, &marker) != nil {
		return false, store.ErrTemplateRuntimeSnapshot
	}
	template := marker.SourceType == "template" || marker.Source.Type == "template"
	if template && (marker.SourceType != "template" || marker.Source.Type != "template") {
		return false, store.ErrTemplateRuntimeSnapshot
	}
	return template, nil
}

func projectTemplateSnapshot(deployment *store.Deployment, projectedRefs []map[string]any) (*store.Deployment, error) {
	var snapshot map[string]json.RawMessage
	if json.Unmarshal(deployment.DesiredSpecSnapshot, &snapshot) != nil || snapshot == nil {
		return nil, store.ErrTemplateRuntimeSnapshot
	}
	if existing, present := snapshot["secretEnv"]; present && len(existing) > 0 && string(existing) != "null" && string(existing) != "[]" {
		return nil, ErrTemplateRuntimeProjection
	}
	encodedRefs, err := json.Marshal(projectedRefs)
	if err != nil {
		return nil, ErrTemplateRuntimeProjection
	}
	if len(projectedRefs) > 0 {
		snapshot["secretEnv"] = encodedRefs
	} else {
		delete(snapshot, "secretEnv")
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		return nil, ErrTemplateRuntimeProjection
	}
	projected := *deployment
	projected.DesiredSpecSnapshot = encoded
	return &projected, nil
}

func templateSecretEnv(envName, secretName, secretKey string) map[string]any {
	return map[string]any{"name": envName, "valueFrom": map[string]any{"secretKeyRef": map[string]any{"name": secretName, "key": secretKey}}}
}

func templateSecretIdentity(projectID, environmentID, serviceID string) string {
	digest := sha256.Sum256([]byte(projectID + "\x00" + environmentID + "\x00" + serviceID))
	return hex.EncodeToString(digest[:])
}

func runTemplateKubectl(ctx context.Context, request TemplateRuntimeProjectionRequest, args []string) (command.Result, error) {
	fullArgs := append([]string(nil), args...)
	if request.Kubeconfig != "" {
		fullArgs = append(fullArgs, "--kubeconfig", request.Kubeconfig)
	}
	if request.KubeContext != "" {
		fullArgs = append(fullArgs, "--context", request.KubeContext)
	}
	return request.Runner.Run(ctx, command.Command{Name: "kubectl", Args: fullArgs}, request.DryRun, request.Timeout)
}
