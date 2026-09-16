package command

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestInspectSecretJSONReadsThroughBoundedNoOpPatch(t *testing.T) {
	// Given: an API that rejects GET and may echo credentials on failure.
	for _, scenario := range []struct {
		name   string
		status int
		body   string
		ok     bool
	}{
		{"source", 200, `{"metadata":{"name":"db-connection"},"data":{"DATABASE_URL":"c2VjcmV0"}}`, true},
		{"forbidden", 403, "server echoed c2VjcmV0", false},
		{"missing", 404, "server echoed c2VjcmV0", false},
		{"oversized", 200, strings.Repeat("x", (1<<20)+1), false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			token := filepath.Join(t.TempDir(), "token")
			if err := os.WriteFile(token, []byte("test-token"), 0o600); err != nil {
				t.Fatal(err)
			}
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				patch, err := io.ReadAll(r.Body)
				if err != nil || r.Method != http.MethodPatch || r.URL.Path != "/api/v1/namespaces/tenant-a/secrets/db-connection" ||
					r.URL.Query().Get("dryRun") != "All" || string(patch) != "[]" || r.Header.Get("Accept") != "application/json" ||
					r.Header.Get("Content-Type") != "application/json-patch+json" || r.Header.Get("Authorization") != "Bearer test-token" {
					t.Error("source inspection must be a direct authenticated no-op dry-run JSON Patch")
				}
				w.WriteHeader(scenario.status)
				if _, err := io.WriteString(w, scenario.body); err != nil {
					t.Error(err)
				}
			}))
			defer server.Close()
			runner := OSRunner{KubernetesAPIURL: server.URL, ServiceAccountTokenFile: token, HTTPClient: server.Client()}
			// When: recovery inspects its source without any GET permission.
			payload, err := runner.InspectSecretJSON(context.Background(), "tenant-a", "db-connection", time.Minute)
			// Then: only a successful bounded response exposes data to the caller.
			if calls != 1 || (scenario.ok && (err != nil || string(payload) != scenario.body)) || (!scenario.ok && (err == nil || payload != nil)) {
				t.Fatalf("calls=%d bytes=%d err=%v", calls, len(payload), err)
			}
			if err != nil && strings.Contains(err.Error(), "c2VjcmV0") {
				t.Fatal("source data leaked through an API error")
			}
		})
	}
}

func TestVerifySecretSnapshotUsesOnlyAtomicDryRunTests(t *testing.T) {
	// Given: the source data and provenance retained from the authorized source read.
	expected := SecretSnapshot{Metadata: SecretMetadata{
		Name: "recovery-credential-aaaaaaaaaaaaaaaaaaaaaaaa", Namespace: "tenant-a",
		Labels:      map[string]string{"raibitserver.io/owned-by": "recovery"},
		Annotations: map[string]string{"raibitserver.io/source-secret-uid": "source-uid", "raibitserver.io/source-secret-resource-version": "19"},
	}, Data: map[string]string{"DATABASE_URL": "c2VjcmV0"}}
	for _, status := range []int{http.StatusOK, http.StatusForbidden, http.StatusNotFound, http.StatusUnprocessableEntity} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			token := filepath.Join(t.TempDir(), "token")
			if err := os.WriteFile(token, []byte("test-token"), 0o600); err != nil {
				t.Fatal(err)
			}
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != http.MethodPatch || r.URL.Path != "/api/v1/namespaces/tenant-a/secrets/"+expected.Metadata.Name || r.URL.Query().Get("dryRun") != "All" {
					t.Errorf("unexpected request %s %s", r.Method, r.URL)
				}
				if r.Header.Get("Accept") != "application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1" || r.Header.Get("Content-Type") != "application/json-patch+json" {
					t.Error("snapshot inspection must negotiate metadata and send JSON Patch")
				}
				var patches []struct {
					Op, Path string
					Value    json.RawMessage
				}
				if err := json.NewDecoder(r.Body).Decode(&patches); err != nil {
					t.Fatal(err)
				}
				want := map[string]any{"/type": "Opaque", "/immutable": true, "/data": expected.Data,
					"/metadata/labels": expected.Metadata.Labels, "/metadata/annotations": expected.Metadata.Annotations}
				if len(patches) != len(want) {
					t.Errorf("expected %d atomic preconditions, got %d", len(want), len(patches))
				}
				for _, patch := range patches {
					value, ok := want[patch.Path]
					encoded, err := json.Marshal(value)
					if err != nil || !ok || patch.Op != "test" || !reflect.DeepEqual(encoded, []byte(patch.Value)) {
						t.Errorf("unexpected snapshot patch at %s (values withheld)", patch.Path)
					}
					delete(want, patch.Path)
				}
				w.WriteHeader(status)
				if status == http.StatusOK {
					if err := json.NewEncoder(w).Encode(map[string]any{"apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadata", "metadata": map[string]string{"uid": "snapshot-uid", "name": expected.Metadata.Name, "namespace": expected.Metadata.Namespace}}); err != nil {
						t.Error(err)
					}
				} else {
					if _, err := fmt.Fprint(w, "server echoed c2VjcmV0"); err != nil {
						t.Error(err)
					}
				}
			}))
			defer server.Close()
			runner := OSRunner{KubernetesAPIURL: server.URL, ServiceAccountTokenFile: token, HTTPClient: server.Client()}
			// When: a colliding snapshot is verified without Secret GET permission.
			uid, err := runner.VerifySecretSnapshot(context.Background(), expected, time.Minute)
			// Then: one PATCH yields an identity only if every atomic test passed.
			if calls != 1 || (status == http.StatusOK && (err != nil || uid != "snapshot-uid")) || (status != http.StatusOK && (err == nil || uid != "")) {
				t.Fatalf("calls=%d uid=%q err=%v", calls, uid, err)
			}
			if err != nil && strings.Contains(err.Error(), "c2VjcmV0") {
				t.Fatal("snapshot data leaked through an API error")
			}
		})
	}
}
