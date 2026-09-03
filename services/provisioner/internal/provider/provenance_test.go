package provider

import (
	"strings"
	"testing"

	"github.com/raibitserver/provisioner/internal/store"
)

func TestProvenanceImageMatchesTrimmedAppliedManifest(t *testing.T) {
	// Given a valid operator digest with surrounding whitespace.
	image := "registry.example/postgres@sha256:" + strings.Repeat("a", 64)
	resource := &store.Resource{ID: "res-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql"}
	// When compiling the provider manifest.
	plan, err := Compile(resource, " \t"+image+"\n")
	if err != nil {
		t.Fatal(err)
	}
	if plan.Image != image {
		t.Fatalf("plan image = %q, want %q", plan.Image, image)
	}
	// Then the exact applied image is the validated canonical image.
	for _, object := range plan.PublicManifests {
		if object["kind"] != "StatefulSet" {
			continue
		}
		spec := object["spec"].(map[string]any)
		pod := spec["template"].(map[string]any)["spec"].(map[string]any)
		container := pod["containers"].([]any)[0].(map[string]any)
		if container["image"] != image {
			t.Fatalf("applied image = %q, want %q", container["image"], image)
		}
	}
}
