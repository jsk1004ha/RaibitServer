package identity

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestIngestionHappySharedRuntimeNames(t *testing.T) {
	// Given: shared outputs from the actual orchestrator naming compiler.
	root := os.Getenv("RAIBITSERVER_OBSERVABILITY_FIXTURES")
	if root == "" {
		root = "../../../../tests/fixtures"
	}
	raw, err := os.ReadFile(filepath.Join(root, "observability-runtime-identity-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Cases []struct {
			Name       string
			Project    struct{ ID, OrganizationID, Slug string }
			Service    struct{ ID, Slug, Type string }
			Deployment struct {
				ID, DeploymentType string
				PullRequestNumber  int
			}
			Expected struct{ Namespace, WorkloadName, ContainerName, Kind string }
		}
	}
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	for _, test := range corpus.Cases {
		t.Run(test.Name, func(t *testing.T) {
			input := Input{OrganizationID: test.Project.OrganizationID, ProjectID: test.Project.ID, ServiceProjectID: test.Project.ID, ProjectSlug: test.Project.Slug, ServiceID: test.Service.ID, ServiceSlug: test.Service.Slug, DeploymentID: test.Deployment.ID, DeploymentType: test.Deployment.DeploymentType, PullRequestNumber: test.Deployment.PullRequestNumber, Status: "DEPLOYING", SnapshotVersion: 1, Snapshot: json.RawMessage(`{"type":"` + test.Service.Type + `"}`), ImageURL: "registry.test/app:stable"}
			// When: a current, not-yet-ready deployment is resolved.
			scope, err := Parse(input)
			// Then: every externally frozen name is identical.
			if err != nil || scope.Namespace != test.Expected.Namespace || scope.Name != test.Expected.WorkloadName || scope.Container != test.Expected.ContainerName || scope.Kind != test.Expected.Kind {
				t.Fatalf("identity naming mismatch: %v", err)
			}
		})
	}
}

func TestIngestionAdversarialLifecycleAndSnapshot(t *testing.T) {
	base := Input{OrganizationID: "org", ProjectID: "project", ServiceProjectID: "project", ServiceID: "service", DeploymentID: "dep", Status: "DEPLOYING", SnapshotVersion: 1, Snapshot: json.RawMessage(`{"type":"web"}`), ImageURL: "image:tag"}
	cases := []struct {
		name     string
		change   func(*Input)
		accepted bool
	}{
		{"deploying", func(*Input) {}, true},
		{"ready", func(i *Input) { i.Status = "READY" }, true},
		{"failed_diagnostic", func(i *Input) { i.Status = "FAILED" }, true},
		{"foreign_project", func(i *Input) { i.ServiceProjectID = "foreign" }, false},
		{"cancelled", func(i *Input) { i.Status = "CANCELLED" }, false},
		{"cleanup", func(i *Input) { i.Action = "cleanup" }, false},
		{"deleting", func(i *Input) { i.ServiceDeleting = true }, false},
		{"project_deleted", func(i *Input) { i.ProjectStatus = "DELETED" }, false},
		{"legacy", func(i *Input) { i.Snapshot = nil; i.SnapshotVersion = 0 }, false},
		{"bad_snapshot", func(i *Input) { i.Snapshot = json.RawMessage(`{"type":"web","command":42}`) }, false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			// Given / When / Then: only current immutable, owned diagnostic deployments pass.
			input := base
			test.change(&input)
			_, err := Parse(input)
			if (err == nil) != test.accepted {
				t.Fatal("lifecycle admission mismatch")
			}
			if test.name == "legacy" && !errors.Is(err, ErrLegacy) {
				t.Fatal("legacy classification lost")
			}
		})
	}
}
