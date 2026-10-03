package reconciler

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"reflect"
	"regexp"
	"strings"

	"github.com/raibitserver/orchestrator/internal/kube"
	"github.com/raibitserver/orchestrator/internal/store"
)

var templateSecretName = regexp.MustCompile(`^rb-template-[a-f0-9]{40}$`)

type templateSecretObject struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Immutable  bool   `json:"immutable"`
	Type       string `json:"type"`
	Metadata   struct {
		Name              string            `json:"name"`
		Namespace         string            `json:"namespace"`
		UID               string            `json:"uid"`
		ResourceVersion   string            `json:"resourceVersion"`
		DeletionTimestamp string            `json:"deletionTimestamp"`
		Labels            map[string]string `json:"labels"`
	} `json:"metadata"`
	Data map[string]string `json:"data"`
}

func sameTemplateSecret(raw, name, namespace string, labels, data map[string]string) bool {
	var actual templateSecretObject
	return json.Unmarshal([]byte(raw), &actual) == nil && actual.APIVersion == "v1" && actual.Kind == "Secret" &&
		actual.Immutable && actual.Type == "Opaque" && actual.Metadata.Name == name && actual.Metadata.Namespace == namespace &&
		actual.Metadata.UID != "" && actual.Metadata.DeletionTimestamp == "" && reflect.DeepEqual(actual.Metadata.Labels, labels) && reflect.DeepEqual(actual.Data, data)
}

// Namespace creation is deliberately separate from workload apply: a newly
// installed worker needs its isolation boundary before any Secret exists.
func establishTemplateNamespace(ctx context.Context, request TemplateRuntimeProjectionRequest, plan kube.DeploymentPlan, fence func(context.Context) error) error {
	if err := fence(ctx); err != nil {
		return err
	}
	var namespace map[string]any
	var isolation []map[string]any
	for _, manifest := range plan.Manifests {
		switch manifest["kind"] {
		case "Namespace":
			namespace = manifest
		case "ResourceQuota", "NetworkPolicy":
			isolation = append(isolation, manifest)
		}
	}
	if namespace == nil || len(isolation) < 2 {
		return ErrTemplateRuntimeProjection
	}
	if !request.DryRun {
		getArgs := []string{"get", "namespace/" + plan.Service.Namespace, "--ignore-not-found=true", "-o", "json"}
		actual, err := runTemplateKubectl(ctx, request, getArgs)
		if err != nil || actual.ExitCode != 0 {
			return ErrTemplateSecretOwnership
		}
		if strings.TrimSpace(actual.Stdout) == "" {
			if err := fence(ctx); err != nil {
				return err
			}
			// A concurrent create is safe only if the subsequent read proves ownership.
			_ = templateJSONCommand(ctx, request, namespace, "create")
			actual, err = runTemplateKubectl(ctx, request, getArgs)
			if err != nil || actual.ExitCode != 0 {
				return ErrTemplateSecretOwnership
			}
		}
		owned, err := ownedProjectNamespace(actual.Stdout, plan.Service.Namespace, plan.Service.ProjectID)
		if err != nil {
			return ErrTemplateSecretOwnership
		}
		expected := namespace["metadata"].(map[string]any)["labels"].(map[string]any)
		for key, value := range expected {
			if owned.Metadata.Labels[key] != value {
				return ErrTemplateSecretOwnership
			}
		}
	}
	if err := fence(ctx); err != nil {
		return err
	}
	if err := templateJSONCommand(ctx, request, kube.List(isolation), "apply", "--server-side"); err != nil {
		return err
	}
	return establishTemplateSecretBinding(ctx, request, plan.Service, fence)
}

