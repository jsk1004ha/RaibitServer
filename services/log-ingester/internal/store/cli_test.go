package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestIngestionHappyCLIEqualTimestampPEMRestart(t *testing.T) {
	// Given: a real compiled worker, UUID PostgreSQL database and authenticated HTTP kube fixture.
	h := postgresFixture(t)
	binary := os.Getenv("RAIBITSERVER_TEST_BINARY")
	if binary == "" {
		t.Fatal("qualification requires actual binary")
	}
	objects := cliObjects(h)
	lines := []string{"before -----BEGIN RSA PRIVATE KEY-----", "FORBIDDEN_PEM_MIDDLE", "-----END RSA PRIVATE KEY----- after", "ready"}
	var mu sync.Mutex
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer local-fixture-token" {
			t.Error("missing authenticated fixture request")
			w.WriteHeader(401)
			return
		}
		mu.Lock()
		requests = append(requests, r.URL.RequestURI())
		mu.Unlock()
		if strings.HasSuffix(r.URL.Path, "/log") {
			if r.URL.Query().Get("container") != "web" || r.URL.Query().Get("timestamps") != "true" {
				t.Error("log request contract")
			}
			for _, line := range lines {
				fmt.Fprintf(w, "%s %s\n", h.now.Format(time.RFC3339Nano), line)
			}
			return
		}
		obj, ok := objects[r.URL.Path]
		if !ok {
			w.WriteHeader(404)
			return
		}
		if err := json.NewEncoder(w).Encode(obj); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var transcript strings.Builder
	// When: each bounded run accepts one new row despite inclusive equal-timestamp replay.
	for index := 0; index < 5; index++ {
		command := exec.CommandContext(ctx, binary)
		command.Env = append(os.Environ(), "DATABASE_URL="+os.Getenv("RAIBITSERVER_TEST_DATABASE_URL"), "RAIBITSERVER_KUBERNETES_API="+server.URL, "RAIBITSERVER_KUBERNETES_TOKEN=local-fixture-token", "RAIBITSERVER_RUN_ONCE=1", "RAIBITSERVER_INGEST_MAX_RECORDS=1", "RAIBITSERVER_INGEST_MAX_LINES=1")
		output, err := command.CombinedOutput()
		transcript.Write(output)
		if err != nil {
			t.Fatalf("actual worker failed: %v output=%s", err, output)
		}
		want := "inserted=1"
		if index == 4 {
			want = "inserted=0"
		}
		if !strings.Contains(string(output), want) || strings.Contains(string(output), "FORBIDDEN") {
			t.Fatal("worker restart output did not prove bounded progress")
		}
	}
	// Then: raw v1 hashes are stable; all four rows are masked and state contains no source bytes.
	var count int
	var leaked bool
	if err := h.store.db.QueryRowContext(ctx, `SELECT COUNT(*),COALESCE(bool_or(line LIKE '%FORBIDDEN%'),false) FROM "RuntimeLog" WHERE "serviceId"=$1`, h.scope.ServiceID).Scan(&count, &leaked); err != nil {
		t.Fatal(err)
	}
	if count != 4 || leaked {
		t.Fatalf("restart persistence: rows=%d leaked=%t", count, leaked)
	}
	for _, line := range lines {
		hash := sha256.Sum256([]byte("cli-pod-uid\x00web\x00" + h.now.Format(time.RFC3339Nano) + "\x00" + line))
		var exists bool
		if err := h.store.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM "RuntimeLog" WHERE "sourceKey"=$1)`, hex.EncodeToString(hash[:])).Scan(&exists); err != nil || !exists {
			t.Fatal("v1 original source key changed")
		}
	}
	watermark, err := h.store.State(ctx, "logs:cli-pod-uid:web")
	if err != nil || watermark != h.now.Format(time.RFC3339Nano) {
		t.Fatal("timestamp cursor changed")
	}
	state, err := h.store.State(ctx, "logs-state:cli-pod-uid:web")
	if err != nil || strings.Contains(state, "FORBIDDEN") || !strings.Contains(state, `"sequence":4`) {
		t.Fatal("nonsecret continuation not durable")
	}
	if root := os.Getenv("RAIBITSERVER_EVIDENCE_DIR"); root != "" {
		if err := os.WriteFile(filepath.Join(root, "cli-restart.log"), []byte(transcript.String()), 0o600); err != nil {
			t.Fatal(err)
		}
		mu.Lock()
		raw, err := json.MarshalIndent(struct {
			Objects       map[string]map[string]any
			Requests      []string
			Rows          int
			Cursor, State string
		}{objects, requests, count, watermark, state}, "", "  ")
		mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "http-cli-pg.json"), raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("actual_binary_restarts=5 accepted_rows=%d equal_timestamp=true source_v1=true masked=true", count)
}

func cliObjects(h harness) map[string]map[string]any {
	s := h.scope
	labels := map[string]string{"app.kubernetes.io/managed-by": "raibitserver", "raibitserver.io/project-id": s.ProjectID, "raibitserver.io/service-id": s.ServiceID, "raibitserver.io/deployment-id": s.DeploymentID}
	containers := []map[string]any{{"name": "web", "image": s.Image, "env": []map[string]string{{"name": "RAIBITSERVER_PROJECT_ID", "value": s.ProjectID}, {"name": "RAIBITSERVER_DEPLOYMENT_ID", "value": s.DeploymentID}, {"name": "RAIBITSERVER_SERVICE_ID", "value": s.ServiceID}, {"name": "RAIBITSERVER_DEPLOYMENT_TYPE", "value": "production"}}}}
	template := map[string]any{"metadata": map[string]any{"labels": labels}, "spec": map[string]any{"containers": containers}}
	owner := func(kind, name, uid string) []map[string]any {
		return []map[string]any{{"apiVersion": "apps/v1", "kind": kind, "name": name, "uid": uid, "controller": true}}
	}
	pod := map[string]any{"apiVersion": "v1", "kind": "Pod", "metadata": map[string]any{"name": "pod", "namespace": s.Namespace, "uid": "cli-pod-uid", "creationTimestamp": h.now.Add(-time.Minute).Format(time.RFC3339Nano), "labels": labels, "ownerReferences": owner("ReplicaSet", "rs", "rs-uid")}, "spec": map[string]any{"containers": containers}}
	return map[string]map[string]any{
		"/api/v1/pods":                                                 {"metadata": map[string]string{}, "items": []map[string]any{pod}},
		"/api/v1/namespaces/" + s.Namespace:                            {"apiVersion": "v1", "kind": "Namespace", "metadata": map[string]any{"name": s.Namespace, "uid": "namespace-uid", "labels": labels}},
		"/api/v1/namespaces/" + s.Namespace + "/pods/pod":              pod,
		"/apis/apps/v1/namespaces/" + s.Namespace + "/replicasets/rs":  {"apiVersion": "apps/v1", "kind": "ReplicaSet", "metadata": map[string]any{"name": "rs", "namespace": s.Namespace, "uid": "rs-uid", "ownerReferences": owner("Deployment", "web", "workload-uid")}, "spec": map[string]any{"template": template}},
		"/apis/apps/v1/namespaces/" + s.Namespace + "/deployments/web": {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": map[string]any{"name": "web", "namespace": s.Namespace, "uid": "workload-uid", "labels": labels}, "spec": map[string]any{"template": template}},
	}
}
