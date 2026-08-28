package controlplane

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGitHubAppCredentialIssuerRestrictsTokenToExactNumericRepository(t *testing.T) {
	now := time.Date(2026, 8, 28, 8, 0, 0, 0, time.UTC)
	var requestedPath string
	var repositoryIDs []int64
	var permissions map[string]string
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requestedPath = request.URL.Path
		if !strings.HasPrefix(request.Header.Get("Authorization"), "Bearer ey") {
			t.Fatalf("missing GitHub App JWT authorization")
		}
		var payload struct {
			RepositoryIDs []int64           `json:"repository_ids"`
			Permissions   map[string]string `json:"permissions"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		repositoryIDs = payload.RepositoryIDs
		permissions = payload.Permissions
		response.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(response).Encode(map[string]any{
			"token":        "ghs_short-lived-secret",
			"expires_at":   now.Add(time.Hour).Format(time.RFC3339),
			"repositories": []map[string]any{{"id": 101}},
		})
	}))
	defer server.Close()

	issuer := newTestGitHubAppIssuer(t, server, now)
	credential, err := issuer.IssueRepositoryCredential(context.Background(), "202", "101")
	if err != nil {
		t.Fatal(err)
	}
	if requestedPath != "/app/installations/202/access_tokens" || len(repositoryIDs) != 1 || repositoryIDs[0] != 101 {
		t.Fatalf("token request was not exact-repository scoped: path=%q repositories=%v", requestedPath, repositoryIDs)
	}
	if permissions["contents"] != "read" || len(permissions) != 1 {
		t.Fatalf("token request permissions were not read-only: %v", permissions)
	}
	if credential.Token != "ghs_short-lived-secret" || credential.InstallationID != "202" || credential.RepositoryID != "101" || !credential.ExpiresAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("unexpected credential: %+v", credential)
	}
}

func TestGitHubAppCredentialIssuerRejectsForeignRepositoryAndUnsafeExpiry(t *testing.T) {
	now := time.Date(2026, 8, 28, 8, 0, 0, 0, time.UTC)
	for _, testCase := range []struct {
		name         string
		repositoryID int64
		expiresAt    time.Time
		want         string
	}{
		{name: "foreign repository", repositoryID: 999, expiresAt: now.Add(time.Hour), want: "exact-repository scope"},
		{name: "expired too soon", repositoryID: 101, expiresAt: now.Add(30 * time.Second), want: "short-lived window"},
		{name: "expires too late", repositoryID: 101, expiresAt: now.Add(2 * time.Hour), want: "short-lived window"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.WriteHeader(http.StatusCreated)
				_ = json.NewEncoder(response).Encode(map[string]any{
					"token":        "ghs_must-not-escape",
					"expires_at":   testCase.expiresAt.Format(time.RFC3339),
					"repositories": []map[string]any{{"id": testCase.repositoryID}},
				})
			}))
			defer server.Close()
			_, err := newTestGitHubAppIssuer(t, server, now).IssueRepositoryCredential(context.Background(), "202", "101")
			if err == nil || !strings.Contains(err.Error(), testCase.want) || strings.Contains(err.Error(), "ghs_must-not-escape") {
				t.Fatalf("expected safe rejection containing %q, got %v", testCase.want, err)
			}
		})
	}
}

func newTestGitHubAppIssuer(t *testing.T, server *httptest.Server, now time.Time) GitHubCredentialIssuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	keyFile := filepath.Join(t.TempDir(), "github-app.pem")
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}), 0o600); err != nil {
		t.Fatal(err)
	}
	issuer, err := NewGitHubAppCredentialIssuer(GitHubAppCredentialIssuerConfig{
		AppID: "303", PrivateKeyFile: keyFile, APIURL: server.URL, HTTPClient: server.Client(), Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	return issuer
}
