//go:build integration

package store

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/raibitserver/metrics-ingester/internal/identity"
	"github.com/raibitserver/metrics-ingester/internal/ingester"
)

type (
	wireOwner struct {
		APIVersion string `json:"apiVersion"`
		Kind       string `json:"kind"`
		Name       string `json:"name"`
		UID        string `json:"uid"`
		Controller bool   `json:"controller"`
	}
	wireMeta struct {
		Name      string            `json:"name"`
		Namespace string            `json:"namespace,omitempty"`
		UID       string            `json:"uid"`
		Creation  time.Time         `json:"creationTimestamp"`
		Deletion  *time.Time        `json:"deletionTimestamp,omitempty"`
		Labels    map[string]string `json:"labels"`
		Owners    []wireOwner       `json:"ownerReferences,omitempty"`
	}
	wireContainer struct {
		Name    string                      `json:"name"`
		Image   string                      `json:"image"`
		Command []string                    `json:"command,omitempty"`
		Args    []string                    `json:"args,omitempty"`
		Env     []identity.EnvironmentEntry `json:"env,omitempty"`
	}
	wireTemplate struct {
		Metadata wireMeta `json:"metadata"`
		Spec     wireSpec `json:"spec"`
	}
	wireSpec struct {
		Containers  []wireContainer  `json:"containers,omitempty"`
		Template    *wireTemplate    `json:"template,omitempty"`
		JobTemplate *wireJobTemplate `json:"jobTemplate,omitempty"`
	}
	wireJobTemplate struct {
		Spec wireSpec `json:"spec"`
	}
	wireObject struct {
		APIVersion string   `json:"apiVersion"`
		Kind       string   `json:"kind"`
		Metadata   wireMeta `json:"metadata"`
		Spec       wireSpec `json:"spec"`
	}
	wireMetrics struct {
		Metadata   wireMeta    `json:"metadata"`
		Timestamp  string      `json:"timestamp"`
		Containers []wireUsage `json:"containers"`
	}
	wireUsage struct {
		Name  string            `json:"name"`
		Usage map[string]string `json:"usage"`
	}
	httpFixture struct {
		Namespace, Pod, Middle, Workload wireObject
		Sample                           wireMetrics
		BeforeServe                      func() `json:"-"`
		mu                               sync.Mutex
		paths                            []string
	}
)

func newHTTPFixture(r ingester.Record) *httpFixture {
	labels := map[string]string{"app.kubernetes.io/managed-by": "raibitserver", "raibitserver.io/project-id": r.Scope.ProjectID, "raibitserver.io/service-id": r.ServiceID, "raibitserver.io/deployment-id": r.DeploymentID}
	meta := wireMeta{Name: r.PodName, Namespace: r.Namespace, UID: r.PodUID, Creation: r.Timestamp.Add(-time.Minute), Labels: labels}
	shape := wireSpec{Containers: []wireContainer{{Name: r.ContainerName, Image: r.Scope.Image, Env: []identity.EnvironmentEntry{
		{Name: "RAIBITSERVER_DEPLOYMENT_ID", Value: r.DeploymentID}, {Name: "RAIBITSERVER_SERVICE_ID", Value: r.ServiceID}, {Name: "RAIBITSERVER_PROJECT_ID", Value: r.Scope.ProjectID}, {Name: "RAIBITSERVER_DEPLOYMENT_TYPE", Value: "PRODUCTION"},
	}}}}
	f := &httpFixture{Namespace: wireObject{APIVersion: "v1", Kind: "Namespace", Metadata: wireMeta{Name: r.Namespace, UID: "namespace-uid", Labels: labels}}, Pod: wireObject{APIVersion: "v1", Kind: "Pod", Metadata: meta, Spec: shape}}
	f.Middle = wireObject{APIVersion: "apps/v1", Kind: "ReplicaSet", Metadata: wireMeta{Name: "web-rs", Namespace: r.Namespace, UID: "rs-uid", Labels: nil}, Spec: wireSpec{Template: &wireTemplate{Metadata: meta, Spec: shape}}}
	f.Workload = wireObject{APIVersion: "apps/v1", Kind: "Deployment", Metadata: wireMeta{Name: r.Scope.WorkloadName, Namespace: r.Namespace, UID: "workload-uid", Labels: labels}, Spec: wireSpec{Template: &wireTemplate{Metadata: meta, Spec: shape}}}
	f.Middle.Metadata.Owners = []wireOwner{{"apps/v1", "Deployment", f.Workload.Metadata.Name, f.Workload.Metadata.UID, true}}
	f.Pod.Metadata.Owners = []wireOwner{{"apps/v1", "ReplicaSet", f.Middle.Metadata.Name, f.Middle.Metadata.UID, true}}
	f.Sample = wireMetrics{Metadata: meta, Timestamp: r.Timestamp.Format(time.RFC3339Nano), Containers: []wireUsage{{Name: r.ContainerName, Usage: map[string]string{"cpu": "250m", "memory": "64Mi"}}}}
	f.Sample.Metadata.UID = ""
	return f
}

func (f *httpFixture) server(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer synthetic-local-token" {
			t.Error("unauthenticated Kubernetes request")
			w.WriteHeader(401)
			return
		}
		f.mu.Lock()
		f.paths = append(f.paths, r.URL.Path)
		f.mu.Unlock()
		if f.BeforeServe != nil {
			f.BeforeServe()
		}
		var body any
		switch r.URL.Path {
		case "/apis/metrics.k8s.io/v1beta1/pods":
			body = struct {
				Items []wireMetrics `json:"items"`
			}{[]wireMetrics{f.Sample}}
		case "/api/v1/namespaces/" + f.Namespace.Metadata.Name:
			body = f.Namespace
		case "/api/v1/namespaces/" + f.Pod.Metadata.Namespace + "/pods/" + f.Pod.Metadata.Name:
			body = f.Pod
		case "/apis/apps/v1/namespaces/" + f.Middle.Metadata.Namespace + "/replicasets/" + f.Middle.Metadata.Name:
			body = f.Middle
		case "/apis/apps/v1/namespaces/" + f.Workload.Metadata.Namespace + "/deployments/" + f.Workload.Metadata.Name:
			body = f.Workload
		case "/apis/batch/v1/namespaces/" + f.Middle.Metadata.Namespace + "/jobs/" + f.Middle.Metadata.Name:
			body = f.Middle
		case "/apis/batch/v1/namespaces/" + f.Workload.Metadata.Namespace + "/jobs/" + f.Workload.Metadata.Name:
			body = f.Workload
		case "/apis/batch/v1/namespaces/" + f.Workload.Metadata.Namespace + "/cronjobs/" + f.Workload.Metadata.Name:
			body = f.Workload
		default:
			w.WriteHeader(404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(body); err != nil {
			t.Error(err)
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv("RAIBITSERVER_KUBERNETES_API", server.URL)
	t.Setenv("RAIBITSERVER_KUBERNETES_TOKEN", "synthetic-local-token")
	return server
}

func (f *httpFixture) capture(t *testing.T) {
	t.Helper()
	dir := os.Getenv("RAIBITSERVER_EVIDENCE_DIR")
	if dir == "" {
		t.Fatal("evidence directory required")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	body, err := json.MarshalIndent(struct {
		Fixture *httpFixture
		Paths   []string
	}{f, f.paths}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, filepath.Base(t.Name())+"-http.json")
	if err = os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
}
