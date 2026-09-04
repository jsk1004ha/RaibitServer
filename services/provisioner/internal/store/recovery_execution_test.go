package store

import (
	"errors"
	"testing"
)

func TestRecoveryResourceMetadataRejectsForgedProviderResult(t *testing.T) {
	resource := &Resource{ID: "resource-1", ProjectID: "project-1", Name: "db", Type: "database", Engine: "postgresql", Provider: "raibitserver", Plan: "shared-small", Region: "local", ConnectionSecretName: "db-connection", DesiredState: decodeMap([]byte(recoveryState()))}
	providerResult := resource.DesiredState["providerResult"].(map[string]any)
	providerResult["endpoint"] = "attacker.invalid:5432"
	if _, err := recoveryResourceMetadata(resource); !errors.Is(err, ErrRecoverySource) {
		t.Fatalf("forged provider endpoint accepted: %v", err)
	}
}

func TestRecoveryResourceMetadataRejectsSQLiteWithoutVolumeAuthority(t *testing.T) {
	resource := &Resource{ID: "resource-1", ProjectID: "project-1", Type: "database", Engine: "sqlite", Provider: "raibitserver", Plan: "shared-small", Region: "local", ConnectionSecretName: "db-connection", DesiredState: decodeMap([]byte(recoveryState()))}
	if _, err := recoveryResourceMetadata(resource); !errors.Is(err, ErrRecoverySource) {
		t.Fatalf("SQLite without operator volume authority accepted: %v", err)
	}
}
