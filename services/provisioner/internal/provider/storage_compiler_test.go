package provider

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/raibitserver/provisioner/internal/objectstorage"
	"github.com/raibitserver/provisioner/internal/store"
)

func Test_Compile_when_live_storage_admission_remains_disabled(t *testing.T) {
	// Given
	resource := storageResource()

	// When
	plan, err := Compile(resource, objectstorage.PinnedImage)

	// Then
	var unavailable *CapabilityUnavailableError
	if plan != nil || !errors.As(err, &unavailable) {
		t.Fatalf("Task 5 package render must not enable the live provider: plan=%v err=%v", plan, err)
	}
}

func storageResource() *store.Resource {
	return &store.Resource{
		ID: "resource-storage-1", ProjectID: "project-1", OrganizationID: "club", ProjectSlug: "project",
		Name: "Assets", Slug: "assets", Engine: "object-storage", Plan: "dedicated-local",
		DesiredSpec: map[string]any{"bucket": "team-assets"},
		DesiredState: map[string]any{
			"trustedTLSS3Endpoint":    "https://resources--club--project-assets.raibitserver.app",
			"storageGatewayNamespace": "raibit-system",
		},
	}
}

func Test_Compile_when_object_storage_is_rendered(t *testing.T) {
	// Given
	resource := storageResource()

	// When
	plan, err := CompileObjectStoragePackage(resource, objectstorage.PinnedImage)

	// Then
	if err != nil {
		t.Fatal(err)
	}
	if err := objectstorage.ValidateRendered(plan.PublicManifests, objectstorage.Ownership{
		Namespace: plan.Namespace, Name: plan.Name, PVCName: plan.PVCName, SecretName: plan.SecretName,
		GatewayNamespace: "raibit-system",
	}); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(plan.PublicManifests)
	if err != nil {
		t.Fatal(err)
	}
	text := string(payload)
	for _, expected := range []string{objectstorage.PinnedImage, "\"containerPort\":8333", "\"runAsUser\":1000", "\"claimName\":\"" + plan.PVCName + "\"", "\"secretName\":\"" + plan.SecretName + "\"", "\"app.kubernetes.io/component\":\"object-storage-admission-gateway\"", "\"kubernetes.io/metadata.name\":\"raibit-system\"", "\"cpu\":\"100m\"", "\"memory\":\"128Mi\"", "\"ephemeral-storage\":\"256Mi\"", "\"cpu\":\"1\"", "\"memory\":\"1Gi\"", "\"ephemeral-storage\":\"1Gi\""} {
		if !strings.Contains(text, expected) {
			t.Fatalf("storage render is missing %s: %s", expected, text)
		}
	}
	for _, forbidden := range []string{"MINIO_ROOT", "\"containerPort\":9000", "\"containerPort\":9001", "\"type\":\"LoadBalancer\"", "\"type\":\"NodePort\""} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("storage render exposes legacy/public surface %s: %s", forbidden, text)
		}
	}
	if len(plan.ConnectionKeys) != 5 {
		t.Fatalf("only tenant connection keys may be published: %v", plan.ConnectionKeys)
	}
	ownedSecret, err := plan.OwnedSecretManifest(
		resource.ID,
		resource.ProjectID,
		"dGhpcy1pcy1hLTMyaWJ5dGUtcmFuZG9tLW5vbmNlMDA",
	)
	if err != nil {
		t.Fatal(err)
	}
	metadata := ownedSecret["metadata"].(map[string]any)
	annotations := metadata["annotations"].(map[string]any)
	if annotations["raibitserver.io/credential-owner"] != "raibitserver-provisioner" {
		t.Fatal("storage Secret lacks provider ownership")
	}
	secretData := ownedSecret["stringData"].(map[string]string)
	for _, key := range []string{"admin.access-key", "admin.secret-key", "tenant.access-key", "tenant.secret-key", objectstorage.ConfigSecretKey} {
		if secretData[key] == "" {
			t.Fatalf("owned storage Secret is missing %s", key)
		}
	}
}

func Test_ValidateRendered_when_storage_ownership_or_surface_is_mutated(t *testing.T) {
	plan, err := CompileObjectStoragePackage(storageResource(), objectstorage.PinnedImage)
	if err != nil {
		t.Fatal(err)
	}
	ownership := objectstorage.Ownership{
		Namespace: plan.Namespace, Name: plan.Name, PVCName: plan.PVCName, SecretName: plan.SecretName,
		GatewayNamespace: "raibit-system",
	}
	baseline, err := json.Marshal(plan.PublicManifests)
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct {
		name, old, replacement string
	}{
		{"foreign PVC", plan.PVCName, "foreign-pvc"},
		{"foreign Secret", plan.SecretName, "foreign-secret"},
		{"public admin port", "\"containerPort\":8333", "\"containerPort\":9333"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			// Given
			mutatedJSON := strings.Replace(string(baseline), scenario.old, scenario.replacement, 1)
			var mutated []map[string]any
			if err := json.Unmarshal([]byte(mutatedJSON), &mutated); err != nil {
				t.Fatal(err)
			}

			// When
			err := objectstorage.ValidateRendered(mutated, ownership)

			// Then
			if err == nil {
				t.Fatal("foreign ownership or public management surface accepted")
			}
		})
	}
}

func Test_UseExistingSecret_when_storage_credentials_are_owned_and_exact(t *testing.T) {
	// Given
	first, err := CompileObjectStoragePackage(storageResource(), objectstorage.PinnedImage)
	if err != nil {
		t.Fatal(err)
	}
	second, err := CompileObjectStoragePackage(storageResource(), objectstorage.PinnedImage)
	if err != nil {
		t.Fatal(err)
	}
	existing := cloneSecretData(first.SecretData)

	// When
	err = second.UseExistingSecret(existing)

	// Then
	if err != nil {
		t.Fatal(err)
	}
	if second.SecretData["admin.secret-key"] != first.SecretData["admin.secret-key"] ||
		second.SecretData["tenant.secret-key"] != first.SecretData["tenant.secret-key"] {
		t.Fatal("retry did not preserve both persisted storage identities")
	}
	for _, key := range []string{"admin.access-key", objectstorage.ConfigSecretKey} {
		missing := cloneSecretData(existing)
		delete(missing, key)
		if err := second.UseExistingSecret(missing); err == nil {
			t.Fatalf("missing required storage key %s did not fail closed", key)
		}
	}
}
