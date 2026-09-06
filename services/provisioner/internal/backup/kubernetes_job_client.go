package backup

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/raibitserver/provisioner/internal/command"
)

const maxKubernetesObjectBytes = 1 << 20

type recoveryCommandRunner interface {
	Run(context.Context, string, []string, bool, time.Duration) (string, error)
	RunCreateInputUID(context.Context, string, []string, []byte, time.Duration) (string, string, error)
	RunSensitiveOutput(context.Context, string, []string, time.Duration) (string, []byte, error)
	DeleteObjectUID(context.Context, string, string, string, string, time.Duration) (string, error)
}

type CommandKubernetesJobClient struct {
	runner   recoveryCommandRunner
	streamer command.StreamingRunner
	timeout  time.Duration
}

func NewCommandKubernetesJobClient(r recoveryCommandRunner, timeout time.Duration) (*CommandKubernetesJobClient, error) {
	streamer, ok := r.(command.StreamingRunner)
	if r == nil || !ok || timeout < time.Second || timeout > MaxDuration {
		return nil, ErrRecoveryJob
	}
	return &CommandKubernetesJobClient{runner: r, streamer: streamer, timeout: timeout}, nil
}

type kubernetesSecret struct {
	Metadata struct {
		Name, Namespace, UID, ResourceVersion string
		Labels, Annotations                   map[string]string
	} `json:"metadata"`
	Immutable *bool             `json:"immutable"`
	Data      map[string]string `json:"data"`
}

type kubernetesWorkload struct {
	Metadata struct {
		Name, Namespace, UID string
		Generation           int64
		Labels               map[string]string
	} `json:"metadata"`
	Spec struct {
		Template struct {
			Metadata struct{ Labels map[string]string }            `json:"metadata"`
			Spec     struct{ Containers []struct{ Image string } } `json:"spec"`
		} `json:"template"`
	} `json:"spec"`
}

func (c *CommandKubernetesJobClient) CreateAuthorizedJob(ctx context.Context, job IsolatedJob, stream JobStream) (created CreatedJobObservation, resultErr error) {
	provider := job.spec.Connection.spec.Provenance.spec
	workload, err := c.readWorkload(ctx, provider.Namespace, provider.Name)
	if err != nil || !validObservedWorkload(workload, job) {
		return created, errors.Join(ErrRecoveryJob, err)
	}
	secretRef := job.spec.Connection.spec.Secret
	secret, err := c.readSecret(ctx, secretRef.namespace, secretRef.name)
	if err != nil || !validObservedSecret(secret, job, secretRef) {
		return created, errors.Join(ErrRecoveryJob, err)
	}
	names := recoveryObjectNames(job)
	snapshot, err := recoveryCredentialSnapshot(job, secret, names.snapshot)
	if err != nil {
		return created, err
	}
	created.Namespace, created.snapshotName = job.spec.Namespace, names.snapshot
	created.labels = expectedJobLabels(job)
	defer func() {
		if resultErr != nil {
			resultErr = errors.Join(resultErr, c.CleanupJob(ctx, created))
		}
	}()
	created.snapshotUID, err = c.createSnapshot(ctx, job, snapshot, secret, names.snapshot, secretRef.key)
	if err != nil {
		return created, err
	}
	pod, err := c.readProviderPod(ctx, workload, job)
	if err != nil {
		return created, err
	}
	created.authority = recoveryAuthorityValue(job, workload, pod, created.snapshotUID)
	created.providerPodName, created.providerPodUID = pod.Metadata.Name, pod.Metadata.UID
	boundPod, err := c.bindProviderPod(ctx, pod, workload, job, created.authority)
	if err != nil {
		return created, err
	}
	created.providerPodName, created.providerPodUID = boundPod.Metadata.Name, boundPod.Metadata.UID
	policy := recoveryNetworkPolicyManifest(job, names.policy, created.authority)
	created.policyName = names.policy
	created.policyUID, err = c.createObject(ctx, policy)
	if err != nil {
		return created, err
	}
	manifest, streamStep, err := recoveryJobManifest(job, names.job, names.snapshot, created.snapshotUID)
	if err != nil {
		return created, err
	}
	steps, helperReceipt, err := materializedRecoverySteps(job)
	if err != nil {
		return created, err
	}
	created.helperReceipt = helperReceipt
	created.streamStep, created.engine, created.image = streamStep, job.spec.Connection.Engine(), job.spec.Image
	created.steps = make([]createdJobStep, len(steps))
	for index, step := range steps {
		if len(step.args) == 1 {
			created.steps[index] = createdJobStep{executable: step.executable, action: step.args[0], binding: step.binding}
		}
	}
	current, err := c.readWorkload(ctx, provider.Namespace, provider.Name)
	if err != nil || !sameObservedWorkload(workload, current) || !validObservedWorkload(current, job) {
		return created, errors.Join(ErrRecoveryJob, err)
	}
	currentPod, err := c.readPod(ctx, boundPod.Metadata.Namespace, boundPod.Metadata.Name)
	if err != nil || !sameBoundProviderPod(boundPod, currentPod, current, job, created.authority) {
		return created, errors.Join(ErrRecoveryJob, err)
	}
	created.Name = names.job
	created.UID, err = c.createObject(ctx, manifest)
	if err != nil {
		return created, err
	}
	if err = c.transfer(ctx, job, created.Name, streamStep, stream); err != nil {
		return created, err
	}
	return created, nil
}