func establishTemplateSecretBinding(ctx context.Context, request TemplateRuntimeProjectionRequest, spec kube.AppServiceSpec, fence func(context.Context) error) error {
	if request.DryRun {
		return nil
	}
	if request.SecretClusterRole == "" || request.OrchestratorServiceAccount == "" || request.ControlPlaneNamespace == "" {
		return ErrTemplateRuntimeProjection
	}
	labels := map[string]any{"app.kubernetes.io/managed-by": "raibitserver", "raibitserver.io/managed": "true", "raibitserver.io/project-id": spec.ProjectID}
	roleRef := map[string]any{"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": request.SecretClusterRole}
	subjects := []any{map[string]any{"kind": "ServiceAccount", "name": request.OrchestratorServiceAccount, "namespace": request.ControlPlaneNamespace}}
	manifest := map[string]any{"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding", "metadata": map[string]any{"name": "raibitserver-template-secrets", "namespace": spec.Namespace, "labels": labels}, "roleRef": roleRef, "subjects": subjects}
	args := []string{"get", "rolebinding/raibitserver-template-secrets", "--namespace", spec.Namespace, "--ignore-not-found=true", "-o", "json"}
	actual, err := runTemplateKubectl(ctx, request, args)
	if err != nil || actual.ExitCode != 0 {
		return ErrTemplateSecretOwnership
	}
	if strings.TrimSpace(actual.Stdout) == "" {
		if err := fence(ctx); err != nil {
			return err
		}
		_ = templateJSONCommand(ctx, request, manifest, "create")
		actual, err = runTemplateKubectl(ctx, request, args)
		if err != nil || actual.ExitCode != 0 {
			return ErrTemplateSecretOwnership
		}
	}
	var binding map[string]any
	if json.Unmarshal([]byte(actual.Stdout), &binding) != nil {
		return ErrTemplateSecretOwnership
	}
	meta, _ := binding["metadata"].(map[string]any)
	if binding["apiVersion"] != "rbac.authorization.k8s.io/v1" || binding["kind"] != "RoleBinding" || meta["name"] != "raibitserver-template-secrets" || meta["namespace"] != spec.Namespace || meta["uid"] == nil || meta["deletionTimestamp"] != nil ||
		!reflect.DeepEqual(meta["labels"], labels) || !reflect.DeepEqual(binding["roleRef"], roleRef) || !reflect.DeepEqual(binding["subjects"], subjects) {
		return ErrTemplateSecretOwnership
	}
	return nil
}

// Temporary payloads (including deletion preconditions) are private and removed
// synchronously. Command output is never forwarded because Secret reads contain data.
func templateJSONCommand(ctx context.Context, request TemplateRuntimeProjectionRequest, payload any, args ...string) (resultErr error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return ErrTemplateRuntimeProjection
	}
	defer clear(encoded)
	if err := os.MkdirAll(request.OutputDir, 0o755); err != nil {
		return ErrTemplateRuntimeProjection
	}
	file, err := os.CreateTemp(request.OutputDir, "raibit-template-runtime-*.json")
	if err != nil {
		return ErrTemplateRuntimeProjection
	}
	defer func() {
		_ = file.Close()
		if err := os.Remove(file.Name()); err != nil && !errors.Is(err, os.ErrNotExist) {
			resultErr = errors.Join(resultErr, ErrTemplateSecretCleanup)
		}
	}()
	if err := file.Chmod(0o600); err != nil {
		return ErrTemplateRuntimeProjection
	}
	if _, err := file.Write(encoded); err != nil {
		return ErrTemplateRuntimeProjection
	}
	if err := file.Close(); err != nil {
		return ErrTemplateRuntimeProjection
	}
	result, err := runTemplateKubectl(ctx, request, append(args, "-f", file.Name()))
	if err != nil || result.ExitCode != 0 {
		return ErrTemplateRuntimeProjection
	}
	return nil
}

