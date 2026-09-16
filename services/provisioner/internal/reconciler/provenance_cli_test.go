package reconciler

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProvenanceCLIObservedRecordSurvivesHealthConfigDrift(t *testing.T) {
	// Given a private migrated PostgreSQL database and controlled kubectl/API wire.
	dsn := os.Getenv("RAIBITSERVER_PROVENANCE_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("private PostgreSQL CLI qualification is run by qualify-cli.sh")
	}
	directory := os.Getenv("RAIBITSERVER_PROVENANCE_FIXTURE_DIR")
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	image := "registry.example/postgres@sha256:" + strings.Repeat("a", 64)
	_, err = db.Exec(`INSERT INTO "Organization" (id,name,slug,"updatedAt") VALUES ('provenance-org','Provenance','provenance-org',CURRENT_TIMESTAMP);
INSERT INTO "Project" (id,"organizationId",name,slug,status,"updatedAt") VALUES ('provenance-project','provenance-org','Provenance','demo','ACTIVE',CURRENT_TIMESTAMP)`)
	if err != nil {
		t.Fatal(err)
	}
	desired := provenanceJSON(t, map[string]any{"resourceExecution": map[string]any{"intent": "live-provision", "environment": "local", "image": image}})
	_, err = db.Exec(`INSERT INTO "Resource" (id,"projectId",name,slug,type,engine,provider,plan,region,status,"desiredSpec","desiredState","updatedAt") VALUES ('provenance-resource','provenance-project','Database','db','database','postgresql','raibitserver','shared-small','local','PROVISIONING','{}',$1,CURRENT_TIMESTAMP)`, desired)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer local-provenance-fixture" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		payload, err := os.ReadFile(filepath.Join(directory, "secret-metadata.json"))
		if os.IsNotExist(err) {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if _, err := w.Write(payload); err != nil {
			t.Error(err)
		}
	}))
	t.Cleanup(server.Close)
	certificate := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
	for name, content := range map[string][]byte{"ca.crt": certificate, "token": []byte("local-provenance-fixture")} {
		if err := os.WriteFile(filepath.Join("/var/run/secrets/kubernetes.io/serviceaccount", name), content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	endpoint, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("KUBERNETES_SERVICE_HOST", endpoint.Hostname())
	t.Setenv("KUBERNETES_SERVICE_PORT", endpoint.Port())
	t.Setenv("RAIBITSERVER_CONTROL_PLANE_DATABASE_URL", dsn)
	t.Setenv("RAIBITSERVER_EXECUTE", "1")
	t.Setenv("RAIBITSERVER_RESOURCE_ENVIRONMENT", "local")
	t.Setenv("RAIBITSERVER_PROVIDER_POSTGRESQL_IMAGE", image)
	t.Setenv("RAIBITSERVER_PROVISIONER_OUTPUT_DIR", filepath.Join(directory, "manifests"))
	t.Setenv("RAIBITSERVER_PROVISIONER_SERVICE_ACCOUNT_NAME", "raibitserver-provisioner")
	t.Setenv("RAIBITSERVER_PROVISIONER_SERVICE_ACCOUNT_NAMESPACE", "raibitserver-system")
	t.Setenv("RAIBITSERVER_PROVISIONER_TENANT_ROLE_NAME", "raibitserver-provisioner-tenant")
	t.Setenv("RAIBITSERVER_PROVISION_TIMEOUT_SECONDS", "3")
	t.Setenv("RAIBITSERVER_PROVIDER_HEALTH_INTERVAL_SECONDS", "300")
	t.Setenv("PATH", directory+":"+os.Getenv("PATH"))
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(executable, filepath.Join(directory, "kubectl")); err != nil {
		t.Fatal(err)
	}
	// When the actual provisioner CLI applies and observes READY, then health uses image B.
	provenanceRunCLI(t, "apply", false)
	first := provenanceCLIRecord(t, db, "apply")
	var record providerImageProvenance
	if err := json.Unmarshal(first, &record); err != nil {
		t.Fatal(err)
	}
	if record.Schema != "raibitserver.provider-image/v1" || record.Image != image || record.WorkloadUID != provenanceUID || record.WorkloadGeneration != 7 {
		t.Fatalf("wrong applied record: %+v", record)
	}
	if _, err := time.Parse(time.RFC3339Nano, record.ObservedAt); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RAIBITSERVER_PROVIDER_POSTGRESQL_IMAGE", "registry.example/postgres@sha256:"+strings.Repeat("b", 64))
	for _, stage := range []string{"healthy-drift", "failed-health-drift"} {
		if _, err := db.Exec(`UPDATE "Resource" SET "updatedAt"=(clock_timestamp() AT TIME ZONE 'UTC') - interval '10 minutes' WHERE id='provenance-resource'`); err != nil {
			t.Fatal(err)
		}
		failure := stage == "failed-health-drift"
		if failure {
			if err := os.WriteFile(filepath.Join(directory, "fail-health"), nil, 0o600); err != nil {
				t.Fatal(err)
			}
		}
		provenanceRunCLI(t, stage, failure)
		// Then persisted provenance is byte-identical through success and failure.
		if got := provenanceCLIRecord(t, db, stage); !bytes.Equal(got, first) {
			t.Fatalf("%s replaced provenance: %s", stage, got)
		}
	}
	provenanceAssertPostgresFence(t, db, first)
	t.Log("actual CLI apply/owned READY persisted exact image A, UID and generation; health success/failure with configured image B preserved complete record")
}

func provenanceRunCLI(t *testing.T, stage string, failure bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Getenv("RAIBITSERVER_PROVENANCE_CLI_BINARY"))
	var other bytes.Buffer
	stream, err := cmd.StdoutPipe()
	if failure {
		cmd.Stdout = &other
		stream, err = cmd.StderrPipe()
	} else {
		cmd.Stderr = &other
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(stream)
	if !scanner.Scan() {
		cancel()
		waitErr := cmd.Wait()
		t.Fatalf("CLI produced no result: %v %v %s", scanner.Err(), waitErr, other.String())
	}
	line := scanner.Text()
	if err := cmd.Process.Signal(os.Interrupt); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("CLI shutdown: %v %s", err, other.String())
	}
	if failure {
		if !strings.Contains(line, "provisioner reconcile failed:") {
			t.Fatalf("missing failed health observable: %s", line)
		}
	} else {
		var result Result
		if err := json.Unmarshal([]byte(line), &result); err != nil || result.Status != "READY" || result.Processed != 1 {
			t.Fatalf("CLI result=%s err=%v", line, err)
		}
	}
	artifact := filepath.Join(os.Getenv("RAIBITSERVER_PROVENANCE_FIXTURE_DIR"), stage+"-cli.log")
	if err := os.WriteFile(artifact, []byte(line+"\n"+other.String()), 0o600); err != nil {
		t.Fatal(err)
	}
}

func provenanceCLIRecord(t *testing.T, db *sql.DB, stage string) []byte {
	t.Helper()
	var status, health string
	var record, desired []byte
	if err := db.QueryRow(`SELECT status,"desiredState"->>'healthStatus',"desiredState"->'providerImageProvenance',"desiredState" FROM "Resource" WHERE id='provenance-resource'`).Scan(&status, &health, &record, &desired); err != nil {
		t.Fatal(err)
	}
	wantHealth := "HEALTHY"
	if stage == "failed-health-drift" {
		wantHealth = "UNHEALTHY"
	}
	if status != "READY" || health != wantHealth {
		t.Fatalf("stage=%s status=%s health=%s", stage, status, health)
	}
	if err := os.WriteFile(filepath.Join(os.Getenv("RAIBITSERVER_PROVENANCE_FIXTURE_DIR"), stage+"-persisted.json"), desired, 0o600); err != nil {
		t.Fatal(err)
	}
	return record
}
