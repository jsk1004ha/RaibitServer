package kube

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
)

var ErrWorkloadObservation = errors.New("owned Kubernetes deployment observation is unavailable")

type WorkloadObservation struct {
	UID        string
	Generation int
}

type deploymentObservationJSON struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Metadata   struct {
		Name              string            `json:"name"`
		Namespace         string            `json:"namespace"`
		UID               string            `json:"uid"`
		Generation        int64             `json:"generation"`
		DeletionTimestamp string            `json:"deletionTimestamp"`
		Labels            map[string]string `json:"labels"`
	} `json:"metadata"`
	Spec struct {
		Replicas *int64 `json:"replicas"`
	} `json:"spec"`
	Status struct {
		ObservedGeneration  int64 `json:"observedGeneration"`
		Replicas            int64 `json:"replicas"`
		UpdatedReplicas     int64 `json:"updatedReplicas"`
		ReadyReplicas       int64 `json:"readyReplicas"`
		AvailableReplicas   int64 `json:"availableReplicas"`
		UnavailableReplicas int64 `json:"unavailableReplicas"`
	} `json:"status"`
}

func ObserveDeployment(raw []byte, expected AppServiceSpec) (WorkloadObservation, error) {
	if len(raw) > 128*1024 {
		return WorkloadObservation{}, ErrWorkloadObservation
	}
	var object deploymentObservationJSON
	if err := json.Unmarshal(raw, &object); err != nil {
		return WorkloadObservation{}, ErrWorkloadObservation
	}
	metadata := object.Metadata
	if object.APIVersion != "apps/v1" || object.Kind != "Deployment" || metadata.Name != expected.Name || metadata.Namespace != expected.Namespace || metadata.DeletionTimestamp != "" {
		return WorkloadObservation{}, ErrWorkloadObservation
	}
	if metadata.UID == "" || len(metadata.UID) > 128 || strings.TrimSpace(metadata.UID) != metadata.UID || metadata.Generation < 1 || metadata.Generation > math.MaxInt32 {
		return WorkloadObservation{}, ErrWorkloadObservation
	}
	for key, value := range map[string]string{"app.kubernetes.io/managed-by": "raibitserver", "raibitserver.io/project-id": expected.ProjectID, "raibitserver.io/service-id": expected.ServiceID, "raibitserver.io/deployment-id": expected.DeploymentID} {
		if value == "" || metadata.Labels[key] != value {
			return WorkloadObservation{}, ErrWorkloadObservation
		}
	}
	replicas := int64(1)
	if object.Spec.Replicas != nil {
		replicas = *object.Spec.Replicas
	}
	status := object.Status
	if replicas < 1 || status.ObservedGeneration != metadata.Generation || status.Replicas != replicas || status.UpdatedReplicas != replicas || status.ReadyReplicas != replicas || status.AvailableReplicas != replicas || status.UnavailableReplicas != 0 {
		return WorkloadObservation{}, ErrWorkloadObservation
	}
	return WorkloadObservation{UID: metadata.UID, Generation: int(metadata.Generation)}, nil
}
