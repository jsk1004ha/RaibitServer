package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/raibitserver/provisioner/internal/command"
)

const recoveryAuthorityLabel = "raibitserver.io/recovery-authority"

type kubernetesPod struct {
	Metadata struct {
		Name, Namespace, UID, ResourceVersion, DeletionTimestamp string
		Labels                                                map[string]string
		OwnerReferences                                       []struct {
			APIVersion, Kind, Name, UID string
			Controller                  *bool
		} `json:"ownerReferences"`
	} `json:"metadata"`
	Spec struct {
		Containers []struct{ Image string } `json:"containers"`
	} `json:"spec"`
}

type kubernetesPodList struct {
	Items []kubernetesPod `json:"items"`
}

func (c *CommandKubernetesJobClient) readProviderPod(ctx context.Context, workload kubernetesWorkload, job IsolatedJob) (kubernetesPod, error) {
	labels := workload.Spec.Template.Metadata.Labels
	selector := strings.Join([]string{
		"app.kubernetes.io/name=" + labels["app.kubernetes.io/name"],
		"app.kubernetes.io/managed-by=raibitserver",
		"raibitserver.io/managed=true",
		"raibitserver.io/resource-id=" + labels["raibitserver.io/resource-id"],
		"raibitserver.io/project-id=" + labels["raibitserver.io/project-id"],
	}, ",")
	var pods kubernetesPodList
	if err := c.readJSON(ctx, []string{"get", "pods", "--namespace", workload.Metadata.Namespace, "--selector", selector, "-o", "json"}, &pods); err != nil || len(pods.Items) != 1 || !validObservedPod(pods.Items[0], workload, job, "") {
		return kubernetesPod{}, errors.Join(ErrRecoveryJob, err)
	}
	return pods.Items[0], nil
}

func (c *CommandKubernetesJobClient) readPod(ctx context.Context, namespace, name string) (kubernetesPod, error) {
	var pod kubernetesPod
	err := c.readJSON(ctx, []string{"get", "pod/" + name, "--namespace", namespace, "-o", "json"}, &pod)
	return pod, err
}

func recoveryAuthorityValue(job IsolatedJob, workload kubernetesWorkload, pod kubernetesPod, snapshotUID string) string {
	digest := sha256.Sum256([]byte(job.Identity() + "\x00" + workload.Metadata.UID + "\x00" + pod.Metadata.UID + "\x00" + snapshotUID))
	return hex.EncodeToString(digest[:16])
}

func (c *CommandKubernetesJobClient) bindProviderPod(ctx context.Context, pod kubernetesPod, workload kubernetesWorkload, job IsolatedJob, authority string) (kubernetesPod, error) {
	if !validObservedPod(pod, workload, job, "") || pod.Metadata.Labels[recoveryAuthorityLabel] != "" {
		return kubernetesPod{}, ErrRecoveryJob
	}
	patch, err := json.Marshal([]map[string]string{
		{"op": "test", "path": "/metadata/uid", "value": pod.Metadata.UID},
		{"op": "test", "path": "/metadata/resourceVersion", "value": pod.Metadata.ResourceVersion},
		{"op": "add", "path": "/metadata/labels/raibitserver.io~1recovery-authority", "value": authority},
	})
	if err != nil {
		return kubernetesPod{}, ErrRecoveryJob
	}
	var bound kubernetesPod
	args := []string{"patch", "pod/" + pod.Metadata.Name, "--namespace", pod.Metadata.Namespace, "--type=json", "-p", string(patch), "-o", "json"}
	if err := c.readJSON(ctx, args, &bound); err != nil || !validObservedPod(bound, workload, job, authority) || bound.Metadata.UID != pod.Metadata.UID || bound.Metadata.ResourceVersion == pod.Metadata.ResourceVersion {
		return kubernetesPod{}, errors.Join(ErrRecoveryJob, err)
	}
	return bound, nil
}

func validObservedPod(pod kubernetesPod, workload kubernetesWorkload, job IsolatedJob, authority string) bool {
	if pod.Metadata.Namespace != workload.Metadata.Namespace || pod.Metadata.Name == "" || !providerUIDPattern.MatchString(pod.Metadata.UID) || pod.Metadata.ResourceVersion == "" || pod.Metadata.DeletionTimestamp != "" || len(pod.Metadata.OwnerReferences) != 1 || len(pod.Spec.Containers) != 1 || pod.Spec.Containers[0].Image != job.spec.Connection.spec.Provenance.spec.Image {
		return false
	}
	owner := pod.Metadata.OwnerReferences[0]
	if owner.Controller == nil || !*owner.Controller || owner.APIVersion != "apps/v1" || owner.Kind != "StatefulSet" || owner.Name != workload.Metadata.Name || owner.UID != workload.Metadata.UID {
		return false
	}
	for key, value := range workload.Spec.Template.Metadata.Labels {
		if pod.Metadata.Labels[key] != value {
			return false
		}
	}
	return authority == "" || pod.Metadata.Labels[recoveryAuthorityLabel] == authority
}

func sameBoundProviderPod(left, right kubernetesPod, workload kubernetesWorkload, job IsolatedJob, authority string) bool {
	return validObservedPod(right, workload, job, authority) && left.Metadata.Name == right.Metadata.Name && left.Metadata.Namespace == right.Metadata.Namespace && left.Metadata.UID == right.Metadata.UID
}

func (c *CommandKubernetesJobClient) releaseProviderPod(ctx context.Context, created CreatedJobObservation) error {
	if created.providerPodName == "" || created.providerPodUID == "" || created.authority == "" {
		return nil
	}
	pod, err := c.readPod(ctx, created.Namespace, created.providerPodName)
	if errors.Is(err, command.ErrObjectNotFound) {
		return nil
	}
	if err != nil || pod.Metadata.UID != created.providerPodUID {
		return errors.Join(ErrRecoveryJob, err)
	}
	if pod.Metadata.Labels[recoveryAuthorityLabel] == "" {
		return nil
	}
	if pod.Metadata.Labels[recoveryAuthorityLabel] != created.authority {
		return ErrRecoveryJob
	}
	patch, err := json.Marshal([]map[string]string{
		{"op": "test", "path": "/metadata/uid", "value": created.providerPodUID},
		{"op": "test", "path": "/metadata/resourceVersion", "value": pod.Metadata.ResourceVersion},
		{"op": "test", "path": "/metadata/labels/raibitserver.io~1recovery-authority", "value": created.authority},
		{"op": "remove", "path": "/metadata/labels/raibitserver.io~1recovery-authority"},
	})
	if err != nil {
		return ErrRecoveryJob
	}
	_, err = c.runner.Run(ctx, "kubectl", []string{"patch", "pod/" + created.providerPodName, "--namespace", created.Namespace, "--type=json", "-p", string(patch)}, false, c.timeout)
	if errors.Is(err, command.ErrObjectNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("release recovery provider authority: %w", err)
	}
	return nil
}
