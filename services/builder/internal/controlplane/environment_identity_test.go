package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEnvironmentIdentityDecoderPreservesLegacyProduction(t *testing.T) {
	// Given a legacy production service with no explicit environment binding projection.
	service := &Service{ID: "service-prod", ProjectID: "project-1", Slug: "web"}
	deployment := &Deployment{ID: "deployment-prod", ServiceID: service.ID, ProjectID: service.ProjectID}

	// When the authoritative identity boundary normalizes the pair.
	err := BindDeploymentEnvironment(service, deployment)

	// Then the production identity and physical slug remain byte-identical.
	if err != nil {
		t.Fatal(err)
	}
	if service.EnvironmentKind != EnvironmentProduction || service.LogicalSlug != "web" || deployment.EnvironmentKind != EnvironmentProduction {
		t.Fatalf("legacy production identity changed: service=%+v deployment=%+v", service, deployment)
	}
}

func TestProtocolOneFileStoreDoesNotClaimDevelopmentBuild(t *testing.T) {
	// Given local protocol-one state containing only a development build.
	now := time.Now().UTC()
	state := map[string]any{
		"projects":     []any{map[string]any{"id": "project-1"}},
		"services":     []any{map[string]any{"id": "service-dev", "projectId": "project-1", "slug": "dev-abcd-web", "environmentId": "env-dev", "environmentKind": "dev", "logicalSlug": "web"}},
		"deployments":  []any{map[string]any{"id": "deployment-dev", "serviceId": "service-dev", "projectId": "project-1", "environmentId": "env-dev", "environmentKind": "dev", "logicalSlug": "web"}},
		"workflowJobs": []any{map[string]any{"id": "job-dev", "type": "build-and-deploy", "status": "queued", "targetType": "deployment", "targetId": "deployment-dev", "payload": map[string]any{}, "runAfter": now.Add(-time.Minute).Format(time.RFC3339Nano)}},
	}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	// When the local protocol-one store claims work.
	job, err := NewFileStore(path).ClaimNextWorkflowJob(context.Background(), ClaimOptions{WorkerID: "legacy-worker", Now: now})

	// Then development work remains unclaimed and unmodified.
	if err != nil {
		t.Fatal(err)
	}
	if job != nil {
		t.Fatalf("protocol one claimed development job: %+v", job)
	}
}

func TestEnvironmentIdentityDecoderRejectsCrossEnvironmentDeployment(t *testing.T) {
	// Given authoritative service and deployment records from different environments.
	service := &Service{ID: "service-dev", ProjectID: "project-1", Slug: "dev-abcd-web", EnvironmentID: "env-dev-a", EnvironmentKind: EnvironmentDevelopment, LogicalSlug: "web"}
	deployment := &Deployment{ID: "deployment-dev", ServiceID: service.ID, ProjectID: service.ProjectID, EnvironmentID: "env-dev-b", EnvironmentKind: EnvironmentDevelopment}

	// When the decoder binds their identities.
	err := BindDeploymentEnvironment(service, deployment)

	// Then the forged cross-environment pairing is rejected.
	if !errors.Is(err, ErrEnvironmentIdentity) {
		t.Fatalf("cross-environment deployment accepted: %v", err)
	}
}

func TestEnvironmentIdentityDecoderRejectsUnknownKind(t *testing.T) {
	// Given a storage projection with a kind outside the frozen prod/dev contract.
	service := &Service{ID: "service", ProjectID: "project", Slug: "web", EnvironmentID: "environment", EnvironmentKind: "staging", LogicalSlug: "web"}
	deployment := &Deployment{ID: "deployment", ServiceID: "service", ProjectID: "project", EnvironmentID: "environment", EnvironmentKind: "staging", LogicalSlug: "web"}

	// When the authoritative decoder parses the pair.
	err := BindDeploymentEnvironment(service, deployment)

	// Then malformed persisted identity fails with the typed boundary error.
	if !errors.Is(err, ErrEnvironmentIdentity) {
		t.Fatalf("unknown environment kind accepted: %v", err)
	}
}

func TestEnvironmentIdentityKeepsPreviewTypeDistinctFromSourceEnvironment(t *testing.T) {
	// Given a PR preview deployment sourced from a development environment.
	service := &Service{ID: "service-dev", ProjectID: "project-1", Slug: "dev-abcd-web", EnvironmentID: "env-dev", EnvironmentKind: EnvironmentDevelopment, LogicalSlug: "web"}
	deployment := &Deployment{ID: "deployment-preview", ServiceID: service.ID, ProjectID: service.ProjectID, DeploymentType: "preview", EnvironmentID: "env-dev", EnvironmentKind: EnvironmentDevelopment, LogicalSlug: "web"}

	// When authoritative environment identity is bound.
	err := BindDeploymentEnvironment(service, deployment)

	// Then preview remains a deployment type and dev remains its source environment.
	if err != nil {
		t.Fatal(err)
	}
	if deployment.DeploymentType != "preview" || deployment.EnvironmentKind != EnvironmentDevelopment || deployment.EnvironmentID != "env-dev" {
		t.Fatalf("preview lineage/environment were conflated: %+v", deployment)
	}
}

func TestPostgresEnvironmentQueriesUseAuthoritativeBindings(t *testing.T) {
	// Given the production SQL surfaces used to claim and decode builds.
	queries := strings.Join([]string{claimWorkflowJobSQL, serviceSelectSQL, deploymentSelectSQL()}, " ")

	// When inspecting their normalized query text.
	normalized := strings.Join(strings.Fields(queries), " ")

	// Then identity comes from EnvironmentService and Environment, never payload labels.
	for _, fragment := range []string{`JOIN "EnvironmentService"`, `JOIN "Environment"`, `environment_kind`, `logical_slug`} {
		if !strings.Contains(normalized, fragment) {
			t.Fatalf("authoritative environment query missing %q: %s", fragment, normalized)
		}
	}
	if strings.Contains(normalized, `payload ->> 'environmentId'`) || strings.Contains(normalized, `payload ->> 'environmentKind'`) {
		t.Fatalf("claim query trusts caller environment labels: %s", normalized)
	}
}

func TestPostgresProtocolOneCannotClaimDevelopmentBuilds(t *testing.T) {
	// Given the production claim query and transaction-local protocol setter.
	claim := strings.Join(strings.Fields(claimWorkflowJobSQL), " ")
	setter := strings.Join(strings.Fields(setOperationalProtocolSQL), " ")

	// When protocol one and two behavior is reviewed at the SQL boundary.
	// Then dev rows are admitted only for protocol two and protocol elevation is transaction-local.
	if !strings.Contains(claim, `COALESCE(environment.kind, 'prod') = 'prod' OR ($10 = 2 AND wj."operationalProtocolVersion" = 2)`) || !strings.Contains(claim, `$10 = 1 OR binding."serviceId" IS NOT NULL`) {
		t.Fatalf("claim SQL does not fence dev work from protocol one: %s", claim)
	}
	if !strings.Contains(setter, `set_config('raibitserver.operational_protocol', '2', true)`) {
		t.Fatalf("protocol setter is not transaction-local protocol 2: %s", setter)
	}
}
