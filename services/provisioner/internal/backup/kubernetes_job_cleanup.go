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
	var result error
	objects := []struct{ resource, name, uid string }{
		{"job", created.Name, created.UID},
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

func (c *CommandKubernetesJobClient) readOwnedObjectUID(ctx context.Context, resource, namespace, name string, labels map[string]string) (string, error) {
	var observed struct {
		Metadata struct {
			Name, Namespace, UID string
			Labels               map[string]string
		} `json:"metadata"`
	}
	if err := c.readJSON(ctx, []string{"get", resource + "/" + name, "--namespace", namespace, "-o", "json"}, &observed); err != nil {
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
