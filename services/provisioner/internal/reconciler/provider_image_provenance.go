package reconciler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/raibitserver/provisioner/internal/command"
	"github.com/raibitserver/provisioner/internal/provider"
)

var errProviderImageEvidence = errors.New("provider image provenance evidence is invalid")

const maxProviderEvidenceBytes = 1 << 20

// providerImageProvenance records observed workload spec, not signature verification.
type providerImageProvenance struct {
	Schema             string `json:"schema"`
	Image              string `json:"image"`
	WorkloadUID        string `json:"workloadUid"`
	WorkloadGeneration int64  `json:"workloadGeneration"`
	ObservedAt         string `json:"observedAt"`
}

type providerWorkload struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Metadata   struct {
		Name       string            `json:"name"`
		Namespace  string            `json:"namespace"`
		UID        string            `json:"uid"`
		Generation int64             `json:"generation"`
		Labels     map[string]string `json:"labels"`
	} `json:"metadata"`
	Spec struct {
		Template struct {
			Spec struct {
				Containers []struct {
					Name  string `json:"name"`
					Image string `json:"image"`
				} `json:"containers"`
			} `json:"spec"`
		} `json:"template"`
	} `json:"spec"`
}

type providerImageObserver struct {
	plan    *provider.Plan
	runner  command.Runner
	timeout time.Duration
}

func (o providerImageObserver) ownedWorkload(payload []byte) (providerWorkload, error) {
	var workload providerWorkload
	if len(payload) > maxProviderEvidenceBytes || json.Unmarshal(payload, &workload) != nil {
		return workload, errProviderImageEvidence
	}
	metadata := workload.Metadata
	if workload.APIVersion != "apps/v1" || workload.Kind != "StatefulSet" || metadata.Name != o.plan.Name || metadata.Namespace != o.plan.Namespace || !credentialUIDPattern.MatchString(metadata.UID) || metadata.Generation < 1 {
		return workload, errProviderImageEvidence
	}
	for key, expected := range o.plan.Labels {
		if metadata.Labels[key] != expected {
			return workload, errProviderImageEvidence
		}
	}
	providerContainers := 0
	for _, container := range workload.Spec.Template.Spec.Containers {
		if container.Name == o.plan.Name {
			providerContainers++
			if container.Image != o.plan.Image {
				return workload, errProviderImageEvidence
			}
		}
	}
	if providerContainers != 1 {
		return workload, errProviderImageEvidence
	}
	return workload, nil
}

// kubectl can print either a List or a stream of objects for a multi-object apply.
func (o providerImageObserver) appliedWorkload(payload []byte) (providerWorkload, error) {
	var applied providerWorkload
	if len(payload) > maxProviderEvidenceBytes {
		return applied, errProviderImageEvidence
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	objects := make([]json.RawMessage, 0, 8)
	for len(objects) < 32 {
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return applied, errProviderImageEvidence
		}
		var envelope struct {
			Kind  string            `json:"kind"`
			Items []json.RawMessage `json:"items"`
		}
		if json.Unmarshal(raw, &envelope) != nil {
			return applied, errProviderImageEvidence
		}
		if envelope.Kind == "List" {
			objects = append(objects, envelope.Items...)
		} else {
			objects = append(objects, raw)
		}
	}
	if len(objects) >= 32 {
		return applied, errProviderImageEvidence
	}
	found := false
	for _, raw := range objects {
		var identity struct {
			Kind string `json:"kind"`
		}
		if json.Unmarshal(raw, &identity) != nil {
			return applied, errProviderImageEvidence
		}
		if identity.Kind != "StatefulSet" {
			continue
		}
		if found {
			return applied, errProviderImageEvidence
		}
		var err error
		applied, err = o.ownedWorkload(raw)
		if err != nil {
			return applied, err
		}
		found = true
	}
	if !found {
		return applied, errProviderImageEvidence
	}
	return applied, nil
}

func (o providerImageObserver) applyAndObserve(ctx context.Context, manifestFile string) (string, providerImageProvenance, error) {
	var record providerImageProvenance
	commandLine, payload, err := o.runner.RunSensitiveOutput(ctx, "kubectl", []string{"apply", "--server-side", "-f", manifestFile, "--output=json"}, o.timeout)
	if err != nil {
		return commandLine, record, err
	}
	applied, err := o.appliedWorkload(payload)
	if err != nil {
		return commandLine, record, err
	}
	waitContext, cancel := context.WithTimeout(ctx, o.timeout)
	defer cancel()
	arguments := []string{"get", "statefulset/" + o.plan.Name, "--namespace", o.plan.Namespace, "--output=json"}
	for {
		commandLine, payload, err = o.runner.RunSensitiveOutput(waitContext, "kubectl", arguments, min(o.timeout, 10*time.Second))
		if err != nil {
			return commandLine, record, err
		}
		observed, err := o.ownedWorkload(payload)
		if err != nil {
			return commandLine, record, err
		}
		if observed.Metadata.UID != applied.Metadata.UID || observed.Metadata.Generation != applied.Metadata.Generation {
			return commandLine, record, errProviderImageEvidence
		}
		ready, err := statefulSetReady(payload)
		if err != nil {
			return commandLine, record, err
		}
		if ready {
			return commandLine, providerImageProvenance{
				Schema: "raibitserver.provider-image/v1", Image: o.plan.Image,
				WorkloadUID: observed.Metadata.UID, WorkloadGeneration: observed.Metadata.Generation,
				ObservedAt: time.Now().UTC().Format(time.RFC3339Nano),
			}, nil
		}
		timer := time.NewTimer(time.Second)
		select {
		case <-waitContext.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return commandLine, record, fmt.Errorf("observe applied provider rollout: %w", waitContext.Err())
		case <-timer.C:
		}
	}
}
