package kube

import (
	"testing"

	"github.com/raibitserver/orchestrator/internal/store"
)

func TestNetworkPolicyUsesSharedIngressGatewayLabel(t *testing.T) {
	manifests := CompileServiceManifests(AppServiceSpec{
		Name:             "web",
		Namespace:        "org-project",
		Image:            "registry.local/web:1",
		ProjectSlug:      "project",
		OrganizationSlug: "org",
		DeploymentID:     "dep-1",
	})
	policy := findManifest(t, manifests, "NetworkPolicy", "web-default")
	ingress := policy["spec"].(map[string]any)["ingress"].([]any)
	foundGateway := false
	for _, rule := range ingress {
		from := rule.(map[string]any)["from"].([]any)
		for _, peer := range from {
			namespaceSelector := peer.(map[string]any)["namespaceSelector"].(map[string]any)
			matchLabels := namespaceSelector["matchLabels"].(map[string]any)
			if len(matchLabels) == 0 {
				t.Fatalf("network policy must not contain empty namespaceSelector")
			}
			if matchLabels["kubernetes.io/metadata.name"] == "org-project" {
				t.Fatalf("default ingress must not allow same-namespace lateral traffic")
			}
			if matchLabels["raibitserver.io/ingress-gateway"] == "true" {
				foundGateway = true
			}
		}
	}
	if !foundGateway {
		t.Fatalf("expected ingress gateway namespaceSelector label raibitserver.io/ingress-gateway=true")
	}
}

func TestPublicEgressIsServiceScopedAndOptIn(t *testing.T) {
	defaultManifests := CompileServiceManifests(AppServiceSpec{
		Name:             "api",
		Namespace:        "org-project",
		Image:            "registry.local/api:1",
		ProjectSlug:      "project",
		OrganizationSlug: "org",
		DeploymentID:     "dep-1",
	})
	if manifestExists(defaultManifests, "NetworkPolicy", "api-public-egress") {
		t.Fatalf("public egress policy must be opt-in")
	}

	publicManifests := CompileServiceManifests(AppServiceSpec{
		Name:             "api",
		Namespace:        "org-project",
		Image:            "registry.local/api:1",
		ProjectSlug:      "project",
		OrganizationSlug: "org",
		DeploymentID:     "dep-1",
		PublicEgress:     true,
	})
	policy := findManifest(t, publicManifests, "NetworkPolicy", "api-public-egress")
	spec := policy["spec"].(map[string]any)
	podSelector := spec["podSelector"].(map[string]any)["matchLabels"].(map[string]any)
	if podSelector["app.kubernetes.io/name"] != "api" {
		t.Fatalf("public egress must be scoped to service pod selector, got %#v", podSelector)
	}
	egress := spec["egress"].([]any)
	ipv4Block := egress[0].(map[string]any)["to"].([]any)[0].(map[string]any)["ipBlock"].(map[string]any)
	if ipv4Block["cidr"] != "0.0.0.0/0" {
		t.Fatalf("expected public IPv4 cidr, got %#v", ipv4Block["cidr"])
	}
	except := ipv4Block["except"].([]any)
	if !containsAny(except, "169.254.0.0/16") {
		t.Fatalf("public egress must preserve metadata/private-network exclusions, got %#v", except)
	}
}

func TestSpecFromStateReadsPublicEgressIntent(t *testing.T) {
	spec := SpecFromState(
		&store.Project{ID: "project-1", OrganizationID: "org-1", Name: "Project", Slug: "project"},
		&store.Service{ID: "svc-1", ProjectID: "project-1", Name: "api", Slug: "api", ImageURL: "registry.local/api:1", DesiredSpec: map[string]any{"egress": map[string]any{"publicInternet": true}}},
		&store.Deployment{ID: "dep-1", ServiceID: "svc-1", ProjectID: "project-1", ImageURL: "registry.local/api:1"},
		"raibitserver.local",
	)
	if !spec.PublicEgress {
		t.Fatalf("expected SpecFromState to carry service egress.publicInternet intent into AppServiceSpec")
	}
}

func TestSpecFromStateUsesUserProjectAppsHostnames(t *testing.T) {
	production := SpecFromState(
		&store.Project{ID: "project-1", OrganizationID: "gdg-hongik", Name: "Festival", Slug: "festival-2026"},
		&store.Service{ID: "svc-1", ProjectID: "project-1", Name: "web", Slug: "web", ImageURL: "registry.local/web:1"},
		&store.Deployment{ID: "dep-1", ServiceID: "svc-1", ProjectID: "project-1", ImageURL: "registry.local/web:1"},
		"raibitserver.local",
	)
	if production.Host != "gdg-hongik-festival-2026.apps.raibitserver.local" {
		t.Fatalf("expected user-project apps host, got %q", production.Host)
	}

	preview := SpecFromState(
		&store.Project{ID: "project-1", OrganizationID: "gdg-hongik", Name: "Festival", Slug: "festival-2026"},
		&store.Service{ID: "svc-1", ProjectID: "project-1", Name: "web", Slug: "web", ImageURL: "registry.local/web:1"},
		&store.Deployment{ID: "dep-2", ServiceID: "svc-1", ProjectID: "project-1", ImageURL: "registry.local/web:1", DeploymentType: "preview", PullRequestNumber: 32},
		"raibitserver.local",
	)
	if preview.Host != "pr-32-gdg-hongik-festival-2026.preview.raibitserver.local" {
		t.Fatalf("expected preview user-project host, got %q", preview.Host)
	}
}

func findManifest(t *testing.T, manifests []map[string]any, kind string, name string) map[string]any {
	t.Helper()
	for _, manifest := range manifests {
		if manifest["kind"] != kind {
			continue
		}
		metadata := manifest["metadata"].(map[string]any)
		if metadata["name"] == name {
			return manifest
		}
	}
	t.Fatalf("manifest %s/%s not found", kind, name)
	return nil
}

func manifestExists(manifests []map[string]any, kind string, name string) bool {
	for _, manifest := range manifests {
		if manifest["kind"] != kind {
			continue
		}
		metadata := manifest["metadata"].(map[string]any)
		if metadata["name"] == name {
			return true
		}
	}
	return false
}

func containsAny(values []any, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}
