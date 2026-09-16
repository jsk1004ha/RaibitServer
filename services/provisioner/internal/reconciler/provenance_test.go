package reconciler

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/provisioner/internal/provider"
	"github.com/raibitserver/provisioner/internal/store"
)

const provenanceUID = "cb630f98-38a8-4f50-98ec-27f814bad651"

type provenanceRunner struct {
	fakeRunner
	applied    []byte
	observed   []byte
	afterApply func()
}

func (r *provenanceRunner) RunSensitiveOutput(ctx context.Context, name string, args []string, timeout time.Duration) (string, []byte, error) {
	call, payload, err := r.fakeRunner.RunSensitiveOutput(ctx, name, args, timeout)
	if strings.Contains(call, "kubectl apply") {
		if r.afterApply != nil {
			r.afterApply()
		}
		return call, r.applied, err
	}
	if strings.Contains(call, "kubectl get statefulset/") && strings.Contains(call, "--output=json") {
		return call, r.observed, err
	}
	return call, payload, err
}

func provenanceFixture(t *testing.T) (*store.Resource, Config, map[string]any) {
	t.Helper()
	resource := &store.Resource{ID: "res-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Status: store.StatusProvisioning}
	config := postgresqlLiveConfig(t.TempDir())
	plan, err := provider.Compile(resource, config.Images["postgresql"])
	if err != nil {
		t.Fatal(err)
	}
	object := plan.PublicManifests[3]
	object["metadata"].(map[string]any)["uid"] = provenanceUID
	object["metadata"].(map[string]any)["generation"] = 7
	object["status"] = map[string]any{"observedGeneration": 7, "replicas": 1, "readyReplicas": 1, "updatedReplicas": 1, "currentRevision": "rev-7", "updateRevision": "rev-7"}
	return resource, config, object
}

func provenanceJSON(t *testing.T, value any) []byte {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func TestProvenancePersistsOnlyAppliedOwnedReadyImage(t *testing.T) {
	// Given a concrete apply response followed by that same owned READY workload.
	resource, config, object := provenanceFixture(t)
	state := &fakeStore{resource: resource}
	runner := &provenanceRunner{applied: provenanceJSON(t, map[string]any{"kind": "List", "items": []any{object}}), observed: provenanceJSON(t, object)}
	// When the actual provisioning path completes.
	result, err := New(config, state, runner).RunOnce(context.Background())
	// Then the fenced READY record names the exact observed incarnation, not a configuration-only plan.
	if err != nil || result.Status != store.StatusReady {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	var record struct {
		Schema, Image, WorkloadUid, ObservedAt string
		WorkloadGeneration                     int64
	}
	if err := json.Unmarshal(provenanceJSON(t, state.lastDesiredState["providerImageProvenance"]), &record); err != nil {
		t.Fatal(err)
	}
	if record.Schema != "raibitserver.provider-image/v1" || record.Image != config.Images["postgresql"] || record.WorkloadUid != provenanceUID || record.WorkloadGeneration != 7 {
		t.Fatalf("missing or incorrect applied provenance: %+v", record)
	}
	if _, err := time.Parse(time.RFC3339Nano, record.ObservedAt); err != nil {
		t.Fatal(err)
	}
	if resource.DesiredState["providerImageProvenance"] != nil {
		t.Fatal("provenance mutated claim before READY commit")
	}
}

func TestProvenanceRejectsUnownedOrIncompleteObservation(t *testing.T) {
	cases := []string{"namespace", "name", "project", "resource", "uid-missing", "uid-malformed", "uid-replaced", "generation-zero", "generation-changed", "image", "container", "rollout", "missing", "malformed", "apply-missing", "apply-malformed", "apply-duplicate"}
	for _, scenario := range cases {
		t.Run(scenario, func(t *testing.T) {
			// Given an applied workload whose observation or apply evidence is invalid.
			resource, config, object := provenanceFixture(t)
			runner := &provenanceRunner{applied: provenanceJSON(t, object)}
			metadata := object["metadata"].(map[string]any)
			switch scenario {
			case "namespace", "name":
				metadata[scenario] = "wrong-owner"
			case "project":
				metadata["labels"].(map[string]any)["raibitserver.io/project-id"] = "wrong"
			case "resource":
				metadata["labels"].(map[string]any)["raibitserver.io/resource-id"] = "wrong"
			case "uid-missing":
				delete(metadata, "uid")
			case "uid-malformed":
				metadata["uid"] = "bad/uid"
			case "uid-replaced":
				metadata["uid"] = "different-valid-uid"
			case "generation-zero":
				metadata["generation"] = 0
			case "generation-changed":
				metadata["generation"] = 8
				object["status"].(map[string]any)["observedGeneration"] = 8
			case "image", "container":
				container := object["spec"].(map[string]any)["template"].(map[string]any)["spec"].(map[string]any)["containers"].([]any)[0].(map[string]any)
				if scenario == "image" {
					container["image"] = "registry.example/postgres@sha256:" + strings.Repeat("b", 64)
				} else {
					container["name"] = "other"
				}
			case "rollout":
				object["status"].(map[string]any)["updatedReplicas"] = 0
				config.Timeout = time.Millisecond
			}
			runner.observed = provenanceJSON(t, object)
			switch scenario {
			case "missing":
				runner.observed = nil
			case "malformed":
				runner.observed = []byte(`{"metadata":`)
			case "apply-missing":
				runner.applied = []byte(`{"kind":"List","items":[]}`)
			case "apply-malformed":
				runner.applied = []byte(`{`)
			case "apply-duplicate":
				runner.applied = provenanceJSON(t, map[string]any{"kind": "List", "items": []any{object, object}})
			}
			state := &fakeStore{resource: resource}
			// When provisioning attempts to publish READY.
			_, err := New(config, state, runner).RunOnce(context.Background())
			// Then no READY transition or provenance is published.
			if err == nil || state.readyTransitions != 0 || state.lastDesiredState["providerImageProvenance"] != nil {
				t.Fatalf("accepted %s: err=%v ready=%d state=%#v", scenario, err, state.readyTransitions, state.lastDesiredState)
			}
		})
	}
}

func TestProvenanceHealthPreservesHistoricalRecordAcrossConfigDrift(t *testing.T) {
	for _, scenario := range []string{"healthy", "service-failure", "credential-failure", "config-failure", "legacy"} {
		t.Run(scenario, func(t *testing.T) {
			// Given old applied provenance and a different current operator image.
			resource, config, _ := provenanceFixture(t)
			old := map[string]any{"schema": "raibitserver.provider-image/v1", "image": config.Images["postgresql"], "workloadUid": provenanceUID, "workloadGeneration": 7, "observedAt": "2026-09-03T00:00:00Z"}
			resource.Status = store.StatusReady
			resource.DesiredState = credentialState(map[string]any{"providerImageProvenance": old})
			if scenario == "legacy" {
				delete(resource.DesiredState, "providerImageProvenance")
			}
			before := provenanceJSON(t, resource.DesiredState["providerImageProvenance"])
			config.Images["postgresql"] = "registry.example/postgres@sha256:" + strings.Repeat("b", 64)
			runner := &fakeRunner{secretExists: true}
			switch scenario {
			case "service-failure":
				runner.failure = errors.New("service unavailable")
				runner.failureNeedle = "kubectl get service/"
			case "credential-failure":
				runner.replacementUIDMismatch = true
			case "config-failure":
				config.Images["postgresql"] = "invalid"
			}
			state := &fakeStore{healthResource: resource}
			// When a health-only reconciliation succeeds or fails.
			_, err := New(config, state, runner).RunOnce(context.Background())
			// Then it cannot replace or backfill image evidence.
			wantError := scenario != "healthy" && scenario != "legacy"
			if (err != nil) != wantError {
				t.Fatalf("health err=%v wantError=%v", err, wantError)
			}
			if !reflect.DeepEqual(before, provenanceJSON(t, state.lastDesiredState["providerImageProvenance"])) {
				t.Fatal("health modified applied image provenance")
			}
		})
	}
}
