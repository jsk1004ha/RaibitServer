package kube

import (
	"encoding/json"
	"testing"

	"github.com/raibitserver/orchestrator/internal/store"
)

func TestSpecFromState_uses_candidate_runtime_probe_identity(t *testing.T) {
	// Given
	project := &store.Project{ID: "project-1", OrganizationID: "organization-1", OrganizationSlug: "acme", Slug: "demo"}
	service := &store.Service{ID: "service-1", ProjectID: project.ID, Slug: "web", Type: "web", Port: 8080, Replicas: 1}
	deployment := &store.Deployment{
		ID: "deployment-1", ProjectID: project.ID, ServiceID: service.ID, DeploymentType: "preview",
		PreviewLineageID: "lineage-1", PreviewGeneration: 2,
		PreviewRuntimeJSON: json.RawMessage(`{"version":1,"lineageId":"lineage-1","deploymentId":"deployment-1","generation":2,"lineageVersion":7,"stableHost":"preview--pr-7--acme--demo.example.test","probeHost":"preview--probe-0123456789abcdef0123456789abcdef.example.test","namespace":"acme--demo","workloadName":"pr-7-web-candidate","serviceName":"pr-7-web-candidate","probeIngressName":"pr-7-web-candidate","routeName":"preview-route-lineage"}`),
	}

	// When
	spec := SpecFromState(project, service, deployment, "ignored.example")

	// Then
	if spec.InvalidReason != "" || spec.Host != "preview--probe-0123456789abcdef0123456789abcdef.example.test" || spec.Name != "pr-7-web-candidate" || spec.Namespace != "acme--demo" {
		t.Fatalf("candidate spec=%#v", spec)
	}
	plan := NewDeploymentPlan(spec)
	if len(plan.Manifests) != 3 || plan.Manifests[0]["kind"] != "Deployment" || plan.Manifests[1]["kind"] != "Service" || plan.Manifests[2]["kind"] != "Ingress" {
		t.Fatalf("candidate must mutate only its three owned objects: %#v", plan.Manifests)
	}
}

func TestPreviewRouteManifest_matches_frozen_admission_contract_and_observation_fences_backend(t *testing.T) {
	// Given
	work := store.PreviewRouteWork{Lease: store.PreviewRouteLease{LineageID: "lineage-1", Version: 7}, ProjectID: "project-1", ServiceID: "service-1", Namespace: "acme--demo", RouteName: "preview-route-lineage", StableHost: "preview--pr-7--acme--demo.example.test"}
	runtime := store.PreviewRuntime{Version: 1, LineageID: "lineage-1", DeploymentID: "deployment-1", Generation: 2, LineageVersion: 7, StableHost: work.StableHost, ProbeHost: "preview--probe-0123456789abcdef0123456789abcdef.example.test", Namespace: work.Namespace, WorkloadName: "pr-7-web-candidate", ServiceName: "pr-7-web-candidate", ProbeIngressName: "pr-7-web-candidate", RouteName: work.RouteName}

	// When
	manifest, err := PreviewRouteManifest(work, runtime, "route-uid", "12", 8080)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}

	// Then
	if _, err := ObservePreviewRoute(raw, work, runtime); err != nil {
		t.Fatalf("frozen route contract was not observable: %v\n%s", err, raw)
	}
	labels := manifest["metadata"].(map[string]any)["labels"].(map[string]any)
	if labels["app.kubernetes.io/name"] != work.RouteName || labels["raibitserver.io/project-id"] != work.ProjectID || labels["raibitserver.io/service-id"] != work.ServiceID || labels["raibitserver.io/deployment-id"] != runtime.DeploymentID || labels["raibitserver.io/preview-generation"] != "2" || labels["raibitserver.io/preview-backend-service"] != runtime.ServiceName {
		t.Fatalf("route provenance labels=%#v", labels)
	}
	annotations := manifest["metadata"].(map[string]any)["annotations"].(map[string]any)
	if len(annotations) != 2 || annotations["raibitserver.io/hostname"] != work.StableHost || annotations["nginx.ingress.kubernetes.io/custom-http-errors"] != "500,502,503,504" {
		t.Fatalf("default hosted-error admission annotations=%#v", annotations)
	}
	labels["raibitserver.io/preview-backend-service"] = "foreign-service"
	tampered, _ := json.Marshal(manifest)
	if _, err := ObservePreviewRoute(tampered, work, runtime); err == nil {
		t.Fatal("backend provenance label drift was accepted")
	}
}

