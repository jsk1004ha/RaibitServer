package kube

import (
	"context"
	"slices"
	"time"

	"github.com/raibitserver/metrics-ingester/internal/identity"
	"github.com/raibitserver/metrics-ingester/internal/ingester"
)

type (
	owner struct {
		APIVersion, Kind, Name, UID string
		Controller                  bool
	}
	metadata struct {
		Name, Namespace, UID string
		CreationTimestamp    time.Time
		DeletionTimestamp    *time.Time
		Labels               map[string]string
		OwnerReferences      []owner
	}
)

type (
	container struct {
		Name, Image   string
		Command, Args []string
		Env           []identity.EnvironmentEntry
	}
	podSpec  struct{ Containers []container }
	template struct {
		Metadata metadata
		Spec     podSpec
	}
	object struct {
		APIVersion, Kind string
		Metadata         metadata
		Spec             struct {
			Containers  []container
			Template    template
			JobTemplate struct{ Spec struct{ Template template } }
		}
	}
)

func (c *Client) Verify(ctx context.Context, sample ingester.PodMetrics, scope identity.Scope) (ingester.VerifiedPod, error) {
	if sample.Namespace != scope.Namespace || !validName(sample.Name, 253) {
		return ingester.VerifiedPod{}, identity.ErrIdentity
	}
	for label, want := range map[string]string{"raibitserver.io/project-id": scope.ProjectID, "raibitserver.io/service-id": scope.ServiceID, "raibitserver.io/deployment-id": scope.DeploymentID} {
		if value, ok := sample.Labels[label]; ok && value != want {
			return ingester.VerifiedPod{}, identity.ErrIdentity
		}
	}
	var ns object
	if err := c.get(ctx, "/api/v1/namespaces/"+scope.Namespace, &ns); err != nil {
		return ingester.VerifiedPod{}, err
	}
	if !boundedMetadata(ns.Metadata) || ns.Kind != "Namespace" || ns.APIVersion != "v1" || ns.Metadata.Name != scope.Namespace || ns.Metadata.DeletionTimestamp != nil || ns.Metadata.Labels["raibitserver.io/project-id"] != scope.ProjectID || ns.Metadata.Labels["app.kubernetes.io/managed-by"] != "raibitserver" {
		return ingester.VerifiedPod{}, identity.ErrIdentity
	}
	var pod object
	if err := c.get(ctx, "/api/v1/namespaces/"+scope.Namespace+"/pods/"+sample.Name, &pod); err != nil {
		return ingester.VerifiedPod{}, err
	}
	if !validObject(pod, owner{APIVersion: "v1", Kind: "Pod", Name: sample.Name, UID: pod.Metadata.UID}, scope.Namespace) || !scope.Labels(pod.Metadata.Labels) || pod.Metadata.CreationTimestamp.IsZero() || (sample.UID != "" && sample.UID != pod.Metadata.UID) || sample.Timestamp.Before(pod.Metadata.CreationTimestamp) || !matchesContainers(pod.Spec.Containers, scope) {
		return ingester.VerifiedPod{}, identity.ErrIdentity
	}
	current := pod
	seen := map[string]bool{pod.Metadata.UID: true}
	for depth := 0; depth < 3; depth++ {
		ref, ok := controller(current.Metadata.OwnerReferences)
		if !ok || seen[ref.UID] {
			return ingester.VerifiedPod{}, identity.ErrIdentity
		}
		resource, version := "", ""
		switch ref.Kind {
		case "ReplicaSet":
			if current.Kind != "Pod" || scope.Kind != "Deployment" {
				return ingester.VerifiedPod{}, identity.ErrIdentity
			}
			resource, version = "replicasets", "apps/v1"
		case "Deployment":
			if current.Kind != "ReplicaSet" || scope.Kind != "Deployment" {
				return ingester.VerifiedPod{}, identity.ErrIdentity
			}
			resource, version = "deployments", "apps/v1"
		case "Job":
			if current.Kind != "Pod" || scope.Kind == "Deployment" {
				return ingester.VerifiedPod{}, identity.ErrIdentity
			}
			resource, version = "jobs", "batch/v1"
		case "CronJob":
			if current.Kind != "Job" || scope.Kind != "CronJob" {
				return ingester.VerifiedPod{}, identity.ErrIdentity
			}
			resource, version = "cronjobs", "batch/v1"
		default:
			return ingester.VerifiedPod{}, identity.ErrIdentity
		}
		if ref.APIVersion != version || !validName(ref.Name, 253) {
			return ingester.VerifiedPod{}, identity.ErrIdentity
		}
		var parent object
		if err := c.get(ctx, "/apis/"+version+"/namespaces/"+scope.Namespace+"/"+resource+"/"+ref.Name, &parent); err != nil {
			return ingester.VerifiedPod{}, err
		}
		if !validObject(parent, ref, scope.Namespace) {
			return ingester.VerifiedPod{}, identity.ErrIdentity
		}
		wanted := parent.Spec.Template
		if parent.Kind == "CronJob" {
			wanted = parent.Spec.JobTemplate.Spec.Template
		}
		if !boundedMetadata(wanted.Metadata) || !scope.Labels(wanted.Metadata.Labels) || !matchesContainers(wanted.Spec.Containers, scope) {
			return ingester.VerifiedPod{}, identity.ErrIdentity
		}
		if parent.Kind == scope.Kind {
			if parent.Metadata.Name != scope.WorkloadName || !scope.Labels(parent.Metadata.Labels) {
				return ingester.VerifiedPod{}, identity.ErrIdentity
			}
			return ingester.VerifiedPod{UID: pod.Metadata.UID, CreatedAt: pod.Metadata.CreationTimestamp}, nil
		}
		seen[parent.Metadata.UID] = true
		current = parent
	}
	return ingester.VerifiedPod{}, identity.ErrIdentity
}

func validObject(value object, ref owner, namespace string) bool {
	return boundedMetadata(value.Metadata) && value.Kind == ref.Kind && value.APIVersion == ref.APIVersion && value.Metadata.Name == ref.Name && value.Metadata.UID == ref.UID && validName(ref.UID, 128) && value.Metadata.Namespace == namespace && value.Metadata.DeletionTimestamp == nil
}

func boundedMetadata(value metadata) bool {
	if len(value.Name) > 253 || len(value.Namespace) > 63 || len(value.UID) > 128 || len(value.Labels) > 64 || len(value.OwnerReferences) > 8 {
		return false
	}
	for key, label := range value.Labels {
		if len(key) > 253 || len(label) > 256 {
			return false
		}
	}
	for _, ref := range value.OwnerReferences {
		if len(ref.APIVersion) > 32 || len(ref.Kind) > 32 || len(ref.Name) > 253 || len(ref.UID) > 128 {
			return false
		}
	}
	return true
}

func controller(refs []owner) (owner, bool) {
	var found owner
	count := 0
	for _, ref := range refs {
		if ref.Controller {
			found = ref
			count++
		}
	}
	return found, count == 1 && found.UID != ""
}

func matchesContainers(containers []container, scope identity.Scope) bool {
	if len(containers) != 1 {
		return false
	}
	envHash, err := identity.EnvironmentHash(containers[0].Env)
	return err == nil && envHash == scope.EnvironmentHash && containers[0].Name == scope.ContainerName && containers[0].Image == scope.Image && slices.Equal(containers[0].Command, scope.Command) && slices.Equal(containers[0].Args, scope.Args)
}
