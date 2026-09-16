package store

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSnapshotFileClaimAndTransitionKeepCapturedRuntime(t *testing.T) {
	// Given: the service has changed since this snapshot was captured.
	path := filepath.Join(t.TempDir(), "state.json")
	payload := `{"projects":[{"id":"prj","status":"ACTIVE"}],"services":[{"id":"svc","projectId":"prj","type":"web","port":9000,"desiredSpec":{"command":["changed"]}}],"deployments":[{"id":"dep","serviceId":"svc","projectId":"prj","status":"IMAGE_READY","triggerType":"retry","sourceDeploymentId":"source","retryOfDeploymentId":"retry-source","snapshotVersion":1,"desiredSpecSnapshot":{"type":"worker","port":8080,"command":["captured"]}}]}`
	if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
		t.Fatal(err)
	}
	s := NewFileStore(path)
	ctx := context.Background()
	// When: both storage return paths decode the same immutable metadata.
	claimed, err := s.ClaimNextDeployment(ctx, ClaimOptions{WorkerID: "test", Now: time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)})
	if err != nil || claimed == nil {
		t.Fatalf("claim: %v", err)
	}
	updated, err := s.TransitionDeployment(ctx, claimed.Lease(), map[string]any{"status": DeploymentStatusReady})
	if err != nil {
		t.Fatal(err)
	}
	// Then
	for _, deployment := range []*Deployment{claimed, updated} {
		if deployment.SnapshotVersion != 1 || deployment.SourceDeploymentID != "source" || deployment.RetryOfDeploymentID != "retry-source" || deployment.TriggerType != "retry" {
			t.Fatalf("lineage was lost: %#v", deployment)
		}
		view, err := deployment.RuntimeService(&Service{ID: "svc", Port: 9000})
		if err != nil || view.Port != 8080 || view.Type != "worker" || view.ID != "svc" {
			t.Fatalf("runtime snapshot lost: view=%#v err=%v", view, err)
		}
	}
}

func TestSnapshotFileDecodeRejectsMalformedVersions(t *testing.T) {
	for _, version := range []string{`"1"`, `1.5`, `false`, `0`, `-1`, `{}`} {
		t.Run(version, func(t *testing.T) {
			// Given
			var row record
			if err := json.Unmarshal([]byte(`{"snapshotVersion":`+version+`,"desiredSpecSnapshot":{"type":"web"}}`), &row); err != nil {
				t.Fatal(err)
			}
			// When
			_, err := deploymentFromRecord(row).RuntimeService(&Service{})
			// Then
			if !errors.Is(err, ErrDeploymentSnapshot) {
				t.Fatalf("malformed version accepted: %v", err)
			}
		})
	}
}

func TestSnapshotProjectionDoesNotMutateLiveAuthority(t *testing.T) {
	// Given
	live := &Service{ID: "live", ProjectID: "project", Slug: "web", Status: DeletionStatusDeleting, ImageURL: "live:tag", DesiredSpec: map[string]any{"command": []string{"live"}}}
	deployment := &Deployment{SnapshotVersion: 1, DesiredSpecSnapshot: json.RawMessage(`{"type":"worker","command":["captured"],"status":"ACTIVE","id":"forged","credentials":{"token":"ignored"}}`)}
	// When
	view, err := deployment.RuntimeService(live)
	// Then
	if err != nil || view.ID != live.ID || view.Status != DeletionStatusDeleting || view.ImageURL != live.ImageURL || view == live {
		t.Fatalf("authority changed: view=%#v err=%v", view, err)
	}
	view.DesiredSpec["command"] = []string{"projection-only"}
	if live.DesiredSpec["command"].([]string)[0] != "live" || len(view.DesiredSpec) != 2 {
		t.Fatal("projection shares mutable state or retains non-runtime fields")
	}
}
