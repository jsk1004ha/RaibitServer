package controlplane

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func githubPostgresFixture(t *testing.T) (*PostgresStore, githubCredentialBinding) {
	t.Helper()
	dsn := os.Getenv("RAIBITSERVER_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("local PostgreSQL fixture not configured")
	}
	db, err := sql.Open(postgresDriverName, dsn)
	if err != nil {
		t.Fatal("open fixture database")
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error("close fixture database")
		}
	})
	id := fmt.Sprintf("github-credential-%d", time.Now().UnixNano())
	b := githubCredentialBinding{Lease: WorkflowLease{JobID: id, WorkerID: "credential-worker", Attempt: 1}, OrganizationID: id, ProjectID: id, ServiceID: id, DeploymentID: id, IntegrationID: id, InstallationID: fmt.Sprint(time.Now().UnixNano()), RepositoryID: fmt.Sprint(time.Now().UnixNano() + 1), Repository: "acme/private"}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(query, args...); err != nil {
			t.Fatalf("fixture SQL failed: %v", err)
		}
	}
	t.Cleanup(func() {
		for _, query := range []string{`DELETE FROM "WorkflowJob" WHERE id=$1`, `DELETE FROM "GitHubIntegration" WHERE id=$1`, `DELETE FROM "GitHubInstallation" WHERE "accountLogin"=$1`, `DELETE FROM "Organization" WHERE id=$1`} {
			if _, err := db.Exec(query, id); err != nil {
				t.Error("fixture cleanup failed")
			}
		}
	})
	exec(`INSERT INTO "Organization" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,NOW())`, id)
	exec(`INSERT INTO "Project" (id,"organizationId",name,slug,"updatedAt") VALUES ($1,$1,$1,$1,NOW())`, id)
	exec(`INSERT INTO "GitHubInstallation" (id,"installationId","accountLogin","accountType","updatedAt") VALUES ($1,$2,$1,'Organization',NOW())`, id, b.InstallationID)
	exec(`INSERT INTO "GitHubIntegration" (id,"organizationId","installationId",status,"verifiedAt","updatedAt") VALUES ($1,$1,$2,'ACTIVE',NOW(),NOW())`, id, b.InstallationID)
	exec(`INSERT INTO "GitHubRepository" (id,"installationId","githubRepoId",owner,name,"fullName",private,"updatedAt") VALUES ($1,$2,$3,'acme','private','acme/private',TRUE,NOW())`, id, b.InstallationID, b.RepositoryID)
	desired, err := json.Marshal(map[string]string{"githubIntegrationId": id, "githubInstallationId": b.InstallationID, "githubRepositoryId": b.RepositoryID, "githubRepository": b.Repository, "githubRepositoryVisibility": "private", "sourceAccess": "github-app-private"})
	if err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO "Service" (id,"projectId",name,slug,type,"sourceType","repoUrl","githubRepositoryId","desiredState","updatedAt") VALUES ($1,$1,$1,$1,'web','github','https://github.com/acme/private.git',$2,$3,NOW())`, id, b.RepositoryID, desired)
	exec(`INSERT INTO "Deployment" (id,"projectId","serviceId",status,"updatedAt") VALUES ($1,$1,$1,'BUILDING',NOW())`, id)
	exec(`INSERT INTO "WorkflowJob" (id,type,status,"targetType","targetId",payload,attempts,"lockedBy","lockedAt","updatedAt") VALUES ($1,'build','running','deployment',$1,'{}',1,'credential-worker',NOW(),NOW())`, id)
	return &PostgresStore{db: db}, b
}

func TestGitHubCredentialFailureMatrixPostgres(t *testing.T) {
	for _, field := range []string{"organization", "project", "service", "deployment", "installation", "repository", "integration", "worker", "attempt", "expired", "catalog-removed", "unverified", "disconnected", "source-access-revoked", "url", "desired-state"} {
		t.Run(field, func(t *testing.T) {
			// Given independent actual PostgreSQL ownership rows.
			store, binding := githubPostgresFixture(t)
			query := ""
			switch field {
			case "organization":
				binding.OrganizationID = "foreign"
			case "project":
				binding.ProjectID = "foreign"
			case "service":
				binding.ServiceID = "foreign"
			case "deployment":
				binding.DeploymentID = "foreign"
			case "installation":
				binding.InstallationID = "1"
			case "repository":
				binding.RepositoryID = "1"
			case "integration":
				binding.IntegrationID = "foreign"
			case "worker":
				binding.Lease.WorkerID = "foreign"
			case "attempt":
				binding.Lease.Attempt++
			case "expired":
				query = `UPDATE "WorkflowJob" SET "lockedAt" = NOW()-INTERVAL '301 seconds' WHERE id=$1`
			case "catalog-removed":
				query = `DELETE FROM "GitHubRepository" WHERE id=$1`
			case "unverified":
				query = `UPDATE "GitHubIntegration" SET "verifiedAt"=NULL WHERE id=$1`
			case "disconnected":
				query = `UPDATE "GitHubIntegration" SET status='DISCONNECTED', "verifiedAt"=NULL WHERE id=$1`
			case "source-access-revoked":
				query = `UPDATE "Service" SET "desiredState"=jsonb_set("desiredState", '{sourceAccess}', '"SOURCE_ACCESS_REVOKED"') WHERE id=$1`
			case "url":
				query = `UPDATE "Service" SET "repoUrl"='https://github.com/acme/foreign.git' WHERE id=$1`
			case "desired-state":
				query = `UPDATE "Service" SET "desiredState"='{}' WHERE id=$1`
			}
			if query != "" {
				if _, err := store.db.Exec(query, binding.Lease.JobID); err != nil {
					t.Fatal("mutate fixture")
				}
			}
			// When reserving a credential for a mismatched tuple.
			err := store.authorizeGitHubCredential(context.Background(), binding, true)
			// Then no issuance reservation is authorized.
			if err == nil {
				t.Fatal("foreign or stale binding authorized")
			}
		})
	}
	t.Run("single-attempt", func(t *testing.T) {
		store, binding := githubPostgresFixture(t)
		var allowed atomic.Int32
		var group sync.WaitGroup
		for range 8 {
			group.Add(1)
			go func() {
				defer group.Done()
				if store.authorizeGitHubCredential(context.Background(), binding, true) == nil {
					allowed.Add(1)
				}
			}()
		}
		group.Wait()
		if allowed.Load() != 1 {
			t.Fatalf("reservation winners=%d", allowed.Load())
		}
		if err := store.authorizeGitHubCredential(context.Background(), binding, false); err != nil {
			t.Fatal("reserved tuple did not revalidate")
		}
	})
	t.Run("non-UTC-session", func(t *testing.T) {
		store, binding := githubPostgresFixture(t)
		store.db.SetMaxOpenConns(1)
		if _, err := store.db.Exec(`SET TIME ZONE 'Asia/Seoul'`); err != nil {
			t.Fatal(err)
		}
		if err := store.authorizeGitHubCredential(context.Background(), binding, true); err != nil {
			t.Fatal("valid UTC lease rejected under nonUTC session")
		}
		if _, err := store.db.Exec(`UPDATE "WorkflowJob" SET "lockedAt"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-INTERVAL '301 seconds' WHERE id=$1`, binding.Lease.JobID); err != nil {
			t.Fatal(err)
		}
		if err := store.authorizeGitHubCredential(context.Background(), binding, false); err == nil {
			t.Fatal("expired lease authorized under nonUTC session")
		}
	})
}

func TestGitHubCredentialHappyPostgresMTLS(t *testing.T) {
	testGitHubPostgresMTLS(t, "")
}

func TestGitHubCredentialFailureMatrixReclaimedReleasePostgres(t *testing.T) {
	testGitHubPostgresMTLS(t, "after")
}

func TestGitHubCredentialFailureMatrixReclaimedDuringIssuePostgres(t *testing.T) {
	testGitHubPostgresMTLS(t, "issue")
}

func testGitHubPostgresMTLS(t *testing.T, reclaimStage string) {
	reclaimed := reclaimStage == "after"
	// Given a live PostgreSQL store and actual TLS client/server certificate exchange.
	store, binding := githubPostgresFixture(t)
	if _, err := store.db.Exec(`UPDATE "WorkflowJob" SET status='queued', "runAfter"=$2, "lockedBy"=NULL, "lockedAt"=NULL, attempts=0 WHERE id=$1`, binding.Lease.JobID, time.Now().UTC().Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	var revoked atomic.Int32
	app := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			revoked.Add(1)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var request struct {
			RepositoryIDs []int64           `json:"repository_ids"`
			Permissions   map[string]string `json:"permissions"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil || len(request.RepositoryIDs) != 1 || fmt.Sprint(request.RepositoryIDs[0]) != binding.RepositoryID || request.Permissions["contents"] != "read" || len(request.Permissions) != 1 {
			t.Error("issuance scope mismatch")
			w.WriteHeader(403)
			return
		}
		w.WriteHeader(http.StatusCreated)
		if reclaimStage == "issue" {
			if _, err := store.db.Exec(`UPDATE "WorkflowJob" SET attempts=attempts+1 WHERE id=$1`, binding.Lease.JobID); err != nil {
				t.Error("reclaim during issuer request failed")
			}
		}
		fmt.Fprintf(w, `{"token":"ghs_pg_fixture","expires_at":%q,"repositories":[{"id":%s}]}`, time.Now().Add(time.Hour).Format(time.RFC3339), binding.RepositoryID)
	}))
	defer app.Close()
	issuer := newTestGitHubAppIssuer(t, app, time.Now())
	handler := NewDispatchHandlerWithGitHubCredentials(store, 15*time.Minute, issuer)
	certificates := writeDispatchTestCertificates(t)
	tlsConfig, err := NewDispatcherTLSConfig(certificates.ca, certificates.serverCert, certificates.serverKey)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(handler)
	server.TLS = tlsConfig
	server.StartTLS()
	defer server.Close()
	remote, err := NewRemoteStore(RemoteStoreConfig{BaseURL: server.URL, CAFile: certificates.ca, ClientCertificateFile: certificates.clientCert, ClientKeyFile: certificates.clientKey})
	if err != nil {
		t.Fatal(err)
	}
	job, err := remote.ClaimNextWorkflowJob(context.Background(), ClaimOptions{WorkerID: binding.Lease.WorkerID})
	if err != nil || job == nil {
		t.Fatalf("mTLS claim failed: %v no_job=%t", err, job == nil)
	}
	// When the exact claimed private repository is issued then released.
	credential, err := remote.IssueGitHubRepositoryCredential(context.Background(), GitHubRepositoryCredentialRequest{ServiceID: binding.ServiceID, InstallationID: binding.InstallationID, RepositoryID: binding.RepositoryID})
	if reclaimStage == "issue" {
		if err == nil || credential != nil || revoked.Load() != 1 {
			t.Fatal("inflight issuance survived lease loss or lacked revocation")
		}
		return
	}
	if err != nil {
		t.Fatalf("mTLS issuance failed: %v", err)
	}
	if credential.UseDeadline.Sub(time.Now()) < 4*time.Minute || credential.UpstreamExpiresAt.Sub(credential.UseDeadline) < 50*time.Minute {
		t.Fatal("native expiry was confused with use deadline")
	}
	if err := remote.CheckGitHubRepositoryCredential(context.Background()); err != nil {
		t.Fatal("active helper authorization failed")
	}
	if reclaimed {
		if _, err := store.db.Exec(`UPDATE "WorkflowJob" SET attempts=attempts+1 WHERE id=$1`, job.ID); err != nil {
			t.Fatal(err)
		}
		if err := remote.CheckGitHubRepositoryCredential(context.Background()); err == nil {
			t.Fatal("helper authorized reclaimed lease")
		}
	}
	if err := remote.ReleaseGitHubRepositoryCredential(context.Background(), !reclaimed); err != nil {
		t.Fatal("release failed")
	}
	if err := remote.ReleaseGitHubRepositoryCredential(context.Background(), !reclaimed); err != nil {
		t.Fatal("release not idempotent")
	}
	// Then upstream revocation was acknowledged once and DB never contains the token.
	if revoked.Load() != 1 {
		t.Fatal("revocation count mismatch")
	}
	var payload string
	if err := store.db.QueryRow(`SELECT payload::text FROM "WorkflowJob" WHERE id=$1`, job.ID).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(payload, credential.Token) {
		t.Fatal("credential persisted")
	}
	t.Log("repository=exact peer=verified reservation=one upstream_expiry=1h use_deadline=300s revoked=1 db_token_matches=0")
}
