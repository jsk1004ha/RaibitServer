package store

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func Test_ClaimNextDeployment_uses_authoritative_environment_and_server_protocol(t *testing.T) {
	// Given/When
	normalized := strings.Join(strings.Fields(claimDeploymentSQL), " ")

	// Then
	for _, fragment := range []string{
		`LEFT JOIN "EnvironmentService" binding ON binding."serviceId" = d."serviceId"`,
		`LEFT JOIN "Environment" environment ON environment.id = binding."environmentId"`,
		`binding."logicalSlug"`,
		`environment.kind`,
		`COALESCE(environment.kind, 'prod')`,
	} {
		if !strings.Contains(normalized, fragment) {
			t.Fatalf("deployment claim lacks authoritative environment projection %q", fragment)
		}
	}
	if operationalProtocolSessionSQL != "SET LOCAL raibitserver.operational_protocol = '2'" {
		t.Fatalf("worker protocol must be server-local, got %q", operationalProtocolSessionSQL)
	}
}

func Test_FileStore_unbound_legacy_deployment_remains_production_compatible(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	state := `{"projects":[{"id":"project-1","status":"READY"}],"services":[{"id":"service-1","projectId":"project-1","status":"READY"}],"deployments":[{"id":"deployment-1","serviceId":"service-1","projectId":"project-1","status":"IMAGE_READY"}]}`
	if err := os.WriteFile(path, []byte(state), 0o600); err != nil {
		t.Fatal(err)
	}
	claimed, err := NewFileStore(path).ClaimNextDeployment(context.Background(), ClaimOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if claimed == nil || claimed.EnvironmentID != "" {
		t.Fatalf("legacy production deployment was not claimable: %#v", claimed)
	}
}

func Test_FileStore_dev_service_deletion_is_default_off(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	state := `{"services":[{"id":"service-1","projectId":"project-1","status":"DELETE_REQUESTED"}],"environments":[{"id":"env-dev-1","projectId":"project-1","kind":"dev"}],"environmentServices":[{"serviceId":"service-1","projectId":"project-1","environmentId":"env-dev-1","logicalSlug":"web"}]}`
	if err := os.WriteFile(path, []byte(state), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewFileStore(path)
	claimed, err := store.ClaimNextServiceDeletion(context.Background(), ClaimOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if claimed != nil {
		t.Fatalf("default-off worker claimed dev service deletion: %#v", claimed)
	}
	claimed, err = store.ClaimNextServiceDeletion(context.Background(), ClaimOptions{AllowDevelopment: true})
	if err != nil {
		t.Fatal(err)
	}
	if claimed == nil || claimed.EnvironmentID != "env-dev-1" {
		t.Fatalf("protocol-2 worker did not claim dev deletion: %#v", claimed)
	}
}

func Test_FileStore_dev_claim_is_default_off(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	state := `{"projects":[{"id":"project-1","status":"READY"}],"services":[{"id":"service-1","projectId":"project-1","status":"READY"}],"environments":[{"id":"env-dev-1","projectId":"project-1","kind":"dev"}],"environmentServices":[{"serviceId":"service-1","projectId":"project-1","environmentId":"env-dev-1","logicalSlug":"web"}],"deployments":[{"id":"deployment-1","serviceId":"service-1","projectId":"project-1","status":"IMAGE_READY"}]}`
	if err := os.WriteFile(path, []byte(state), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewFileStore(path)
	claimed, err := store.ClaimNextDeployment(context.Background(), ClaimOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if claimed != nil {
		t.Fatalf("default-off worker claimed dev deployment: %#v", claimed)
	}
	claimed, err = store.ClaimNextDeployment(context.Background(), ClaimOptions{AllowDevelopment: true})
	if err != nil {
		t.Fatal(err)
	}
	if claimed == nil || claimed.EnvironmentID != "env-dev-1" {
		t.Fatalf("protocol-2 worker did not receive authoritative dev identity: %#v", claimed)
	}
}
