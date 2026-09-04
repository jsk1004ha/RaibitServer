package backup

import (
	"encoding/base64"
	"fmt"
	"strconv"
	"time"
)

type recoveryNames struct{ snapshot, policy, job string }

func recoveryCredentialSnapshot(job IsolatedJob, source kubernetesSecret, name string) (map[string]any, error) {
	ref := job.spec.Connection.spec.Secret
	value, ok := source.Data[ref.key]
	if !ok {
		return nil, ErrRecoveryJob
	}
	if _, err := base64.StdEncoding.Strict().DecodeString(value); err != nil {
		return nil, ErrRecoveryJob
	}
	return map[string]any{
		"apiVersion": "v1", "kind": "Secret", "immutable": true, "type": "Opaque",
		"metadata": map[string]any{"name": name, "namespace": job.spec.Namespace, "labels": expectedJobLabels(job), "annotations": map[string]any{
			"raibitserver.io/source-secret-uid": source.Metadata.UID, "raibitserver.io/source-secret-resource-version": source.Metadata.ResourceVersion, "raibitserver.io/source-secret-key": ref.key,
		}},
		"data": map[string]any{ref.key: value},
	}, nil
}

func recoveryJobManifest(job IsolatedJob, name, snapshotName, snapshotUID string) (map[string]any, int, error) {
	if !providerUIDPattern.MatchString(snapshotUID) {
		return nil, 0, ErrRecoveryJob
	}
	containers := make([]any, len(job.spec.Steps))
	streamStep := -1
	for i, step := range job.spec.Steps {
		container, err := recoveryStepContainer(job, step, i, snapshotName)
		if err != nil {
			return nil, 0, err
		}
		containers[i] = container
		if step.binding != StreamNone {
			streamStep = i
		}
	}
	if streamStep < 0 {
		return nil, 0, ErrRecoveryJob
	}
	podSpec := map[string]any{
		"automountServiceAccountToken": false, "restartPolicy": "Never", "terminationGracePeriodSeconds": 10,
		"securityContext": map[string]any{"runAsNonRoot": true, "runAsUser": job.security.runAsUser, "runAsGroup": job.security.runAsUser, "fsGroup": job.security.runAsUser, "seccompProfile": map[string]any{"type": "RuntimeDefault"}},
		"containers":      []any{containers[len(containers)-1]},
	}
	if len(containers) > 1 {
		podSpec["initContainers"] = containers[:len(containers)-1]
	}
	if len(job.spec.SecretFiles) > 0 {
		items := make([]any, len(job.spec.SecretFiles))
		for i, secret := range job.spec.SecretFiles {
			items[i] = map[string]any{"key": secret.ref.key, "path": fmt.Sprintf("secret-%d", i)}
		}
		podSpec["volumes"] = []any{map[string]any{"name": "credentials", "secret": map[string]any{"secretName": snapshotName, "items": items, "defaultMode": 0400}}}
	}
	labels := expectedJobLabels(job)
	labels["raibitserver.io/credential-snapshot"] = snapshotName
	return map[string]any{
		"apiVersion": "batch/v1", "kind": "Job",
		"metadata": map[string]any{"name": name, "namespace": job.spec.Namespace, "labels": labels, "annotations": map[string]any{"raibitserver.io/credential-snapshot-uid": snapshotUID, "raibitserver.io/provider-workload-uid": job.spec.Connection.spec.Provenance.spec.UID, "raibitserver.io/provider-workload-generation": strconv.FormatInt(job.spec.Connection.spec.Provenance.spec.Generation, 10)}},
		"spec": map[string]any{"backoffLimit": 0, "activeDeadlineSeconds": int64(job.spec.Deadline / time.Second), "ttlSecondsAfterFinished": 600,
			"template": map[string]any{"metadata": map[string]any{"labels": labels}, "spec": podSpec}},
	}, streamStep, nil
}