func sameObservedWorkload(left, right kubernetesWorkload) bool {
	leftPayload, leftErr := json.Marshal(left)
	rightPayload, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && string(leftPayload) == string(rightPayload)
}

func (c *CommandKubernetesJobClient) createSnapshot(ctx context.Context, job IsolatedJob, manifest map[string]any, source kubernetesSecret, name, key string) (string, error) {
	uid, err := c.createObject(ctx, manifest)
	if err == nil {
		return uid, nil
	}
	if !errors.Is(err, command.ErrAlreadyExists) {
		return "", err
	}
	existing, readErr := c.readSecret(ctx, source.Metadata.Namespace, name)
	labelsValid := true
	for label, value := range expectedJobLabels(job) {
		labelsValid = labelsValid && existing.Metadata.Labels[label] == value
	}
	if readErr != nil || !labelsValid || existing.Immutable == nil || !*existing.Immutable || existing.Metadata.UID == "" || existing.Metadata.Annotations["raibitserver.io/source-secret-uid"] != source.Metadata.UID || existing.Metadata.Annotations["raibitserver.io/source-secret-resource-version"] != source.Metadata.ResourceVersion || existing.Metadata.Annotations["raibitserver.io/source-secret-key"] != key || len(existing.Data) != 1 || existing.Data[key] != source.Data[key] {
		return "", errors.Join(ErrRecoveryJob, readErr)
	}
	return existing.Metadata.UID, nil
}

func (c *CommandKubernetesJobClient) readSecret(ctx context.Context, namespace, name string) (kubernetesSecret, error) {
	var result kubernetesSecret
	err := c.readJSON(ctx, []string{"get", "secret/" + name, "--namespace", namespace, "-o", "json"}, &result)
	return result, err
}

func (c *CommandKubernetesJobClient) readWorkload(ctx context.Context, namespace, name string) (kubernetesWorkload, error) {
	var result kubernetesWorkload
	err := c.readJSON(ctx, []string{"get", "statefulset/" + name, "--namespace", namespace, "-o", "json"}, &result)
	return result, err
}

func (c *CommandKubernetesJobClient) readJSON(ctx context.Context, args []string, target any) error {
	_, payload, err := c.runner.RunSensitiveOutput(ctx, "kubectl", args, c.timeout)
	if err != nil || len(payload) == 0 || len(payload) > maxKubernetesObjectBytes || json.Unmarshal(payload, target) != nil {
		return errors.Join(ErrRecoveryJob, err)
	}
	return nil
}

func (c *CommandKubernetesJobClient) createObject(ctx context.Context, object map[string]any) (string, error) {
	payload, err := json.Marshal(object)
	if err != nil || len(payload) > maxKubernetesObjectBytes {
		return "", ErrRecoveryJob
	}
	_, uid, err := c.runner.RunCreateInputUID(ctx, "kubectl", []string{"create", "-f", "-", "-o", "jsonpath={.metadata.uid}"}, payload, c.timeout)
	if err != nil || !providerUIDPattern.MatchString(uid) {
		return "", errors.Join(ErrRecoveryJob, err)
	}
	return uid, nil
}

