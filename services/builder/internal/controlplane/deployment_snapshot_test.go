package controlplane

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDeploymentSnapshotFileBoundary(t *testing.T) {
	for _, raw := range []string{
		`{"snapshotVersion":1,"desiredSpecSnapshot":{"buildMode":"dockerfile","buildArgs":{"VERSION":"frozen"}},"sourceDeploymentId":"source","retryOfDeploymentId":"source"}`,
		`{"snapshotVersion":null,"desiredSpecSnapshot":null}`,
		`{"snapshotVersion":2,"desiredSpecSnapshot":{}}`,
		`{"snapshotVersion":1.5,"desiredSpecSnapshot":{}}`,
		`{"snapshotVersion":"1","desiredSpecSnapshot":{}}`,
		`{"snapshotVersion":1,"desiredSpecSnapshot":[]}`,
		`{"snapshotVersion":1,"desiredSpecSnapshot":{"buildArgs":[]}}`,
	} {
		t.Run(raw, func(t *testing.T) {
			// Given a persisted wire-shaped Deployment.
			var row map[string]any
			if err := json.Unmarshal([]byte(raw), &row); err != nil {
				t.Fatal(err)
			}
			row["id"] = "deployment"
			data, err := json.Marshal(map[string]any{"deployments": []any{row}})
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "state.json")
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			// When reading through the actual FileStore.
			deployment, err := NewFileStore(path).GetDeployment(context.Background(), "deployment")
			// Then only legacy null or typed v1 records cross the boundary.
			valid := row["snapshotVersion"] == nil || row["sourceDeploymentId"] == "source"
			if !valid {
				if !errors.Is(err, ErrDeploymentSnapshot) {
					t.Fatalf("invalid file snapshot accepted: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if row["sourceDeploymentId"] == "source" {
				spec, err := deployment.BuildSpec()
				if err != nil || spec.BuildArgs["VERSION"] != "frozen" || deployment.SourceDeploymentID != "source" || deployment.RetryOfDeploymentID != "source" {
					t.Fatal("file snapshot/lineage lost")
				}
			}
		})
	}
}

func TestDeploymentSnapshotRemoteBoundary(t *testing.T) {
	for _, version := range []int{1, 99} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			// Given a scoped mTLS dispatcher carrying durable snapshot data.
			files := writeDispatchTestCertificates(t)
			tlsConfig, err := NewDispatcherTLSConfig(files.ca, files.serverCert, files.serverKey)
			if err != nil {
				t.Fatal(err)
			}
			fixture := newDispatchFixtureStore()
			fixture.deployment.SnapshotVersion = &version
			fixture.deployment.SourceDeploymentID = "source"
			fixture.deployment.RetryOfDeploymentID = "source"
			fixture.deployment.DesiredSpecSnapshot = json.RawMessage(`{"repoUrl":"https://github.com/acme/frozen.git","buildMode":"dockerfile"}`)
			server := httptest.NewUnstartedServer(NewDispatchHandler(fixture, 15*time.Minute))
			server.TLS = tlsConfig
			server.StartTLS()
			defer server.Close()
			store, err := NewRemoteStore(RemoteStoreConfig{BaseURL: server.URL, CAFile: files.ca, ClientCertificateFile: files.clientCert, ClientKeyFile: files.clientKey})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{WorkerID: "executor-1"}); err != nil {
				t.Fatal(err)
			}
			// When reading via the real HTTP client and dispatcher.
			deployment, err := store.GetDeployment(context.Background(), "deployment-1")
			// Then version validation and snapshot/lineage survive the remote wire.
			if version != 1 {
				if !errors.Is(err, ErrDeploymentSnapshot) {
					t.Fatalf("unknown remote snapshot accepted: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			spec, err := deployment.BuildSpec()
			if err != nil || spec.RepoURL != "https://github.com/acme/frozen.git" || deployment.SourceDeploymentID != "source" || deployment.RetryOfDeploymentID != "source" {
				t.Fatal("remote snapshot/lineage lost")
			}
		})
	}
}

func TestDeploymentSnapshotPostgresScanBoundary(t *testing.T) {
	for _, version := range []any{nil, int64(1), int64(2)} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			// Given exactly the selected SQL row columns; this is a scan unit test, not database acceptance.
			row := snapshotScanRow{
				"dep", "service", "project", "queued", "production", "retry", "main", nil, nil, nil, nil, nil, nil,
				[]byte(`{"buildContext":"frozen"}`), version, "source", "source",
			}
			// When the production scanner decodes the driver values.
			deployment, err := scanDeployment(row)
			// Then unsupported/missing versions fail and v1 carries its lineage and spec.
			if version != int64(1) {
				if !errors.Is(err, ErrDeploymentSnapshot) {
					t.Fatalf("invalid SQL snapshot accepted: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			spec, err := deployment.BuildSpec()
			if err != nil || spec.BuildContext != "frozen" || deployment.SourceDeploymentID != "source" || deployment.RetryOfDeploymentID != "source" {
				t.Fatal("SQL snapshot/lineage lost")
			}
		})
	}
}

type snapshotScanRow []any

func (row snapshotScanRow) Scan(dest ...any) error {
	if len(row) != len(dest) {
		return fmt.Errorf("scan column count: %d != %d", len(row), len(dest))
	}
	for index, value := range row {
		switch target := dest[index].(type) {
		case *string:
			text, ok := value.(string)
			if !ok {
				return fmt.Errorf("column %d is not text", index)
			}
			*target = text
		case *[]byte:
			data, ok := value.([]byte)
			if !ok {
				return fmt.Errorf("column %d is not JSON", index)
			}
			*target = data
		case sql.Scanner:
			if err := target.Scan(value); err != nil {
				return err
			}
		default:
			return fmt.Errorf("unsupported scan destination %T", target)
		}
	}
	return nil
}
