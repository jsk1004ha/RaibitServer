package kube

import (
	"context"
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/raibitserver/log-ingester/internal/identity"
	"github.com/raibitserver/log-ingester/internal/ingester"
)

type owner struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	UID        string `json:"uid"`
	Controller bool   `json:"controller"`
}

type metadata struct {
	Namespace string            `json:"namespace"`
	Name      string            `json:"name"`
	UID       string            `json:"uid"`
	Labels    map[string]string `json:"labels"`
	Owners    []owner           `json:"ownerReferences"`
	Created   time.Time         `json:"creationTimestamp"`
	Deleted   *time.Time        `json:"deletionTimestamp"`
}

type (
	container struct {
		Name    string                      `json:"name"`
		Image   string                      `json:"image"`
		Command []string                    `json:"command"`
		Args    []string                    `json:"args"`
		Env     []identity.EnvironmentEntry `json:"env"`
		EnvFrom []json.RawMessage           `json:"envFrom"`
	}
	template struct {
		Metadata metadata `json:"metadata"`
		Spec     struct {
			Containers []container `json:"containers"`
		} `json:"spec"`
	}
)

type object struct {
	Kind       string   `json:"kind"`
	APIVersion string   `json:"apiVersion"`
	Metadata   metadata `json:"metadata"`
	Spec       struct {
		Containers  []container `json:"containers"`
		Template    template    `json:"template"`
		JobTemplate struct {
			Spec struct {
				Template template `json:"template"`
			} `json:"spec"`
		} `json:"jobTemplate"`
	} `json:"spec"`
}

var namePattern = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$`)

func (c *Client) Verify(ctx context.Context, pod ingester.Pod, scope identity.Scope) (time.Time, error) {
	if pod.Namespace != scope.Namespace || !namePattern.MatchString(pod.Name) || pod.UID == "" || len(pod.UID) > 256 {
		return time.Time{}, identity.ErrIdentity
	}
	var ns object
	if err := c.getJSON(ctx, "/api/v1/namespaces/"+url.PathEscape(scope.Namespace), &ns); err != nil {
		return time.Time{}, err
	}
	if ns.Kind != "Namespace" || ns.Metadata.Name != scope.Namespace || ns.Metadata.UID == "" || ns.Metadata.Deleted != nil || ns.Metadata.Labels["raibitserver.io/project-id"] != scope.ProjectID || ns.Metadata.Labels["app.kubernetes.io/managed-by"] != "raibitserver" {
		return time.Time{}, identity.ErrIdentity
	}
	var current object
	if err := c.getJSON(ctx, "/api/v1/namespaces/"+url.PathEscape(scope.Namespace)+"/pods/"+url.PathEscape(pod.Name), &current); err != nil {
		return time.Time{}, err
	}
	if current.Kind != "Pod" || current.APIVersion != "v1" || !matchesObject(current.Metadata, pod.Name, pod.UID, scope.Namespace) || !matchesLabels(current.Metadata.Labels, scope) || !matchesContainers(current.Spec.Containers, scope) || current.Metadata.Created.IsZero() {
		return time.Time{}, identity.ErrIdentity
	}
	created := current.Metadata.Created
	seen := map[string]bool{pod.UID: true}
	for depth := 0; depth < 3; depth++ {
		ref, ok := controller(current.Metadata.Owners)
		if !ok || seen[ref.UID] {
			return time.Time{}, identity.ErrIdentity
		}
		seen[ref.UID] = true
		resource, api := "", ""
		switch ref.Kind {
		case "ReplicaSet":
			if current.Kind != "Pod" || scope.Kind != "Deployment" {
				return time.Time{}, identity.ErrIdentity
			}
			resource, api = "replicasets", "apps/v1"
		case "Deployment":
			if current.Kind != "ReplicaSet" || scope.Kind != "Deployment" {
				return time.Time{}, identity.ErrIdentity
			}
			resource, api = "deployments", "apps/v1"
		case "Job":
			if current.Kind != "Pod" || (scope.Kind != "Job" && scope.Kind != "CronJob") {
				return time.Time{}, identity.ErrIdentity
			}
			resource, api = "jobs", "batch/v1"
		case "CronJob":
			if current.Kind != "Job" || scope.Kind != "CronJob" {
				return time.Time{}, identity.ErrIdentity
			}
			resource, api = "cronjobs", "batch/v1"
		default:
			return time.Time{}, identity.ErrIdentity
		}
		if ref.APIVersion != api {
			return time.Time{}, identity.ErrIdentity
		}
		var parent object
		if err := c.getJSON(ctx, "/apis/"+api+"/namespaces/"+url.PathEscape(scope.Namespace)+"/"+resource+"/"+url.PathEscape(ref.Name), &parent); err != nil {
			return time.Time{}, err
		}
		if parent.Kind != ref.Kind || parent.APIVersion != api || !matchesObject(parent.Metadata, ref.Name, ref.UID, scope.Namespace) {
			return time.Time{}, identity.ErrIdentity
		}
		shape := parent.Spec.Template
		if parent.Kind == "CronJob" {
			shape = parent.Spec.JobTemplate.Spec.Template
		}
		if !matchesLabels(shape.Metadata.Labels, scope) || !matchesContainers(shape.Spec.Containers, scope) {
			return time.Time{}, identity.ErrIdentity
		}
		if parent.Kind == scope.Kind {
			if parent.Metadata.Name != scope.Name || !matchesLabels(parent.Metadata.Labels, scope) || len(parent.Metadata.Owners) > 0 {
				return time.Time{}, identity.ErrIdentity
			}
			return created, nil
		}
		current = parent
	}
	return time.Time{}, identity.ErrIdentity
}

func matchesObject(meta metadata, name, uid, namespace string) bool {
	return meta.Name == name && meta.UID == uid && meta.Namespace == namespace && meta.Deleted == nil
}

func matchesLabels(labels map[string]string, scope identity.Scope) bool {
	return len(labels) <= 128 && labels["app.kubernetes.io/managed-by"] == "raibitserver" && labels["raibitserver.io/project-id"] == scope.ProjectID && labels["raibitserver.io/service-id"] == scope.ServiceID && labels["raibitserver.io/deployment-id"] == scope.DeploymentID
}

func matchesContainers(containers []container, scope identity.Scope) bool {
	if len(containers) != 1 || len(containers[0].EnvFrom) > 0 {
		return false
	}
	hash, err := identity.EnvironmentHash(containers[0].Env)
	if err != nil || hash != scope.EnvironmentHash {
		return false
	}
	return len(containers) == 1 && containers[0].Name == scope.Container && containers[0].Image == scope.Image && strings.Join(containers[0].Command, "\x00") == scope.Command && strings.Join(containers[0].Args, "\x00") == scope.Args
}

func controller(owners []owner) (owner, bool) {
	if len(owners) > 8 {
		return owner{}, false
	}
	var selected owner
	for _, ref := range owners {
		if ref.Controller {
			if selected.UID != "" || ref.UID == "" || len(ref.UID) > 256 || !namePattern.MatchString(ref.Name) {
				return owner{}, false
			}
			selected = ref
		}
	}
	return selected, selected.UID != ""
}
