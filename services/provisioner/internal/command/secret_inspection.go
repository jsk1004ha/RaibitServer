package command

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type SecretSnapshot struct {
	Metadata SecretMetadata
	Data     map[string]string
}

type secretInspection struct {
	namespace, name, accept string
	patch                   []byte
	maxBytes                int64
}

// InspectSecretJSON observes credentials through admission-checked no-op PATCH.
// kubectl patch is unsuitable: it may first issue an unauthorized Secret GET.
func (r *OSRunner) InspectSecretJSON(ctx context.Context, namespace, name string, timeout time.Duration) ([]byte, error) {
	_, payload, err := r.inspectSecret(ctx, secretInspection{namespace: namespace, name: name,
		accept: "application/json", patch: []byte("[]"), maxBytes: 1 << 20}, timeout)
	return payload, err
}

// VerifySecretSnapshot atomically checks the retained source against a colliding
// snapshot. It returns only metadata; neither credentials nor tests enter argv.
func (r *OSRunner) VerifySecretSnapshot(ctx context.Context, expected SecretSnapshot, timeout time.Duration) (string, error) {
	patch, err := json.Marshal([]struct {
		Op    string `json:"op"`
		Path  string `json:"path"`
		Value any    `json:"value"`
	}{
		{"test", "/type", "Opaque"}, {"test", "/immutable", true},
		{"test", "/data", expected.Data},
		{"test", "/metadata/labels", expected.Metadata.Labels},
		{"test", "/metadata/annotations", expected.Metadata.Annotations},
	})
	if err != nil {
		return "", fmt.Errorf("encode snapshot preconditions: %w", err)
	}
	_, metadata, err := r.patchSecretMetadata(ctx, expected.Metadata.Namespace, expected.Metadata.Name, patch, timeout)
	if err != nil {
		return "", err
	}
	return metadata.UID, nil
}

func (r *OSRunner) inspectSecret(ctx context.Context, inspection secretInspection, timeout time.Duration) (string, []byte, error) {
	commandLine := "kubernetes-api patch metadata secret/" + inspection.name + " --namespace " + inspection.namespace + " --dry-run=server"
	apiPath, err := namespacedResourceAPIPath("secret", strings.TrimSpace(inspection.namespace), strings.TrimSpace(inspection.name))
	if err != nil {
		return commandLine, nil, err
	}
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	requestContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	apiURL, err := r.kubernetesAPIURL()
	if err != nil {
		return commandLine, nil, err
	}
	token, err := r.serviceAccountToken()
	if err != nil {
		return commandLine, nil, err
	}
	endpoint, err := url.Parse(strings.TrimRight(apiURL, "/") + apiPath)
	if err != nil {
		return commandLine, nil, fmt.Errorf("create Kubernetes Secret inspection endpoint: %w", err)
	}
	query := endpoint.Query()
	query.Set("dryRun", "All")
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(requestContext, http.MethodPatch, endpoint.String(), bytes.NewReader(inspection.patch))
	if err != nil {
		return commandLine, nil, fmt.Errorf("create Kubernetes Secret inspection request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", inspection.accept)
	request.Header.Set("Content-Type", "application/json-patch+json")
	client, err := r.kubernetesHTTPClient()
	if err != nil {
		return commandLine, nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return commandLine, nil, fmt.Errorf("execute Kubernetes Secret inspection request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return commandLine, nil, ErrSecretNotFound
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return commandLine, nil, &KubernetesAPIError{StatusCode: response.StatusCode}
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, inspection.maxBytes+1))
	if err != nil || int64(len(payload)) > inspection.maxBytes {
		return commandLine, nil, errors.New("Kubernetes API returned an invalid-sized Secret inspection representation")
	}
	return commandLine, payload, nil
}
