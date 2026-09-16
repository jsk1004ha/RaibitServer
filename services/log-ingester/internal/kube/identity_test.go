package kube

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/raibitserver/log-ingester/internal/identity"
	"github.com/raibitserver/log-ingester/internal/ingester"
)

func identityFixture(kind string) (identity.Scope, map[string]object) {
	scope := identity.Scope{OrganizationID: "org", ProjectID: "project", ServiceID: "service", DeploymentID: "dep", Namespace: "org--project", Name: "web", Container: "web", Kind: kind, Image: "registry.test/app:tag"}
	env := []identity.EnvironmentEntry{{Name: "MODE", Value: "live"}, {Name: "TOKEN", ValueFrom: &identity.EnvironmentSource{SecretKeyRef: identity.SecretReference{Name: "runtime-secret", Key: "TOKEN"}}}}
	scope.EnvironmentHash, _ = identity.EnvironmentHash(env)
	labels := map[string]string{"app.kubernetes.io/managed-by": "raibitserver", "raibitserver.io/project-id": "project", "raibitserver.io/service-id": "service", "raibitserver.io/deployment-id": "dep"}
	ns := object{Kind: "Namespace", APIVersion: "v1", Metadata: metadata{Name: scope.Namespace, UID: "namespace", Labels: labels}}
	pod := object{Kind: "Pod", APIVersion: "v1", Metadata: metadata{Name: "pod", Namespace: scope.Namespace, UID: "pod-uid", Created: time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC), Labels: labels}}
	pod.Spec.Containers = []container{{Name: scope.Container, Image: scope.Image, Env: env}}
	root := object{Kind: kind, APIVersion: "apps/v1", Metadata: metadata{Name: "web", Namespace: scope.Namespace, UID: "root-uid", Labels: labels}}
	root.Spec.Template.Metadata.Labels = labels
	root.Spec.Template.Spec.Containers = pod.Spec.Containers
	objects := map[string]object{"/api/v1/namespaces/" + scope.Namespace: ns}
	prefix := "/namespaces/" + scope.Namespace
	switch kind {
	case "Deployment":
		child := object{Kind: "ReplicaSet", APIVersion: "apps/v1", Metadata: metadata{Name: "rs", Namespace: scope.Namespace, UID: "rs-uid", Owners: []owner{{APIVersion: "apps/v1", Kind: "Deployment", Name: "web", UID: "root-uid", Controller: true}}}}
		child.Spec.Template = root.Spec.Template
		pod.Metadata.Owners = []owner{{APIVersion: "apps/v1", Kind: "ReplicaSet", Name: "rs", UID: "rs-uid", Controller: true}}
		objects["/apis/apps/v1"+prefix+"/replicasets/rs"] = child
		objects["/apis/apps/v1"+prefix+"/deployments/web"] = root
	case "Job":
		root.APIVersion = "batch/v1"
		pod.Metadata.Owners = []owner{{APIVersion: "batch/v1", Kind: "Job", Name: "web", UID: "root-uid", Controller: true}}
		objects["/apis/batch/v1"+prefix+"/jobs/web"] = root
	case "CronJob":
		root.APIVersion = "batch/v1"
		root.Spec.JobTemplate.Spec.Template = root.Spec.Template
		child := object{Kind: "Job", APIVersion: "batch/v1", Metadata: metadata{Name: "job", Namespace: scope.Namespace, UID: "job-uid", Owners: []owner{{APIVersion: "batch/v1", Kind: "CronJob", Name: "web", UID: "root-uid", Controller: true}}}}
		child.Spec.Template = root.Spec.Template
		pod.Metadata.Owners = []owner{{APIVersion: "batch/v1", Kind: "Job", Name: "job", UID: "job-uid", Controller: true}}
		objects["/apis/batch/v1"+prefix+"/jobs/job"] = child
		objects["/apis/batch/v1"+prefix+"/cronjobs/web"] = root
	}
	objects["/api/v1"+prefix+"/pods/pod"] = pod
	return scope, objects
}