func collectTemplateSecrets(ctx context.Context, request TemplateRuntimeProjectionRequest, namespace, projectID, environmentID, serviceID, retain string, fence func(context.Context) error) error {
	collector, ok := request.Source.(store.TemplateRuntimeSecretCollector)
	if request.DryRun || !ok {
		return nil
	}
	if err := fence(ctx); err != nil {
		return err
	}
	if request.Deployment == nil {
		// Untemplated services have no tenant Secret grant. Its absence also
		// proves this runtime never created a Secret here, so deletion can finish.
		binding, err := runTemplateKubectl(ctx, request, []string{"get", "rolebinding/raibitserver-template-secrets", "--namespace", namespace, "--ignore-not-found=true", "-o", "json"})
		if err != nil || binding.ExitCode != 0 {
			return ErrTemplateSecretCleanup
		}
		if strings.TrimSpace(binding.Stdout) == "" {
			return nil
		}
		var actual struct {
			Kind     string `json:"kind"`
			Metadata struct {
				Name      string            `json:"name"`
				Namespace string            `json:"namespace"`
				Labels    map[string]string `json:"labels"`
			} `json:"metadata"`
		}
		if json.Unmarshal([]byte(binding.Stdout), &actual) != nil || actual.Kind != "RoleBinding" || actual.Metadata.Name != "raibitserver-template-secrets" || actual.Metadata.Namespace != namespace || actual.Metadata.Labels["raibitserver.io/project-id"] != projectID || actual.Metadata.Labels["app.kubernetes.io/managed-by"] != "raibitserver" {
			return ErrTemplateSecretOwnership
		}
	}
	selector := "app.kubernetes.io/managed-by=raibitserver-template-runtime,raibitserver.io/project-id=" + projectID + ",raibitserver.io/environment-id=" + environmentID + ",raibitserver.io/service-id=" + serviceID
	listed, err := runTemplateKubectl(ctx, request, []string{"get", "secrets", "--namespace", namespace, "--selector", selector, "-o", "json"})
	if err != nil || listed.ExitCode != 0 {
		return ErrTemplateSecretCleanup
	}
	var secrets struct {
		Items []templateSecretObject `json:"items"`
	}
	if json.Unmarshal([]byte(listed.Stdout), &secrets) != nil || secrets.Items == nil {
		return ErrTemplateSecretCleanup
	}
	for _, secret := range secrets.Items {
		meta := secret.Metadata
		labels := meta.Labels
		if secret.APIVersion != "v1" || secret.Kind != "Secret" || secret.Type != "Opaque" || !secret.Immutable || meta.UID == "" || meta.ResourceVersion == "" || meta.Namespace != namespace || !templateSecretName.MatchString(meta.Name) ||
			labels["app.kubernetes.io/managed-by"] != "raibitserver-template-runtime" || labels["raibitserver.io/project-id"] != projectID || labels["raibitserver.io/environment-id"] != environmentID || labels["raibitserver.io/service-id"] != serviceID ||
			labels["raibitserver.io/deployment-id"] == "" || meta.Name != "rb-template-"+labels["raibitserver.io/template-secret-id"] || len(labels) != 6 {
			return ErrTemplateSecretOwnership
		}
		if meta.Name == retain {
			continue
		}
		// The current lease supersedes older attempts of this same deployment;
		// excluding its retained name also bounds repeated failed retries.
		checkProducer := request.Deployment != nil && labels["raibitserver.io/deployment-id"] != request.Deployment.ID
		if checkProducer {
			collectible, err := collector.TemplateSecretCollectible(ctx, projectID, environmentID, serviceID, labels["raibitserver.io/deployment-id"], request.ClaimLease)
			if err != nil {
				return err
			}
			if !collectible {
				continue
			}
		}
		// Include ReplicaSets and existing Pods, not only current Deployment
		// templates: old rollout replicas must still restart with their Secret.
		workloads, err := runTemplateKubectl(ctx, request, []string{"get", "pods,deployments,replicasets,statefulsets,daemonsets,jobs,cronjobs", "--namespace", namespace, "-o", "json"})
		if err != nil || workloads.ExitCode != 0 {
			return ErrTemplateSecretCleanup
		}
		var inventory struct {
			Items []map[string]any `json:"items"`
		}
		if json.Unmarshal([]byte(workloads.Stdout), &inventory) != nil || inventory.Items == nil {
			return ErrTemplateSecretCleanup
		}
		used := false
		for _, object := range inventory.Items {
			if templateSecretReferenced(object["spec"], meta.Name) {
				used = true
				break
			}
		}
		if used {
			if request.Deployment == nil {
				return ErrTemplateSecretCleanup
			}
			continue
		}
		if err := fence(ctx); err != nil {
			return err
		}
		if checkProducer {
			collectible, err := collector.TemplateSecretCollectible(ctx, projectID, environmentID, serviceID, labels["raibitserver.io/deployment-id"], request.ClaimLease)
			if err != nil {
				return err
			}
			if !collectible {
				continue
			}
		}
		options := map[string]any{"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": map[string]any{"uid": meta.UID, "resourceVersion": meta.ResourceVersion}}
		if err := templateJSONCommand(ctx, request, options, "delete", "--raw", "/api/v1/namespaces/"+url.PathEscape(namespace)+"/secrets/"+url.PathEscape(meta.Name)); err != nil {
			return ErrTemplateSecretCleanup
		}
	}
	return nil
}

