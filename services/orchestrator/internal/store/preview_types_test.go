package store

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
)

func TestParsePreviewRuntime_accepts_exact_schema15_identity(t *testing.T) {
	// Given
	raw := json.RawMessage(`{"version":1,"lineageId":"lineage-1","deploymentId":"deployment-1","generation":2,"lineageVersion":7,"stableHost":"preview--pr-7--acme--demo.example.test","probeHost":"preview--probe-0123456789abcdef0123456789abcdef.example.test","namespace":"acme--demo","workloadName":"pr-7-web-candidate","serviceName":"pr-7-web-candidate","probeIngressName":"pr-7-web-candidate","routeName":"preview-route-lineage"}`)

	// When
	runtime, err := ParsePreviewRuntime(raw, "lineage-1", "deployment-1", 2)

	// Then
	if err != nil || runtime.ProbeHost != "preview--probe-0123456789abcdef0123456789abcdef.example.test" {
		t.Fatalf("runtime=%#v err=%v", runtime, err)
	}
}

func TestPreviewIdentityFixture_matches_frozen_typescript_blob(t *testing.T) {
	// Given
	raw, err := os.ReadFile("testdata/preview-identity.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		LineageID, DeploymentID, ProbeHost, StableHost string
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}

	// When
	digest := sha256.Sum256(raw)

	// Then
	if fmt.Sprintf("%x", digest) != "15ffb95b73569c266986bb84a05737576b44c99414fb1254d0800f34d4d9762f" || fixture.LineageID != "lineage-1" || fixture.DeploymentID != "deployment-1" || fixture.ProbeHost != "preview--probe-d1c4b98e598159ae3a83ace52e085caa.raibitserver.app" || fixture.StableHost != "preview--pr-42--club--demo.raibitserver.app" {
		t.Fatalf("frozen fixture mismatch: sha=%x fixture=%#v", digest, fixture)
	}
}

func TestParsePreviewInventory_rejects_shared_or_name_only_objects(t *testing.T) {
	for name, raw := range map[string]json.RawMessage{
		"shared":    json.RawMessage(`[{"group":"networking.k8s.io","version":"v1","kind":"NetworkPolicy","namespace":"acme--demo","name":"shared","uid":"uid-1"}]`),
		"name-only": json.RawMessage(`[{"group":"apps","version":"v1","kind":"Deployment","namespace":"acme--demo","name":"candidate","uid":""}]`),
	} {
		t.Run(name, func(t *testing.T) {
			// Given / When
			_, err := ParsePreviewInventory(raw)

			// Then
			if !errors.Is(err, ErrPreviewContract) {
				t.Fatalf("expected preview contract rejection, got %v", err)
			}
		})
	}
}
