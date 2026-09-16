package command

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRecoveryUIDDeletesUseBackgroundPropagationAndAcceptAsyncResponse(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte("service-account-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	propagations := make([]string, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var options deleteOptions
		if err := json.NewDecoder(request.Body).Decode(&options); err != nil {
			t.Errorf("decode DeleteOptions: %v", err)
		}
		propagations = append(propagations, options.PropagationPolicy)
		response.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	runner := OSRunner{KubernetesAPIURL: server.URL, ServiceAccountTokenFile: tokenPath, HTTPClient: server.Client()}
	for _, resource := range []string{"networkpolicy", "job"} {
		if _, err := runner.DeleteObjectUID(context.Background(), resource, "tenant-one", "recovery-object", "object-uid", time.Minute); err != nil {
			t.Fatal(err)
		}
	}
	if len(propagations) != 2 || propagations[0] != "Background" || propagations[1] != "Background" {
		t.Fatalf("recovery delete propagation=%v", propagations)
	}
}
