//go:build windows

package reconciler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/raibitserver/orchestrator/internal/command"
	"github.com/raibitserver/orchestrator/internal/store"
)

func TestMain(m *testing.M) {
	if os.Getenv("RAIBITSERVER_KUBECTL_HELPER") == "1" {
		os.Exit(runKubectlWireHelper(os.Args[1:]))
	}
	os.Exit(m.Run())
}

func TestPreviewRoutePromotion_uses_authenticated_native_kubernetes_command(t *testing.T) {
	// Given
	const token = "local-kube-proof-token"
	var mutex sync.Mutex
	var route []byte
	requests := make([]string, 0, 3)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+token {
			http.Error(response, "unauthorized", http.StatusUnauthorized)
			return
		}
		mutex.Lock()
		defer mutex.Unlock()
		requests = append(requests, request.Method+" "+request.URL.Path)
		switch request.Method {
		case http.MethodGet:
			if len(route) == 0 {
				http.NotFound(response, request)
				return
			}
			_, _ = response.Write(route)
		case http.MethodPost:
			body, err := io.ReadAll(io.LimitReader(request.Body, 128*1024))
			if err != nil {
				http.Error(response, "read failed", http.StatusBadRequest)
				return
			}
			var object map[string]any
			if err := json.Unmarshal(body, &object); err != nil {
				http.Error(response, "invalid object", http.StatusBadRequest)
				return
			}
			if object["kind"] == "List" {
				items, ok := object["items"].([]any)
				if !ok || len(items) != 1 {
					http.Error(response, "invalid list", http.StatusBadRequest)
					return
				}
				object = items[0].(map[string]any)
			}
			metadata := object["metadata"].(map[string]any)
			annotations, ok := metadata["annotations"].(map[string]any)
			if !ok || len(annotations) != 3 || annotations["raibitserver.io/hostname"] != "preview--pr-1--org--demo.example.test" || annotations["nginx.ingress.kubernetes.io/custom-http-errors"] != "500,502,504" || annotations["traefik.ingress.kubernetes.io/router.middlewares"] != "platform-errors@kubernetescrd" {
				http.Error(response, "preview route annotations do not satisfy configured admission", http.StatusBadRequest)
				return
			}
			if object["spec"].(map[string]any)["ingressClassName"] != "traefik" {
				http.Error(response, "preview route ingress class does not satisfy configured admission", http.StatusBadRequest)
				return
			}
			metadata["uid"], metadata["resourceVersion"] = "wire-route-uid", "31"
			route, _ = json.Marshal(object)
			response.WriteHeader(http.StatusCreated)
			_, _ = response.Write(route)
		default:
			http.Error(response, "unsupported", http.StatusMethodNotAllowed)
		}
	}))
	defer server.Close()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	helper := filepath.Join(t.TempDir(), "kubectl.exe")
	binary, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(helper, binary, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", filepath.Dir(helper)+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("RAIBITSERVER_KUBECTL_HELPER", "1")
	t.Setenv("RAIBITSERVER_FAKE_KUBE_URL", server.URL)
	t.Setenv("RAIBITSERVER_FAKE_KUBE_TOKEN", token)
	runtime := map[string]any{"version": 1, "lineageId": "lineage-wire", "deploymentId": "candidate-wire", "generation": 1, "lineageVersion": 1, "stableHost": "preview--pr-1--org--demo.example.test", "probeHost": "preview--probe-0123456789abcdef0123456789abcdef.example.test", "namespace": "org-demo", "workloadName": "candidate-wire", "serviceName": "candidate-wire", "probeIngressName": "candidate-wire", "routeName": "preview-route"}
	path := writeState(t, map[string]any{
		"projects":        []any{map[string]any{"id": "project-wire", "organizationId": "org-wire", "slug": "demo", "status": "ACTIVE"}},
		"services":        []any{map[string]any{"id": "service-wire", "projectId": "project-wire", "slug": "web", "type": "web", "port": 8080, "status": "ACTIVE"}},
		"previewLineages": []any{map[string]any{"id": "lineage-wire", "organizationId": "org-wire", "projectId": "project-wire", "serviceId": "service-wire", "state": "OPEN", "version": 1, "namespace": "org-demo", "routeName": "preview-route", "stableHost": "preview--pr-1--org--demo.example.test", "candidateDeploymentId": "candidate-wire", "candidateGeneration": 1}},
		"deployments":     []any{map[string]any{"id": "candidate-wire", "projectId": "project-wire", "serviceId": "service-wire", "status": "READY", "publicHealthStatus": "HEALTHY", "deploymentType": "preview", "previewLineageId": "lineage-wire", "previewGeneration": 1, "previewRuntime": runtime}},
	})
	r := NewServiceReconcilerWithStore(Config{OutputDir: t.TempDir(), IngressClassName: "traefik", IngressCustomHTTPErrors: "504,500,502", IngressErrorMiddleware: "platform-errors@kubernetescrd"}, store.NewFileStore(path), command.OSRunner{})

	// When
	result, err := r.RunOnceResult(context.Background())

	// Then
	if err != nil || result.Reason != "preview_route_promote" {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	mutex.Lock()
	defer mutex.Unlock()
	joined := strings.Join(requests, "\n")
	if !strings.Contains(joined, "GET /apis/networking.k8s.io/v1/namespaces/org-demo/ingresses/preview-route") || !strings.Contains(joined, "POST /apis/networking.k8s.io/v1/namespaces/org-demo/ingresses") {
		t.Fatalf("authenticated Kubernetes wire calls missing: %s", joined)
	}
}

func runKubectlWireHelper(args []string) int {
	baseURL, token := os.Getenv("RAIBITSERVER_FAKE_KUBE_URL"), os.Getenv("RAIBITSERVER_FAKE_KUBE_TOKEN")
	if baseURL == "" || token == "" {
		return 2
	}
	method, path, body, err := kubectlWireRequest(args)
	if err != nil {
		_, _ = fmt.Fprint(os.Stderr, err)
		return 2
	}
	request, err := http.NewRequest(method, baseURL+path, bytes.NewReader(body))
	if err != nil {
		return 2
	}
	request.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return 1
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 128*1024))
	if err != nil {
		return 1
	}
	if response.StatusCode == http.StatusNotFound && containsArg(args, "--ignore-not-found=true") {
		return 0
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = os.Stderr.Write(responseBody)
		return 1
	}
	_, _ = os.Stdout.Write(responseBody)
	return 0
}

func kubectlWireRequest(args []string) (string, string, []byte, error) {
	if len(args) >= 2 && args[0] == "get" && strings.HasPrefix(args[1], "ingress/") {
		name := strings.TrimPrefix(args[1], "ingress/")
		namespace := argAfter(args, "--namespace")
		return http.MethodGet, "/apis/networking.k8s.io/v1/namespaces/" + namespace + "/ingresses/" + name, nil, nil
	}
	if len(args) >= 3 && args[0] == "create" && args[1] == "-f" {
		body, err := os.ReadFile(args[2])
		return http.MethodPost, "/apis/networking.k8s.io/v1/namespaces/org-demo/ingresses", body, err
	}
	return "", "", nil, fmt.Errorf("unsupported kubectl args: %v", args)
}

func argAfter(args []string, key string) string {
	for index := range len(args) - 1 {
		if args[index] == key {
			return args[index+1]
		}
	}
	return ""
}

func containsArg(args []string, expected string) bool {
	for _, arg := range args {
		if arg == expected {
			return true
		}
	}
	return false
}
