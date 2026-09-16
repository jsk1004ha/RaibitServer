package kube

import (
	"encoding/json"
	"testing"
)

func TestHealthHappyObservesActualOwnedGeneration(t *testing.T) {
	// Given
	spec := workloadSpec("web", "dep-health", nil, nil)
	raw := healthDeploymentJSON(t, spec, nil)
	// When
	observed, err := ObserveDeployment(raw, spec)
	// Then
	if err != nil || observed.UID != "uid-actual" || observed.Generation != 17 {
		t.Fatalf("observation=%#v err=%v", observed, err)
	}
}

func TestHealthFailureMatrixRejectsUnownedIncompleteGeneration(t *testing.T) {
	for name, mutate := range map[string]func(map[string]any){
		"uid":             func(row map[string]any) { row["metadata"].(map[string]any)["uid"] = "" },
		"wrong namespace": func(row map[string]any) { row["metadata"].(map[string]any)["namespace"] = "other" },
		"wrong name":      func(row map[string]any) { row["metadata"].(map[string]any)["name"] = "other" },
		"wrong owner": func(row map[string]any) {
			row["metadata"].(map[string]any)["labels"].(map[string]any)["raibitserver.io/deployment-id"] = "other"
		},
		"overflow":     func(row map[string]any) { row["metadata"].(map[string]any)["generation"] = int64(2147483648) },
		"zero":         func(row map[string]any) { row["metadata"].(map[string]any)["generation"] = 0 },
		"fractional":   func(row map[string]any) { row["metadata"].(map[string]any)["generation"] = 1.5 },
		"unobserved":   func(row map[string]any) { row["status"].(map[string]any)["observedGeneration"] = 16 },
		"unready":      func(row map[string]any) { row["status"].(map[string]any)["readyReplicas"] = 0 },
		"old replicas": func(row map[string]any) { row["status"].(map[string]any)["replicas"] = 2 },
		"deleting": func(row map[string]any) {
			row["metadata"].(map[string]any)["deletionTimestamp"] = "2026-09-03T00:00:00Z"
		},
	} {
		t.Run(name, func(t *testing.T) {
			// Given
			spec := workloadSpec("web", "dep-health", nil, nil)
			raw := healthDeploymentJSON(t, spec, mutate)
			// When
			_, err := ObserveDeployment(raw, spec)
			// Then
			if err == nil {
				t.Fatal("invalid observation accepted")
			}
		})
	}
}

func healthDeploymentJSON(t *testing.T, spec AppServiceSpec, mutate func(map[string]any)) []byte {
	t.Helper()
	row := map[string]any{"apiVersion": "apps/v1", "kind": "Deployment", "metadata": map[string]any{"name": spec.Name, "namespace": spec.Namespace, "uid": "uid-actual", "generation": 17, "labels": workloadLabels(spec)}, "spec": map[string]any{"replicas": 1}, "status": map[string]any{"observedGeneration": 17, "replicas": 1, "updatedReplicas": 1, "readyReplicas": 1, "availableReplicas": 1}}
	if mutate != nil {
		mutate(row)
	}
	raw, err := json.Marshal(row)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