// A project may also own isolated development namespaces. Deletion must finish
// all of them before the database drops the environment bindings.
func (r *ServiceReconciler) cleanupProjectNamespaces(ctx context.Context, project *store.Project, production string, fence func(context.Context) error) ([]string, error) {
	commands, err := r.cleanupProjectKubernetes(ctx, project, production, fence)
	if err != nil || r.config.DryRun {
		return commands, err
	}
	if err := fence(ctx); err != nil {
		return commands, err
	}
	listed, err := r.runKubectl(ctx, []string{"get", "namespaces", "--selector", "app.kubernetes.io/managed-by=raibitserver,raibitserver.io/namespace-kind=application,raibitserver.io/project-id=" + project.ID, "-o", "json"})
	commands = append(commands, listed.Command)
	if err != nil || listed.ExitCode != 0 {
		return commands, ErrTemplateSecretCleanup
	}
	var namespaces struct {
		Items []json.RawMessage `json:"items"`
	}
	if json.Unmarshal([]byte(listed.Stdout), &namespaces) != nil || namespaces.Items == nil {
		return commands, ErrTemplateSecretCleanup
	}
	for _, raw := range namespaces.Items {
		var item namespaceMetadata
		if json.Unmarshal(raw, &item) != nil {
			return commands, ErrTemplateSecretCleanup
		}
		if _, err := ownedProjectNamespace(string(raw), item.Metadata.Name, project.ID); err != nil {
			return commands, err
		}
		if item.Metadata.Name == production {
			continue
		}
		deleted, err := r.cleanupProjectKubernetes(ctx, project, item.Metadata.Name, fence)
		commands = append(commands, deleted...)
		if err != nil {
			return commands, err
		}
	}
	return commands, nil
}

func templateSecretReferenced(value any, name string) bool {
	switch node := value.(type) {
	case map[string]any:
		for key, child := range node {
			switch key {
			case "secretName":
				if child == name {
					return true
				}
			case "secretKeyRef", "secretRef", "secret":
				if ref, ok := child.(map[string]any); ok && ref["name"] == name {
					return true
				}
			case "imagePullSecrets":
				if refs, ok := child.([]any); ok {
					for _, value := range refs {
						if ref, ok := value.(map[string]any); ok && ref["name"] == name {
							return true
						}
					}
				}
			}
			if templateSecretReferenced(child, name) {
				return true
			}
		}
	case []any:
		for _, child := range node {
			if templateSecretReferenced(child, name) {
				return true
			}
		}
	}
	return false
}
