package reconciler

import (
	"bytes"
	"errors"
	"testing"

	"github.com/raibitserver/provisioner/internal/provider"
)

func TestProvenanceAppliedBoundaryRejectsMalformedEvidence(t *testing.T) {
	for _, scenario := range []string{"wrong-image", "wrong-owner", "uid-space", "negative-generation", "fractional-generation", "duplicate-container", "over-limit", "too-many-objects", "trailing-garbage"} {
		t.Run(scenario, func(t *testing.T) {
			// Given an invalid workload apply response.
			resource, config, object := provenanceFixture(t)
			plan, err := provider.Compile(resource, config.Images["postgresql"])
			if err != nil {
				t.Fatal(err)
			}
			meta := object["metadata"].(map[string]any)
			pod := object["spec"].(map[string]any)["template"].(map[string]any)["spec"].(map[string]any)
			switch scenario {
			case "wrong-image":
				pod["containers"].([]any)[0].(map[string]any)["image"] = "untrusted:latest"
			case "wrong-owner":
				meta["labels"].(map[string]any)["raibitserver.io/project-id"] = "different-project"
			case "uid-space":
				meta["uid"] = " " + provenanceUID + " "
			case "negative-generation":
				meta["generation"] = -1
			case "fractional-generation":
				meta["generation"] = 1.5
			case "duplicate-container":
				pod["containers"] = append(pod["containers"].([]any), pod["containers"].([]any)[0])
			}
			payload := provenanceJSON(t, object)
			switch scenario {
			case "over-limit":
				payload = bytes.Repeat([]byte(" "), maxProviderEvidenceBytes+1)
			case "too-many-objects":
				payload = append(bytes.Repeat([]byte(`{"kind":"Service"}`), 33), payload...)
			case "trailing-garbage":
				payload = append(payload, '?')
			}
			// When parsing the apply boundary.
			_, err = (providerImageObserver{plan: plan}).appliedWorkload(payload)
			// Then malformed evidence cannot become a typed applied workload.
			if !errors.Is(err, errProviderImageEvidence) {
				t.Fatalf("accepted %s: %v", scenario, err)
			}
		})
	}
}

func TestProvenanceAppliedBoundaryAcceptsObjectStream(t *testing.T) {
	// Given kubectl's multi-object JSON stream rather than a List envelope.
	resource, config, object := provenanceFixture(t)
	plan, err := provider.Compile(resource, config.Images["postgresql"])
	if err != nil {
		t.Fatal(err)
	}
	payload := append([]byte(`{"kind":"Service"}`), provenanceJSON(t, object)...)
	// When extracting the single owned workload.
	applied, err := (providerImageObserver{plan: plan}).appliedWorkload(payload)
	// Then it retains the concrete apply identity.
	if err != nil || applied.Metadata.UID != provenanceUID || applied.Metadata.Generation != 7 {
		t.Fatalf("applied=%#v err=%v", applied.Metadata, err)
	}
}
