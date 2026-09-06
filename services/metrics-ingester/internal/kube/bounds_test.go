package kube

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/metrics-ingester/internal/ingester"
)

func TestHTTPBoundsAndRunByteBudget(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		budget     int
		code       string
	}{
		{"object", strings.Repeat(" ", 1024*1024+1), 16 * 1024 * 1024, "byte_limit"},
		{"run", `{"items":[]}`, 10, "byte_limit"},
		{"trailing", `{"items":[]} garbage`, 1000, "http_decode"},
		{"token", `{"metadata":{"continue":"` + strings.Repeat("x", 4097) + `"},"items":[]}`, 10000, "field_limit"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Given: a bounded HTTP fixture breaks one envelope limit.
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if _, err := w.Write([]byte(tc.body)); err != nil {
					t.Error(err)
				}
			}))
			defer server.Close()
			c := &Client{baseURL: server.URL, staticToken: "test", http: server.Client()}
			// When: reading through the authenticated client and shared run budget.
			_, _, err := c.ListPodMetrics(ingester.WithByteBudget(t.Context(), tc.budget), "", 1)
			// Then: bounded typed failure, never the source bytes.
			if ingester.FailureCode(err) != tc.code {
				t.Fatalf("wrong bound outcome %v", err)
			}
		})
	}
}

func TestDiscoveryUsesCallerDeadline(t *testing.T) {
	// Given: discovery blocks until cancellation; it must share the run deadline.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	c := &Client{baseURL: server.URL, staticToken: "test", http: server.Client()}
	ctx, cancel := context.WithTimeout(t.Context(), 25*time.Millisecond)
	defer cancel()
	// When: calling the real HTTP adapter with a run-scoped deadline.
	_, _, err := c.ListPodMetrics(ctx, "", 1)
	// Then: the context, not the longer HTTP timeout, terminates discovery.
	if ingester.FailureCode(err) != "deadline" {
		t.Fatalf("discovery ignored deadline: %v", err)
	}
}
