package provider

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/raibitserver/provisioner/internal/store"
)

func Test_ObjectNames_when_environment_is_dev(t *testing.T) {
	// Given
	resource := environmentResource("dev")
	expectedHash := sha256.Sum256([]byte(resource.EnvironmentID + ":" + resource.LogicalSlug))
	expectedName := fmt.Sprintf("dev-%x-team-assets", expectedHash[:5])
	expectedNamespaceHash := sha256.Sum256([]byte(resource.EnvironmentID))
	expectedNamespace := fmt.Sprintf("rb-dev-%x", expectedNamespaceHash[:10])

	// When
	name, namespace, secretName, pvcName, err := ObjectNames(resource)

	// Then
	if err != nil {
		t.Fatal(err)
	}
	if name != expectedName || namespace != expectedNamespace || secretName != expectedName+"-connection" || pvcName != expectedName+"-data" {
		t.Fatalf("unexpected dev identity: %q/%q/%q/%q", name, namespace, secretName, pvcName)
	}
}

func Test_Compile_when_environment_is_dev(t *testing.T) {
	// Given
	resource := environmentResource("dev")

	// When
	plan, err := Compile(resource, "registry.example/postgresql@"+testDigest)

	// Then
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(plan.PublicManifests)
	if err != nil {
		t.Fatal(err)
	}
	text := string(payload)
	for _, expected := range []string{
		`"raibitserver.io/environment-id":"env-dev-identity"`,
		`"raibitserver.io/environment-kind":"dev"`,
		`"raibitserver.io/logical-slug":"team-assets"`,
		`"kubernetes.io/metadata.name":"` + plan.Namespace + `"`,
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("dev render is missing %q: %s", expected, text)
		}
	}
	if plan.Endpoint != plan.Name+"."+plan.Namespace+".svc.cluster.local:5432" {
		t.Fatalf("dev private DNS is not environment-local: %q", plan.Endpoint)
	}
}

func Test_ObjectNames_when_environment_identity_is_malformed_or_stale(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*store.Resource)
	}{
		{"unknown kind", func(resource *store.Resource) { resource.EnvironmentKind = "preview" }},
		{"missing environment id", func(resource *store.Resource) { resource.EnvironmentID = "" }},
		{"missing logical slug", func(resource *store.Resource) { resource.LogicalSlug = "" }},
		{"cross-environment persisted namespace", func(resource *store.Resource) {
			resource.DesiredState["providerIdentity"] = map[string]any{"namespace": "club--project", "name": "legacy-provider"}
		}},
		{"stale persisted name", func(resource *store.Resource) {
			resource.DesiredState["providerIdentity"] = map[string]any{"namespace": devNamespace(resource.EnvironmentID), "name": "dev-deadbeef00-team-assets"}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			// Given
			resource := environmentResource("dev")
			test.mutate(resource)

			// When
			_, _, _, _, err := ObjectNames(resource)

			// Then
			if err == nil {
				t.Fatal("malformed or stale environment identity was accepted")
			}
		})
	}
}

func Test_ObjectNames_when_environment_is_prod_preserves_legacy_identity(t *testing.T) {
	// Given
	legacy := environmentResource("")
	prod := environmentResource("prod")
	legacy.EnvironmentID, legacy.LogicalSlug = "", ""

	// When
	legacyName, legacyNamespace, legacySecret, legacyPVC, legacyErr := ObjectNames(legacy)
	prodName, prodNamespace, prodSecret, prodPVC, prodErr := ObjectNames(prod)

	// Then
	if legacyErr != nil || prodErr != nil {
		t.Fatalf("legacy=%v prod=%v", legacyErr, prodErr)
	}
	if legacyName != prodName || legacyNamespace != prodNamespace || legacySecret != prodSecret || legacyPVC != prodPVC {
		t.Fatalf("prod identity changed: legacy=%q/%q/%q/%q prod=%q/%q/%q/%q", legacyName, legacyNamespace, legacySecret, legacyPVC, prodName, prodNamespace, prodSecret, prodPVC)
	}
	if prodName != "resource-storage-probe-6f1ced5f998c" || prodNamespace != "club--project" || prodSecret != "resource-storage-probe-6f1ced5f998c-connection" || prodPVC != "resource-storage-probe-6f1ced5f998c-data" {
		t.Fatalf("Task 5 production identity changed: %q/%q/%q/%q", prodName, prodNamespace, prodSecret, prodPVC)
	}
}

func Test_ObjectNames_when_dev_logical_slugs_share_a_long_prefix_do_not_collide(t *testing.T) {
	// Given
	first := environmentResource("dev")
	second := environmentResource("dev")
	first.LogicalSlug = strings.Repeat("same-prefix-", 8) + "first"
	second.LogicalSlug = strings.Repeat("same-prefix-", 8) + "second"

	// When
	firstName, _, firstSecret, _, firstErr := ObjectNames(first)
	secondName, _, secondSecret, _, secondErr := ObjectNames(second)

	// Then
	if firstErr != nil || secondErr != nil {
		t.Fatalf("first=%v second=%v", firstErr, secondErr)
	}
	if firstName == secondName || len(firstSecret) > 63 || len(secondSecret) > 63 {
		t.Fatalf("bounded dev identities collided or overflowed: %q/%q %q/%q", firstName, firstSecret, secondName, secondSecret)
	}
}

func environmentResource(kind string) *store.Resource {
	return &store.Resource{
		ID: "resource-storage-probe", ProjectID: "project-probe", OrganizationID: "club", ProjectSlug: "project",
		Name: "Assets", Slug: "physical-assets", Engine: "postgresql", Provider: "dedicated-local", Plan: "shared-small", Region: "local",
		EnvironmentID: "env-dev-identity", EnvironmentKind: kind, LogicalSlug: "team-assets",
		DesiredSpec: map[string]any{"databaseName": "team_assets", "storageMb": 256}, DesiredState: map[string]any{},
	}
}
