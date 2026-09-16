package controlplane

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGitHubPullRequestClientObservesExactTrustedPullRequest(t *testing.T) {
	var path string
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		path = request.URL.EscapedPath()
		if request.Header.Get("Authorization") != "Bearer ghs_pr-read-fixture" {
			t.Fatal("missing PR credential")
		}
		_ = json.NewEncoder(response).Encode(map[string]any{
			"number": 17, "state": "open", "updated_at": "2026-09-04T08:00:00Z",
			"head": map[string]any{"sha": strings.Repeat("a", 40), "ref": "feature/preview"},
			"base": map[string]any{"ref": "main", "repo": map[string]any{"id": 101}},
		})
	}))
	defer server.Close()

	client, err := NewGitHubPullRequestClient(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	observedAt := time.Date(2026, 9, 4, 8, 0, 1, 0, time.UTC)
	observation, err := client.Observe(context.Background(), "ghs_pr-read-fixture", PreviewResolutionTarget{
		LineageID: "lineage-1", LineageVersion: 3, RepositoryID: "101", Repository: "trusted/repo", PullRequestNumber: 17,
	}, observedAt)
	if err != nil {
		t.Fatal(err)
	}
	if path != "/repos/trusted/repo/pulls/17" || observation.RepositoryID != "101" || observation.HeadSHA != strings.Repeat("a", 40) || observation.State != "open" || !observation.ObservedAt.Equal(observedAt) {
		t.Fatalf("unexpected trusted observation: path=%q observation=%+v", path, observation)
	}
}

func TestGitHubPullRequestClientRejectsMismatchedAndOversizedResponses(t *testing.T) {
	for _, testCase := range []struct {
		name string
		body func(http.ResponseWriter)
	}{
		{name: "foreign repository", body: func(response http.ResponseWriter) {
			_ = json.NewEncoder(response).Encode(map[string]any{"number": 17, "state": "open", "updated_at": "2026-09-04T08:00:00Z", "head": map[string]any{"sha": strings.Repeat("a", 40), "ref": "topic"}, "base": map[string]any{"ref": "main", "repo": map[string]any{"id": 999}}})
		}},
		{name: "oversized", body: func(response http.ResponseWriter) { _, _ = response.Write([]byte(strings.Repeat("x", (1<<20)+1))) }},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) { testCase.body(response) }))
			defer server.Close()
			client, err := NewGitHubPullRequestClient(server.URL, server.Client())
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.Observe(context.Background(), "secret-must-not-escape", PreviewResolutionTarget{LineageID: "lineage-1", LineageVersion: 3, RepositoryID: "101", Repository: "trusted/repo", PullRequestNumber: 17}, time.Now())
			if err == nil || strings.Contains(err.Error(), "secret-must-not-escape") {
				t.Fatalf("unsafe response accepted or secret escaped: %v", err)
			}
		})
	}
}