func TestPreviewRouteManifest_uses_trusted_hosted_error_options_and_fails_closed(t *testing.T) {
	// Given
	work := store.PreviewRouteWork{Lease: store.PreviewRouteLease{LineageID: "lineage-1", Version: 7}, ProjectID: "project-1", ServiceID: "service-1", Namespace: "acme--demo", RouteName: "preview-route-lineage", StableHost: "preview--pr-7--acme--demo.example.test"}
	runtime := store.PreviewRuntime{Version: 1, LineageID: "lineage-1", DeploymentID: "deployment-1", Generation: 2, LineageVersion: 7, StableHost: work.StableHost, ProbeHost: "preview--probe-0123456789abcdef0123456789abcdef.example.test", Namespace: work.Namespace, WorkloadName: "pr-7-web-candidate", ServiceName: "pr-7-web-candidate", ProbeIngressName: "pr-7-web-candidate", RouteName: work.RouteName}

	for _, tc := range []struct {
		name        string
		options     DeploymentOptions
		annotationN int
		statuses    string
		middleware  string
	}{
		{name: "custom Traefik", options: DeploymentOptions{IngressClassName: "traefik", IngressCustomHTTPErrors: "504, 500,502,500", IngressErrorMiddleware: " Platform-Errors@KubernetesCRD "}, annotationN: 3, statuses: "500,502,504", middleware: "platform-errors@kubernetescrd"},
		{name: "disabled", options: DeploymentOptions{IngressCustomHTTPErrors: "disabled", IngressErrorMiddleware: "platform-errors@kubernetescrd"}, annotationN: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// When
			manifest, err := PreviewRouteManifest(work, runtime, "route-uid", "12", 8080, tc.options)

			// Then
			if err != nil {
				t.Fatal(err)
			}
			metadata := manifest["metadata"].(map[string]any)
			annotations := metadata["annotations"].(map[string]any)
			if len(annotations) != tc.annotationN || annotations["raibitserver.io/hostname"] != work.StableHost {
				t.Fatalf("trusted annotations=%#v", annotations)
			}
			for key, value := range map[string]string{"nginx.ingress.kubernetes.io/custom-http-errors": tc.statuses, "traefik.ingress.kubernetes.io/router.middlewares": tc.middleware} {
				if value == "" {
					if _, exists := annotations[key]; exists {
						t.Fatalf("disabled hosted errors emitted %s: %#v", key, annotations)
					}
				} else if annotations[key] != value {
					t.Fatalf("trusted annotation %s=%#v", key, annotations[key])
				}
			}
			if ingressClass := manifest["spec"].(map[string]any)["ingressClassName"]; ingressClass != firstNonEmpty(tc.options.IngressClassName, "nginx") {
				t.Fatalf("ingress class=%#v", ingressClass)
			}
		})
	}

	for _, options := range []DeploymentOptions{{IngressCustomHTTPErrors: "404,700"}, {IngressErrorMiddleware: "unsafe/value"}, {IngressClassName: "INVALID/class"}} {
		manifest, err := PreviewRouteManifest(work, runtime, "route-uid", "12", 8080, options)
		if err == nil || manifest != nil {
			t.Fatalf("invalid trusted ingress settings must fail closed: manifest=%#v err=%v", manifest, err)
		}
	}
}
