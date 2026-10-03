package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"

	"github.com/raibitserver/provisioner/internal/objectstorage"
	"github.com/raibitserver/provisioner/internal/provider"
	"github.com/raibitserver/provisioner/internal/store"
)

type identitySummary struct {
	Name    string   `json:"name"`
	Actions []string `json:"actions"`
}

func main() {
	resource := &store.Resource{
		ID: "resource-storage-probe", ProjectID: "project-probe", OrganizationID: "club", ProjectSlug: "project",
		Name: "Assets", Slug: "assets", Engine: "object-storage", Plan: "dedicated-local",
		DesiredSpec: map[string]any{"bucket": "team-assets", "storageMb": 256},
		DesiredState: map[string]any{
			"trustedTLSS3Endpoint":    "https://resources--club--project-assets.raibitserver.app",
			"storageGatewayNamespace": "raibit-system",
		},
	}
	plan, err := provider.CompileObjectStoragePackage(resource, objectstorage.PinnedImage)
	if err != nil {
		fail(err)
	}
	if err := objectstorage.ValidateRendered(plan.PublicManifests, objectstorage.Ownership{
		Namespace: plan.Namespace, Name: plan.Name, PVCName: plan.PVCName, SecretName: plan.SecretName,
		GatewayNamespace: "raibit-system",
	}); err != nil {
		fail(err)
	}
	var auth struct {
		Identities []identitySummary `json:"identities"`
	}
	if err := json.Unmarshal([]byte(plan.SecretData[objectstorage.ConfigSecretKey]), &auth); err != nil {
		fail(err)
	}
	secretKeys := make([]string, 0, len(plan.SecretData))
	for key := range plan.SecretData {
		secretKeys = append(secretKeys, key)
	}
	sort.Strings(secretKeys)
	result := map[string]any{
		"providerAvailable": false,
		"hardByteQuota":     false,
		"connectionKeys":    plan.ConnectionKeys,
		"secretKeys":        secretKeys,
		"identityActions":   auth.Identities,
		"manifests":         plan.PublicManifests,
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fail(err)
	}
}

func fail(err error) {
	if _, writeErr := fmt.Fprintln(os.Stderr, err); writeErr != nil {
		os.Exit(2)
	}
	os.Exit(1)
}