func TestIngestionAdversarialAuthenticatedOwnerChains(t *testing.T) {
	tests := []struct {
		name, kind string
		change     func(map[string]object)
		pass       bool
	}{
		{"deployment", "Deployment", nil, true},
		{"job", "Job", nil, true},
		{"cron", "CronJob", nil, true},
		{"stale_pod_uid", "Deployment", func(m map[string]object) {
			p := m["/api/v1/namespaces/org--project/pods/pod"]
			p.Metadata.UID = "replacement"
			m["/api/v1/namespaces/org--project/pods/pod"] = p
		}, false},
		{"stale_template", "Deployment", func(m map[string]object) {
			p := m["/apis/apps/v1/namespaces/org--project/deployments/web"]
			p.Spec.Template.Spec.Containers = []container{{Name: "web", Image: "foreign"}}
			m["/apis/apps/v1/namespaces/org--project/deployments/web"] = p
		}, false},
		{"foreign_namespace", "Deployment", func(m map[string]object) {
			p := m["/api/v1/namespaces/org--project"]
			p.Metadata.Labels = map[string]string{"raibitserver.io/project-id": "foreign"}
			m["/api/v1/namespaces/org--project"] = p
		}, false},
		{"deleted_namespace", "Deployment", func(m map[string]object) {
			p := m["/api/v1/namespaces/org--project"]
			at := time.Unix(1, 0)
			p.Metadata.Deleted = &at
			m["/api/v1/namespaces/org--project"] = p
		}, false},
		{"controller_uid", "Deployment", func(m map[string]object) {
			p := m["/apis/apps/v1/namespaces/org--project/replicasets/rs"]
			p.Metadata.UID = "foreign"
			m["/apis/apps/v1/namespaces/org--project/replicasets/rs"] = p
		}, false},
		{"controller_flag", "Deployment", func(m map[string]object) {
			p := m["/api/v1/namespaces/org--project/pods/pod"]
			p.Metadata.Owners[0].Controller = false
			m["/api/v1/namespaces/org--project/pods/pod"] = p
		}, false},
		{"command_injected", "Job", func(m map[string]object) {
			p := m["/api/v1/namespaces/org--project/pods/pod"]
			p.Spec.Containers = []container{{Name: "web", Image: "registry.test/app:tag", Command: []string{"foreign"}}}
			m["/api/v1/namespaces/org--project/pods/pod"] = p
		}, false},
		{"env_tampered", "Deployment", func(m map[string]object) {
			p := m["/api/v1/namespaces/org--project/pods/pod"]
			p.Spec.Containers[0].Env = []identity.EnvironmentEntry{{Name: "MODE", Value: "foreign"}}
			m["/api/v1/namespaces/org--project/pods/pod"] = p
		}, false},
		{"secret_ref_tampered", "CronJob", func(m map[string]object) {
			p := m["/apis/batch/v1/namespaces/org--project/cronjobs/web"]
			p.Spec.JobTemplate.Spec.Template.Spec.Containers[0].Env = []identity.EnvironmentEntry{{Name: "MODE", Value: "live"}, {Name: "TOKEN", ValueFrom: &identity.EnvironmentSource{SecretKeyRef: identity.SecretReference{Name: "foreign-secret", Key: "TOKEN"}}}}
			m["/apis/batch/v1/namespaces/org--project/cronjobs/web"] = p
		}, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Given: an authenticated current namespace/Pod/controller graph.
			scope, objects := identityFixture(test.kind)
			// Every HTTP object owns its decoded arrays; mutating a root template must not mutate the Pod.
			encoded, copyErr := json.Marshal(objects)
			if copyErr != nil {
				t.Fatal(copyErr)
			}
			objects = nil
			if err := json.Unmarshal(encoded, &objects); err != nil {
				t.Fatal(err)
			}
			if test.change != nil {
				test.change(objects)
			}
			var mu sync.Mutex
			requests := []string{}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer fixture" {
					t.Error("missing authentication")
					w.WriteHeader(401)
					return
				}
				mu.Lock()
				requests = append(requests, r.URL.Path)
				mu.Unlock()
				obj, ok := objects[r.URL.Path]
				if !ok {
					w.WriteHeader(404)
					return
				}
				if err := json.NewEncoder(w).Encode(obj); err != nil {
					t.Error(err)
				}
			}))
			defer server.Close()
			client := &Client{baseURL: server.URL, staticToken: "fixture", http: server.Client()}
			// When: actual HTTP identity verification follows the owner chain.
			created, err := client.Verify(context.Background(), ingester.Pod{Namespace: scope.Namespace, Name: "pod", UID: "pod-uid"}, scope)
			// Then: no readiness field is required; every forged chain is denied.
			if (err == nil) != test.pass || (test.pass && created.IsZero()) || (!test.pass && !errors.Is(err, identity.ErrIdentity)) {
				t.Fatalf("chain admission mismatch: %v", err)
			}
			mu.Lock()
			defer mu.Unlock()
			t.Logf("authenticated_requests=%d accepted=%t", len(requests), err == nil)
			if root := os.Getenv("RAIBITSERVER_EVIDENCE_DIR"); root != "" {
				raw, err := json.MarshalIndent(struct {
					Objects  map[string]object
					Requests []string
					Accepted bool
				}{objects, requests, err == nil}, "", "  ")
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, "http-"+strings.ReplaceAll(test.name, "/", "-")+".json"), raw, 0o600); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}
