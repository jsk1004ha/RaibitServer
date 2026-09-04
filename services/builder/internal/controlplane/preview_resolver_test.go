package controlplane

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

type previewResolverFixtureStore struct {
	claim       *PreviewResolutionClaim
	observation *PreviewResolutionObservation
	failureCode string
	commits     int
}

func (s *previewResolverFixtureStore) ClaimNextPreviewResolution(context.Context, string, time.Time) (*PreviewResolutionClaim, error) {
	return s.claim, nil
}

func (s *previewResolverFixtureStore) RenewPreviewResolutionLease(context.Context, PreviewResolutionClaim, time.Time) error {
	return nil
}

func (s *previewResolverFixtureStore) CommitPreviewResolution(_ context.Context, _ PreviewResolutionClaim, observation PreviewResolutionObservation, _ time.Time) (bool, error) {
	s.commits++
	s.observation = &observation
	return true, nil
}

func (s *previewResolverFixtureStore) FailPreviewResolution(_ context.Context, _ PreviewResolutionClaim, code string, _ time.Time) error {
	s.failureCode = code
	return nil
}

func TestPreviewResolverUsesScopedTokenObservesAndRevokes(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	var tokenPermissions map[string]string
	var pullCalls, revokeCalls int
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/app/installations/202/access_tokens":
			var body struct {
				Permissions map[string]string `json:"permissions"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			tokenPermissions = body.Permissions
			response.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(response).Encode(map[string]any{"token": "ghs_resolver-fixture", "expires_at": now.Add(time.Hour).Format(time.RFC3339), "repositories": []map[string]any{{"id": 101}}, "permissions": map[string]string{"pull_requests": "read"}})
		case "/repos/trusted/repo/pulls/17":
			pullCalls++
			if request.Header.Get("Authorization") != "Bearer ghs_resolver-fixture" {
				t.Fatal("resolver did not use issued credential")
			}
			_ = json.NewEncoder(response).Encode(map[string]any{"number": 17, "state": "open", "updated_at": now.Format(time.RFC3339), "head": map[string]any{"sha": strings.Repeat("a", 40), "ref": "feature/preview"}, "base": map[string]any{"ref": "main", "repo": map[string]any{"id": 101}}})
		case "/installation/token":
			revokeCalls++
			response.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected GitHub fixture request: %s", request.URL.Path)
		}
	}))
	defer server.Close()
	issuer := newTestGitHubAppIssuer(t, server, now).(GitHubPullRequestCredentialIssuer)
	github, err := NewGitHubPullRequestClient(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	store := &previewResolverFixtureStore{claim: &PreviewResolutionClaim{
		Target: PreviewResolutionTarget{LineageID: "lineage-1", LineageVersion: 3, InstallationID: "202", RepositoryID: "101", Repository: "trusted/repo", PullRequestNumber: 17},
		JobID:  "preview-resolve:lineage-1:3", WorkerID: "resolver-1", Attempt: 1, ClaimToken: "00000000-0000-4000-8000-000000000001", DeadlineAt: now.Add(5 * time.Minute),
	}}
	resolver, err := NewPreviewResolver(store, issuer, github, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}

	processed, err := resolver.ResolveNext(context.Background(), "resolver-1")
	if err != nil {
		t.Fatal(err)
	}
	if !processed || store.commits != 1 || store.failureCode != "" || pullCalls != 1 || revokeCalls != 1 || len(tokenPermissions) != 1 || tokenPermissions["pull_requests"] != "read" {
		t.Fatalf("resolver lifecycle mismatch: processed=%v commits=%d failure=%q pull=%d revoke=%d permissions=%v", processed, store.commits, store.failureCode, pullCalls, revokeCalls, tokenPermissions)
	}
	if store.observation == nil || store.observation.LineageVersion != 3 || store.observation.RepositoryID != "101" || store.observation.HeadRef != "feature/preview" {
		t.Fatalf("strict observation not committed: %+v", store.observation)
	}
}

func TestPostgresStoreGenericClaimSkipsReservedPreviewWorkflowJobs(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("RAIBITSERVER_TEST_POSTGRES_DSN"))
	if dsn == "" {
		t.Skip("reserved preview workflow qualification requires RAIBITSERVER_TEST_POSTGRES_DSN")
	}

	// Given queued resolver and cleanup jobs for an isolated preview lineage.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := sql.Open(postgresDriverName, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now().UTC().Truncate(time.Millisecond)
	fixture := insertPreviewPostgresFixture(t, ctx, db, now, 1)
	defer cleanupPreviewPostgresFixture(t, db, fixture)
	cleanupJobID := "preview-cleanup:" + fixture.lineageID
	if _, err := db.ExecContext(ctx, `INSERT INTO "WorkflowJob" (id,type,status,"targetType","targetId",payload,attempts,"maxAttempts","runAfter","updatedAt") VALUES ($1,'preview-cleanup','queued','preview-lineage',$2,'{}',0,3,$3,$3)`, cleanupJobID, fixture.lineageID, now); err != nil {
		t.Fatal(err)
	}

	// When the ordinary builder worker asks for its next job.
	claimed, err := NewPostgresStore(db).ClaimNextWorkflowJob(ctx, ClaimOptions{WorkerID: "builder-reserved-preview-check", Now: now})
	if err != nil {
		t.Fatal(err)
	}

	// Then no reserved preview job is claimed or mutated.
	if claimed != nil {
		t.Fatalf("generic builder claimed reserved preview workflow: %#v", claimed)
	}
	for _, jobID := range []string{fixture.jobID, cleanupJobID} {
		var status string
		var attempts int
		if err := db.QueryRowContext(ctx, `SELECT status,attempts FROM "WorkflowJob" WHERE id=$1`, jobID).Scan(&status, &attempts); err != nil {
			t.Fatal(err)
		}
		if status != WorkflowQueued || attempts != 0 {
			t.Fatalf("generic builder mutated reserved preview job %s: status=%q attempts=%d", jobID, status, attempts)
		}
	}
}
