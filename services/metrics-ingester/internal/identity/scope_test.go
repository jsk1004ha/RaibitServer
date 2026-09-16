package identity

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSharedIdentityNaming(t *testing.T) {
	// Given: the immutable shared contract fixture, never synthesized by this lane.
	path := os.Getenv("RAIBITSERVER_IDENTITY_FIXTURE")
	if path == "" {
		path = filepath.Join("..", "..", "..", "..", "tests", "fixtures", "observability-runtime-identity-v1.json")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Cases []struct {
			Name       string
			Project    struct{ ID, OrganizationID, Slug string }
			Service    struct{ ID, Slug, Type string }
			Deployment struct {
				ID, DeploymentType string
				PullRequestNumber  int
			}
			Expected struct{ Namespace, WorkloadName, Kind, ContainerName string }
		}
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, tc := range fixtures.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			snapshot, err := json.Marshal(struct {
				Type string `json:"type"`
			}{tc.Service.Type})
			if err != nil {
				t.Fatal(err)
			}
			// When: deriving runtime identity from the authority fields.
			got, err := Parse(State{OrganizationID: tc.Project.OrganizationID, ProjectID: tc.Project.ID, ServiceID: tc.Service.ID, DeploymentID: tc.Deployment.ID, ProjectSlug: tc.Project.Slug, ServiceSlug: tc.Service.Slug, DeploymentType: tc.Deployment.DeploymentType, PullRequestNumber: tc.Deployment.PullRequestNumber, SnapshotVersion: 1, Snapshot: snapshot, ImageURL: "registry.test/image:one"})
			// Then: exact compiler naming, including hashed/truncated/preview shapes.
			if err != nil || got.Namespace != tc.Expected.Namespace || got.WorkloadName != tc.Expected.WorkloadName || got.Kind != tc.Expected.Kind || got.ContainerName != tc.Expected.ContainerName {
				t.Fatalf("identity mismatch: %#v err=%v", got, err)
			}
		})
	}
}