func (c *CommandKubernetesJobClient) transfer(ctx context.Context, job IsolatedJob, name string, step int, stream JobStream) error {
	container := fmt.Sprintf("step-%d", step)
	if bindingMatches(job, dumpDirection) {
		output := stream.Output()
		if output == nil {
			return ErrRecoveryStream
		}
		_, err := c.streamer.RunStream(ctx, "kubectl", []string{"logs", "-f", "job/" + name, "--namespace", job.spec.Namespace, "-c", container}, nil, output, job.spec.Deadline)
		return err
	}
	input := stream.Input()
	if input == nil {
		return ErrRecoveryStream
	}
	_, err := c.streamer.RunStream(ctx, "kubectl", []string{"attach", "-i", "job/" + name, "--namespace", job.spec.Namespace, "-c", container}, input, io.Discard, job.spec.Deadline)
	return err
}

func validObservedSecret(secret kubernetesSecret, job IsolatedJob, ref SecretRef) bool {
	provider := job.spec.Connection.spec.Provenance.spec
	encoded, exists := secret.Data[ref.key]
	decoded, err := base64.StdEncoding.Strict().DecodeString(encoded)
	return secret.Metadata.Namespace == ref.namespace && secret.Metadata.Name == ref.name && secret.Metadata.UID == provider.CredentialUID && secret.Metadata.ResourceVersion != "" && secret.Metadata.Annotations["raibitserver.io/credential-generation"] == provider.CredentialGeneration && secret.Metadata.Annotations["raibitserver.io/credential-owner"] == "raibitserver-provisioner" && secret.Metadata.Annotations["raibitserver.io/resource-id"] == job.spec.Connection.ResourceID() && secret.Metadata.Annotations["raibitserver.io/project-id"] == job.spec.Connection.spec.ProjectID && exists && err == nil && len(decoded) > 0 && len(decoded) <= 64<<10
}

func validObservedWorkload(workload kubernetesWorkload, job IsolatedJob) bool {
	provider := job.spec.Connection.spec.Provenance.spec
	labels := workload.Spec.Template.Metadata.Labels
	return workload.Metadata.Namespace == provider.Namespace && workload.Metadata.Name == provider.Name && workload.Metadata.UID == provider.UID && workload.Metadata.Generation == provider.Generation && len(workload.Spec.Template.Spec.Containers) == 1 && workload.Spec.Template.Spec.Containers[0].Image == provider.Image && labels["app.kubernetes.io/name"] == provider.Name && labels["app.kubernetes.io/managed-by"] == "raibitserver" && labels["raibitserver.io/managed"] == "true" && labels["raibitserver.io/provider"] == string(job.spec.Connection.Engine()) && labels["raibitserver.io/resource-id"] != "" && labels["raibitserver.io/project-id"] != ""
}

func recoveryObjectNames(job IsolatedJob) struct{ snapshot, policy, job string } {
	digest := sha256.Sum256([]byte(job.Identity()))
	suffix := hex.EncodeToString(digest[:12])
	return struct{ snapshot, policy, job string }{"recovery-credential-" + suffix, "recovery-egress-" + suffix, "recovery-job-" + suffix}
}

func (c *CommandKubernetesJobClient) WaitJob(ctx context.Context, created CreatedJobObservation) (CompletedJobObservation, error) {
	if _, err := c.runner.Run(ctx, "kubectl", []string{"wait", "--for=condition=complete", "job/" + created.Name, "--namespace", created.Namespace, "--timeout", c.timeout.String()}, false, c.timeout); err != nil {
		return CompletedJobObservation{}, err
	}
	var observed kubernetesJobObservation
	if err := c.readJSON(ctx, []string{"get", "job/" + created.Name, "--namespace", created.Namespace, "-o", "json"}, &observed); err != nil || observed.Metadata.UID != created.UID || observed.Metadata.Annotations["raibitserver.io/credential-snapshot-uid"] != created.snapshotUID || !observed.referencesSnapshot(created.snapshotName) {
		return CompletedJobObservation{}, errors.Join(ErrRecoveryJob, err)
	}
	return c.completeObservedJob(ctx, created, observed)
}
