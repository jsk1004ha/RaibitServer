package kube

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIngestionAdversarialHTTPBodyNeverEscapes(t *testing.T) {
	// Given: an authenticated upstream returns unstructured credential bytes.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture" {
			t.Error("missing authentication")
		}
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, "SYNTHETIC_KUBE_BODY_SECRET")
	}))
	defer server.Close()
	client := &Client{baseURL: server.URL, staticToken: "fixture", http: server.Client()}
	// When: discovery fails at the real HTTP boundary.
	_, _, err := client.ListPods(context.Background(), "", 1)
	// Then: the returned error contains only the bounded status, never body bytes.
	if err == nil || strings.Contains(err.Error(), "SYNTHETIC_KUBE_BODY_SECRET") {
		t.Fatal("Kubernetes error body escaped")
	}
}
