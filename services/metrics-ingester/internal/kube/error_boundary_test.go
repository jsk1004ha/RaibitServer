package kube

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestKubernetesFailureNeverEchoesBody(t *testing.T) {
	// Given: authenticated upstream returns a credential-bearing failure.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer synthetic-token" {
			t.Error("missing authentication")
		}
		w.WriteHeader(403)
		_, err := w.Write([]byte("password=FORBIDDEN_METRIC_SENTINEL"))
		if err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	c := &Client{baseURL: server.URL, staticToken: "synthetic-token", http: server.Client()}
	// When: fetching real HTTP response.
	_, _, err := c.ListPodMetrics(context.Background(), "", 1)
	// Then: only a bounded failure code crosses the boundary.
	if err == nil || strings.Contains(err.Error(), "FORBIDDEN_METRIC_SENTINEL") || len(err.Error()) > 160 {
		t.Fatalf("unsafe error boundary: %v", err)
	}
}
