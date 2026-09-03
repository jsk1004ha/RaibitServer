package kube

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/raibitserver/orchestrator/internal/store"
)

func snapshotDeployment(t *testing.T, fields string) *store.Deployment {
	t.Helper()
	var deployment store.Deployment
	if err := json.Unmarshal([]byte(`{"id":"dep-1","serviceId":"svc-live","projectId":"prj-live","imageUrl":"registry.local/app:release","imageDigest":"sha256:`+strings.Repeat("a", 64)+`"`+fields+`}`), &deployment); err != nil {
		t.Fatal(err)
	}
	return &deployment
}

func snapshotLiveState() (*store.Project, *store.Service) {
	return &store.Project{ID: "prj-live", OrganizationID: "org-live", OrganizationSlug: "club", Slug: "project"},
		&store.Service{
			ID: "svc-live", ProjectID: "prj-live", Slug: "web", Type: "web", Port: 9000, Replicas: 9,
			DesiredSpec: map[string]any{"command": []string{"mutated"}, "env": map[string]string{"MODE": "mutated"}, "allowPublicEgress": true},
		}
}

func TestSnapshotLegacyInitialPinsExistingRuntime(t *testing.T) {
	// Given: the N-1 initial record has no snapshot metadata.
	project, service := snapshotLiveState()
	// When
	plan := NewDeploymentPlan(SpecFromState(project, service, snapshotDeployment(t, ""), "operator.test"))
	// Then
	if !plan.Safe || plan.Service.Port != 9000 || plan.Service.Replicas != 9 || plan.Service.Env["MODE"] != "mutated" || !plan.Service.PublicEgress {
		t.Fatalf("legacy runtime changed: %#v", plan)
	}
}

func TestSnapshotRuntimeSurvivesMutableServiceChanges(t *testing.T) {
	// Given: snapshot values differ from every mutable fallback; forged identity is ignored.
	project, service := snapshotLiveState()
	deployment := snapshotDeployment(t, `,"snapshotVersion":1,"sourceDeploymentId":"original","desiredSpecSnapshot":{"type":"cron","port":8081,"replicas":2,"command":["captured"],"args":["--once"],"schedule":"*/5 * * * *","env":{"MODE":"captured"},"secretEnv":[{"name":"DB_PASSWORD","valueFrom":{"secretKeyRef":{"name":"captured-secret","key":"PASSWORD"}}}],"allowPublicEgress":false,"allowTenantIngress":false,"id":"forged","projectId":"forged","slug":"forged","baseDomain":"forged.test","imageUrl":"forged:latest","desiredSpec":{"command":["nested-forgery"]}}`)
	// When
	plan := NewDeploymentPlan(SpecFromState(project, service, deployment, "operator.test"))
	// Then
	if !plan.Safe || plan.Kind != "CronJob" || plan.Service.Port != 8081 || plan.Service.Replicas != 2 || !reflect.DeepEqual(plan.Service.Command, []string{"captured"}) || plan.Service.Env["MODE"] != "captured" || plan.Service.PublicEgress || plan.Service.AllowTenantIngress || len(plan.Service.SecretEnv) != 1 {
		t.Fatalf("snapshot runtime not selected: %#v", plan)
	}
	if plan.Service.ServiceID != "svc-live" || plan.Service.ProjectID != "prj-live" || plan.Service.Host != "apps--club--project.operator.test" || plan.Service.Image != "registry.local/app@sha256:"+strings.Repeat("a", 64) {
		t.Fatalf("snapshot replaced live authority: %#v", plan.Service)
	}
}

func TestSnapshotInvalidConfigurationProducesNoManifests(t *testing.T) {
	cases := map[string]string{
		"missing source snapshot":  `,"sourceDeploymentId":"old"`,
		"missing retry snapshot":   `,"retryOfDeploymentId":"old"`,
		"missing trigger snapshot": `,"triggerType":"ReDePlOy"`,
		"null lineaged snapshot":   `,"triggerType":"retry","desiredSpecSnapshot":null`,
		"unknown version":          `,"snapshotVersion":2,"desiredSpecSnapshot":{"type":"web"}`,
		"version without snapshot": `,"snapshotVersion":1`,
		"unversioned snapshot":     `,"desiredSpecSnapshot":{"type":"web"}`,
		"array snapshot":           `,"snapshotVersion":1,"desiredSpecSnapshot":[]`,
		"empty snapshot":           `,"snapshotVersion":1,"desiredSpecSnapshot":{}`,
		"wrong port":               `,"snapshotVersion":1,"desiredSpecSnapshot":{"type":"web","port":"8080"}`,
		"invalid port":             `,"snapshotVersion":1,"desiredSpecSnapshot":{"type":"web","port":70000}`,
		"wrong command":            `,"snapshotVersion":1,"desiredSpecSnapshot":{"type":"web","command":"sh"}`,
		"empty command":            `,"snapshotVersion":1,"desiredSpecSnapshot":{"type":"web","command":[]}`,
		"wrong env":                `,"snapshotVersion":1,"desiredSpecSnapshot":{"type":"web","env":{"MODE":42}}`,
		"secret material":          `,"snapshotVersion":1,"desiredSpecSnapshot":{"type":"web","secretEnv":[{"name":"PASSWORD","value":"material"}]}`,
		"bad egress":               `,"snapshotVersion":1,"desiredSpecSnapshot":{"type":"web","allowPublicEgress":"true"}`,
	}
	for name, fields := range cases {
		t.Run(name, func(t *testing.T) {
			// Given
			project, service := snapshotLiveState()
			// When
			plan := NewDeploymentPlan(SpecFromState(project, service, snapshotDeployment(t, fields), "operator.test"))
			// Then
			if plan.Safe || len(plan.Manifests) != 0 || plan.Error == "" {
				t.Fatalf("invalid snapshot rendered: %#v", plan)
			}
		})
	}
}

func TestSnapshotNullableScalarsUseDefaultsWithoutLiveFallback(t *testing.T) {
	// Given: nullable Service.port is retained by snapshot capture.
	project, service := snapshotLiveState()
	deployment := snapshotDeployment(t, `,"snapshotVersion":1,"desiredSpecSnapshot":{"type":"worker","port":null,"replicas":null,"allowPublicEgress":null,"allowTenantIngress":null}`)
	// When
	plan := NewDeploymentPlan(SpecFromState(project, service, deployment, "operator.test"))
	// Then
	if !plan.Safe || plan.Service.Port != 3000 || plan.Service.Replicas != 1 || plan.Service.PublicEgress || plan.Service.AllowTenantIngress || len(plan.Service.Command) != 0 || plan.Service.Env["MODE"] != "" {
		t.Fatalf("nullable defaults used mutable fallbacks: safe=%v service=%#v", plan.Safe, plan.Service)
	}
}
