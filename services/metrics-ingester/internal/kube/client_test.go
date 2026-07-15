package kube

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestClientReloadsProjectedServiceAccountToken(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte("first-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		want := "Bearer first-token"
		if requests == 2 {
			want = "Bearer second-token"
		}
		if got := request.Header.Get("Authorization"); got != want {
			t.Errorf("request %d authorization=%q want %q", requests, got, want)
		}
		response.Header().Set("Content-Type", "application/json")
		fmt.Fprint(response, `{"metadata":{},"items":[]}`)
	}))
	defer server.Close()
	t.Setenv("RAIBITSERVER_KUBERNETES_API", server.URL)
	t.Setenv("RAIBITSERVER_KUBERNETES_TOKEN", "")
	t.Setenv("RAIBITSERVER_KUBERNETES_TOKEN_FILE", tokenPath)
	client, err := NewFromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := client.ListPodMetrics(context.Background(), "", 1); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenPath, []byte("second-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := client.ListPodMetrics(context.Background(), "", 1); err != nil {
		t.Fatal(err)
	}
}
