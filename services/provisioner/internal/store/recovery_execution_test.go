package store

import (
	"errors"
	"strings"
	"testing"
)

func TestRecoveryResourceMetadataRejectsForgedProviderResult(t *testing.T) {
	resource := recoveryExecutionResource(t)
	providerResult := resource.DesiredState["providerResult"].(map[string]any)
	providerResult["endpoint"] = "attacker.invalid:5432"
	if _, err := recoveryResourceMetadata(resource); !errors.Is(err, ErrRecoverySource) {
		t.Fatalf("forged provider endpoint accepted: %v", err)
	}
}

func TestRecoveryResourceMetadataRejectsDesiredIdentityDrift(t *testing.T) {
	resource := recoveryExecutionResource(t)
	if _, err := recoveryResourceMetadata(resource); err != nil {
		t.Fatal(err)
	}
	resource.DesiredSpec["databaseName"] = "other_tenant"
	resource.DesiredSpec["username"] = "other_user"
	if _, err := recoveryResourceMetadata(resource); !errors.Is(err, ErrRecoverySource) {
		t.Fatalf("mutable desired identity drift accepted: %v", err)
	}
}

func TestProviderConnectionStatePersistsObservedAuthority(t *testing.T) {
	resource := &Resource{ID: "resource-1", Name: "db", Engine: "postgresql", DesiredSpec: map[string]any{"databaseName": "app", "username": "provider"}}
	state := decodeMap([]byte(recoveryState()))
	keys := []string{"DATABASE_URL", "PGDATABASE", "PGHOST", "PGPASSWORD", "PGPORT", "PGUSER", "POSTGRES_URL"}
	connection, err := providerConnectionState(resource, state, "raibitserver", "db-connection", "db.tenant.svc.cluster.local:5432", keys)
	if err != nil || connection["database"] != "app" || connection["user"] != "provider" || connection["secretKey"] != "PGPASSWORD" || connection["credentialUID"] != "secret-uid" || !strings.HasPrefix(connection["sourceGeneration"].(string), "resource-incarnation/v1:sha256:") {
		t.Fatalf("connection=%+v err=%v", connection, err)
	}
}

func TestRecoveryResourceMetadataRejectsObservedConnectionTampering(t *testing.T) {
	mutations := map[string]any{"host": "attacker.invalid", "port": float64(1), "database": "other", "user": "other", "secretKey": "DATABASE_URL", "credentialUID": "replacement", "credentialGeneration": strings.Repeat("x", 43)}
	for key, value := range mutations {
		t.Run(key, func(t *testing.T) {
			resource := recoveryExecutionResource(t)
			resource.DesiredState["providerConnection"].(map[string]any)[key] = value
			if _, err := recoveryResourceMetadata(resource); !errors.Is(err, ErrRecoverySource) {
				t.Fatalf("tampered %s accepted: %v", key, err)
			}
		})
	}
}

func recoveryExecutionResource(t *testing.T) *Resource {
	t.Helper()
	resource := &Resource{ID: "resource-1", ProjectID: "project-1", Name: "db", Type: "database", Engine: "postgresql", Provider: "raibitserver", Plan: "shared-small", Region: "local", ConnectionSecretName: "db-connection", DesiredSpec: map[string]any{"databaseName": "app", "username": "provider"}, DesiredState: decodeMap([]byte(recoveryState()))}
	generation, err := recoverySourceGeneration(resource)
	if err != nil {
		t.Fatal(err)
	}
	resource.DesiredState["providerConnection"].(map[string]any)["sourceGeneration"] = generation
	return resource
}

func TestRecoveryResourceMetadataRejectsSQLiteWithoutVolumeAuthority(t *testing.T) {
	resource := &Resource{ID: "resource-1", ProjectID: "project-1", Type: "database", Engine: "sqlite", Provider: "raibitserver", Plan: "shared-small", Region: "local", ConnectionSecretName: "db-connection", DesiredState: decodeMap([]byte(recoveryState()))}
	if _, err := recoveryResourceMetadata(resource); !errors.Is(err, ErrRecoverySource) {
		t.Fatalf("SQLite without operator volume authority accepted: %v", err)
	}
}
