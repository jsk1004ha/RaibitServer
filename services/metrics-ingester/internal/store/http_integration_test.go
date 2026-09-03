//go:build integration

package store

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/metrics-ingester/internal/ingester"
	"github.com/raibitserver/metrics-ingester/internal/kube"
)

func TestActualProcessAuthenticatedHTTPPostgres(t *testing.T) {
	// Given: real binary, HTTP adapter, and migrated PostgreSQL authority.
	p, r := fixtureStore(t)
	f := newHTTPFixture(r)
	f.server(t)
	binary := os.Getenv("RAIBITSERVER_METRICS_BINARY")
	if binary == "" {
		t.Fatal("native binary required")
	}
	// When: fresh processes ingest then replay the same UID-less source snapshot.
	var outputs []byte
	for range 2 {
		cmd := exec.CommandContext(t.Context(), binary)
		cmd.Env = append(os.Environ(), "DATABASE_URL="+os.Getenv("RAIBITSERVER_TEST_DATABASE_URL"), "RAIBITSERVER_RUN_ONCE=1")
		output, err := cmd.CombinedOutput()
		outputs = append(outputs, output...)
		if err != nil {
			t.Fatalf("process failed: %s %v", output, err)
		}
	}
	// Then: two real rows use the resolved Pod UID, exact tenant and unchanged v1 key.
	if count(t, p.db, `SELECT count(*) FROM "RuntimeMetric" WHERE "deploymentId"=$1 AND "podUid"=$2`, r.DeploymentID, r.PodUID) != 2 || count(t, p.db, `SELECT count(*) FROM "RuntimeMetric" WHERE "sourceKey"=$1`, r.SourceKey) != 1 || !strings.Contains(string(outputs), "inserted=0") || !strings.Contains(string(outputs), "observed=true") {
		t.Fatalf("process outcome: %s", outputs)
	}
	if err := os.WriteFile(filepath.Join(os.Getenv("RAIBITSERVER_EVIDENCE_DIR"), "process.txt"), outputs, 0o600); err != nil {
		t.Fatal(err)
	}
	f.capture(t)
}

func TestAuthenticatedHTTPIdentityAdversarial(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*httpFixture)
	}{
		{"uid_mismatch", func(f *httpFixture) { f.Sample.Metadata.UID = "old-uid" }},
		{"creation_after_sample", func(f *httpFixture) { f.Pod.Metadata.Creation = f.Pod.Metadata.Creation.Add(2 * time.Minute) }},
		{"foreign_namespace", func(f *httpFixture) { f.Sample.Metadata.Namespace = "foreign" }},
		{"foreign_label", func(f *httpFixture) {
			f.Sample.Metadata.Labels = map[string]string{"raibitserver.io/deployment-id": f.Sample.Metadata.Labels["raibitserver.io/deployment-id"], "raibitserver.io/service-id": "foreign"}
		}},
		{"pod_reused", func(f *httpFixture) { f.Pod.Metadata.UID = "new-uid"; f.Sample.Metadata.UID = "old-uid" }},
		{"owner_uid", func(f *httpFixture) { f.Pod.Metadata.Owners[0].UID = "foreign-owner" }},
		{"owner_kind", func(f *httpFixture) { f.Pod.Metadata.Owners[0].Kind = "Job" }},
		{"owner_controller", func(f *httpFixture) { f.Pod.Metadata.Owners[0].Controller = false }},
		{"owner_cycle", func(f *httpFixture) { f.Pod.Metadata.Owners[0].UID = f.Pod.Metadata.UID }},
		{"owner_namespace", func(f *httpFixture) { f.Middle.Metadata.Namespace = "foreign" }},
		{"owner_deleted", func(f *httpFixture) { now := time.Now(); f.Middle.Metadata.Deletion = &now }},
		{"pod_deleted", func(f *httpFixture) { now := time.Now(); f.Pod.Metadata.Deletion = &now }},
		{"workload_uid", func(f *httpFixture) { f.Workload.Metadata.UID = "replacement" }},
		{"template_stale", func(f *httpFixture) {
			f.Workload.Spec.Template.Metadata.Labels = map[string]string{"raibitserver.io/deployment-id": "older"}
		}},
		{"template_image", func(f *httpFixture) {
			f.Workload.Spec.Template.Spec.Containers = []wireContainer{{Name: f.Sample.Containers[0].Name, Image: "foreign/image:one"}}
		}},
		{"sample_future", func(f *httpFixture) { f.Sample.Timestamp = time.Now().Add(time.Minute).Format(time.RFC3339Nano) }},
		{"container_membership", func(f *httpFixture) { f.Sample.Containers[0].Name = "other" }},
		{"negative_cpu", func(f *httpFixture) { f.Sample.Containers[0].Usage["cpu"] = "-1" }},
		{"infinite_memory", func(f *httpFixture) { f.Sample.Containers[0].Usage["memory"] = "1e999" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Given: one violated authority/time/value boundary on real HTTP.
			p, r := fixtureStore(t)
			f := newHTTPFixture(r)
			tc.mutate(f)
			f.server(t)
			source, err := kube.NewFromEnvironment()
			if err != nil {
				t.Fatal(err)
			}
			// When: the production worker processes the response.
			_, runErr := ingester.New(ingester.Config{}, source, p).RunOnce(t.Context(), time.Now().UTC())
			// Then: the violating sample never reaches rows or cursor state.
			if count(t, p.db, `SELECT count(*) FROM "RuntimeMetric" WHERE "deploymentId"=$1`, r.DeploymentID) != 0 || count(t, p.db, `SELECT count(*) FROM "IngestionCursor" WHERE key LIKE $1`, "metrics:"+r.PodUID+":%") != 0 {
				t.Fatalf("adversarial sample persisted: err=%v", runErr)
			}
			f.capture(t)
		})
	}
}
