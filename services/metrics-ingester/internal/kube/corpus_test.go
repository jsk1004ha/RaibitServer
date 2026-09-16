package kube

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/raibitserver/metrics-ingester/internal/ingester"
)

func TestSharedSecretCorpusCannotEscapeHTTPFailure(t *testing.T) {
	// Given: exact shared synthetic redaction corpus, consumed read-only.
	path := os.Getenv("RAIBITSERVER_REDACTION_FIXTURE")
	if path == "" {
		path = filepath.Join("..", "..", "..", "..", "tests", "fixtures", "observability-redaction-v1.json")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct{ Name, Input string }
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(503)
				if _, err := w.Write([]byte(tc.Input)); err != nil {
					t.Error(err)
				}
			}))
			defer server.Close()
			client := &Client{baseURL: server.URL, staticToken: "synthetic", http: server.Client()}
			// When: an upstream failure embeds the credential pattern.
			_, _, err := client.ListPodMetrics(t.Context(), "", 1)
			// Then: the same fixed typed code is the entire observable error.
			if ingester.FailureCode(err) != "http_status" || err.Error() != "metrics_ingestion_http_status" {
				t.Fatal("source bytes escaped the error boundary")
			}
		})
	}
}