func recoveryStepContainer(job IsolatedJob, step CommandStep, index int, snapshotName string) (map[string]any, error) {
	command := step.command
	container := map[string]any{
		"name": fmt.Sprintf("step-%d", index), "image": job.spec.Image, "imagePullPolicy": "IfNotPresent", "command": []any{command.executable}, "args": stringAny(command.args),
		"stdin": step.binding == StreamStdin, "stdinOnce": step.binding == StreamStdin,
		"resources":       map[string]any{"requests": map[string]any{"cpu": strconv.FormatInt(job.spec.CPUMilli, 10) + "m", "memory": strconv.FormatInt(job.spec.MemoryMiB, 10) + "Mi", "ephemeral-storage": strconv.FormatInt(job.spec.EphemeralMiB, 10) + "Mi"}, "limits": map[string]any{"cpu": strconv.FormatInt(job.spec.CPUMilli, 10) + "m", "memory": strconv.FormatInt(job.spec.MemoryMiB, 10) + "Mi", "ephemeral-storage": strconv.FormatInt(job.spec.EphemeralMiB, 10) + "Mi"}},
		"securityContext": map[string]any{"allowPrivilegeEscalation": false, "readOnlyRootFilesystem": true, "runAsNonRoot": true, "runAsUser": job.security.runAsUser, "capabilities": map[string]any{"drop": []any{"ALL"}}},
	}
	if len(job.spec.Secrets) > 0 {
		env := make([]any, len(job.spec.Secrets))
		for i, secret := range job.spec.Secrets {
			if !secret.ref.sameRef(job.spec.Connection.spec.Secret) {
				return nil, ErrRecoveryJob
			}
			env[i] = map[string]any{"name": secret.name, "valueFrom": map[string]any{"secretKeyRef": map[string]any{"name": snapshotName, "key": secret.ref.key}}}
		}
		container["env"] = env
	}
	if len(job.spec.SecretFiles) > 0 {
		mounts := make([]any, len(job.spec.SecretFiles))
		for i, secret := range job.spec.SecretFiles {
			if !secret.ref.sameRef(job.spec.Connection.spec.Secret) {
				return nil, ErrRecoveryJob
			}
			mounts[i] = map[string]any{"name": "credentials", "mountPath": secret.mountPath, "subPath": fmt.Sprintf("secret-%d", i), "readOnly": true}
		}
		container["volumeMounts"] = mounts
	}
	return container, nil
}

func recoveryNetworkPolicyManifest(job IsolatedJob, name string, workload kubernetesWorkload) map[string]any {
	endpoint := job.spec.Connection.Endpoint().(NetworkEndpoint)
	labels := expectedJobLabels(job)
	providerLabels := make(map[string]any, len(workload.Spec.Template.Metadata.Labels))
	for key, value := range workload.Spec.Template.Metadata.Labels {
		providerLabels[key] = value
	}
	return map[string]any{
		"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": map[string]any{"name": name, "namespace": job.spec.Namespace, "labels": labels},
		"spec": map[string]any{"podSelector": map[string]any{"matchLabels": labels}, "policyTypes": []any{"Ingress", "Egress"}, "ingress": []any{}, "egress": []any{
			map[string]any{"to": []any{map[string]any{"podSelector": map[string]any{"matchLabels": providerLabels}}}, "ports": []any{map[string]any{"protocol": "TCP", "port": endpoint.spec.Port}}},
			map[string]any{"to": []any{map[string]any{"namespaceSelector": map[string]any{"matchLabels": map[string]any{"kubernetes.io/metadata.name": "kube-system"}}, "podSelector": map[string]any{"matchLabels": map[string]any{"k8s-app": "kube-dns"}}}}, "ports": []any{map[string]any{"protocol": "UDP", "port": 53}, map[string]any{"protocol": "TCP", "port": 53}}},
		}},
	}
}

type kubernetesJobObservation struct {
	Metadata struct {
		Name, Namespace, UID string
		Labels, Annotations  map[string]string
	} `json:"metadata"`
	Spec struct {
		Template struct {
			Spec struct {
				Containers     []observedContainer `json:"containers"`
				InitContainers []observedContainer `json:"initContainers"`
				Volumes        []struct {
					Secret *struct {
						SecretName string `json:"secretName"`
					} `json:"secret"`
				} `json:"volumes"`
			} `json:"spec"`
		} `json:"template"`
	} `json:"spec"`
	Status struct {
		Succeeded      int
		CompletionTime time.Time
	} `json:"status"`
}

type observedContainer struct {
	Image string `json:"image"`
	Env   []struct {
		ValueFrom *struct {
			SecretKeyRef *struct {
				Name string `json:"name"`
			} `json:"secretKeyRef"`
		} `json:"valueFrom"`
	} `json:"env"`
}

func (o kubernetesJobObservation) referencesSnapshot(name string) bool {
	found := false
	containers := append(append([]observedContainer{}, o.Spec.Template.Spec.InitContainers...), o.Spec.Template.Spec.Containers...)
	for _, container := range containers {
		for _, env := range container.Env {
			if env.ValueFrom != nil && env.ValueFrom.SecretKeyRef != nil {
				if env.ValueFrom.SecretKeyRef.Name != name {
					return false
				}
				found = true
			}
		}
	}
	for _, volume := range o.Spec.Template.Spec.Volumes {
		if volume.Secret != nil {
			if volume.Secret.SecretName != name {
				return false
			}
			found = true
		}
	}
	return found
}

func (o kubernetesJobObservation) completed() (CompletedJobObservation, error) {
	if len(o.Spec.Template.Spec.Containers) != 1 {
		return CompletedJobObservation{}, ErrRecoveryJob
	}
	return CompletedJobObservation{Name: o.Metadata.Name, UID: o.Metadata.UID, Image: o.Spec.Template.Spec.Containers[0].Image, SpecIdentity: o.Metadata.Labels["raibitserver.io/spec-identity"], Succeeded: o.Status.Succeeded == 1, CompletionTime: o.Status.CompletionTime, Labels: o.Metadata.Labels}, nil
}

func stringAny(values []string) []any {
	result := make([]any, len(values))
	for i := range values {
		result[i] = values[i]
	}
	return result
}
