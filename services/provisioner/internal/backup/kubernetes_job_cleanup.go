package backup

import (
	"context"
	"errors"
	"time"

	"github.com/raibitserver/provisioner/internal/command"
)

func (c *CommandKubernetesJobClient) CleanupJob(ctx context.Context, created CreatedJobObservation) error {
	cleanupTimeout := min(c.timeout, 30*time.Second)
	cleanupContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
	defer cancel()
	return c.cleanup(cleanupContext, created)
}

func (c *CommandKubernetesJobClient) cleanup(ctx context.Context, created CreatedJobObservation) error {
	if err := c.stopCreatedJob(ctx, created); err != nil {
		return err
	}
	var result error
	objects := []struct{ resource, name, uid string }{
		{"networkpolicy", created.policyName, created.policyUID},
		{"secret", created.snapshotName, created.snapshotUID},
	}
	for _, object := range objects {
		if object.name == "" {
			continue
		}
		uid := object.uid
		if uid == "" {
			var err error
			uid, err = c.readOwnedObjectUID(ctx, object.resource, created.Namespace, object.name, created.labels)
			if errors.Is(err, command.ErrObjectNotFound) {
				continue
			}
			if err != nil {
				result = errors.Join(result, err)
				continue
			}
		}
		_, err := c.runner.DeleteObjectUID(ctx, object.resource, created.Namespace, object.name, uid, c.timeout)
		result = errors.Join(result, err)
	}
	return errors.Join(result, c.releaseProviderPod(ctx, created))
}

func (c *CommandKubernetesJobClient) stopCreatedJob(ctx context.Context, created CreatedJobObservation) error {
	if created.Name == "" {
		return nil
	}
	uid := created.UID
	if uid == "" {
		var err error
		uid, err = c.readOwnedObjectUID(ctx, "job", created.Namespace, created.Name, created.labels)
		if err != nil && !errors.Is(err, command.ErrObjectNotFound) {
			return err
		}
	}
	if uid == "" {
		return ErrRecoveryJob
	}
	if _, err := c.runner.DeleteObjectUID(ctx, "job", created.Namespace, created.Name, uid, c.timeout); err != nil {
		return err
	}
	if _, err := c.runner.Run(ctx, "kubectl", []string{"wait", "--for=delete", "job/" + created.Name, "--namespace", created.Namespace, "--timeout", c.timeout.String()}, false, c.timeout); err != nil {
		return err
	}
	if _, err := c.readOwnedObjectUID(ctx, "job", created.Namespace, created.Name, created.labels); !errors.Is(err, command.ErrObjectNotFound) {
		return errors.Join(ErrRecoveryJob, err)
	}
	var pods struct {
		APIVersion string        `json:"apiVersion"`
		Kind       string        `json:"kind"`
		Items      []recoveryPod `json:"items"`
	}
	selector := "job-name=" + created.Name + ",batch.kubernetes.io/controller-uid=" + uid
	if err := c.readJSON(ctx, []string{"get", "pods", "--namespace", created.Namespace, "-l", selector, "-o", "json"}, &pods); err != nil || pods.APIVersion != "v1" || pods.Kind != "PodList" || len(pods.Items) != 0 {
		if err != nil || pods.APIVersion != "v1" || pods.Kind != "PodList" {
			return errors.Join(ErrRecoveryJob, err)
		}
		for _, pod := range pods.Items {
			for _, owner := range pod.Metadata.OwnerReferences {
				if owner.Controller != nil && *owner.Controller && owner.APIVersion == "batch/v1" && owner.Kind == "Job" && owner.Name == created.Name && owner.UID == uid {
					return ErrRecoveryJob
				}
			}
		}
	}
	return nil
}

func (c *CommandKubernetesJobClient) readOwnedObjectUID(ctx context.Context, resource, namespace, name string, labels map[string]string) (string, error) {
	var observed struct {
		Metadata command.SecretMetadata `json:"metadata"`
	}
	if resource == "secret" {
		_, metadata, err := c.runner.GetSecretMetadata(ctx, namespace, name, c.timeout)
		if errors.Is(err, command.ErrSecretNotFound) {
			return "", command.ErrObjectNotFound
		}
		if err != nil || metadata == nil {
			return "", errors.Join(ErrRecoveryJob, err)
		}
		observed.Metadata = *metadata
	} else if err := c.readJSON(ctx, []string{"get", resource + "/" + name, "--namespace", namespace, "-o", "json"}, &observed); err != nil {
		return "", err
	}
	if observed.Metadata.Name != name || observed.Metadata.Namespace != namespace || !providerUIDPattern.MatchString(observed.Metadata.UID) {
		return "", ErrRecoveryJob
	}
	for key, value := range labels {
		if observed.Metadata.Labels[key] != value {
			return "", ErrRecoveryJob
		}
	}
	return observed.Metadata.UID, nil
}
