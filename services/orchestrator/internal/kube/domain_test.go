package kube

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDomainPlanUsesExactSANAndBackend(t *testing.T) {
	// Given
	spec := DomainSpec{DomainID: "domain-1", OrganizationID: "org-1", ProjectID: "project-1", ServiceID: "service-1", Hostname: "app.example.test", Namespace: "org-1--demo", ServiceName: "web", ServicePort: 8080, Generation: 7, ClusterIssuer: "letsencrypt-production", IngressClassName: "nginx"}

	// When
	plan, err := CompileDomain(spec)

	// Then
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(plan.Manifests)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, required := range []string{"app.example.test", "letsencrypt-production", "service-1", "project-1", "domain-1", "8080"} {
		if !strings.Contains(text, required) {
			t.Fatalf("manifest missing %q: %s", required, text)
		}
	}
	if strings.Contains(text, "*.") || len(plan.Manifests) != 2 {
		t.Fatalf("unsafe domain plan: %s", text)
	}
}

func TestDomainPlanRejectsUnsafeBindings(t *testing.T) {
	tests := []DomainSpec{
		{DomainID: "domain-1", OrganizationID: "org-1", ProjectID: "project-1", ServiceID: "service-1", Hostname: "*.example.test", Namespace: "org--demo", ServiceName: "web", ServicePort: 8080, Generation: 1, ClusterIssuer: "issuer", IngressClassName: "nginx"},
		{DomainID: "domain-1", OrganizationID: "org-1", ProjectID: "project-1", ServiceID: "service-1", Hostname: "app.example.test", Namespace: "foreign", ServiceName: "web", ServicePort: 0, Generation: 1, ClusterIssuer: "issuer", IngressClassName: "nginx"},
	}
	for _, spec := range tests {
		// When
		_, err := CompileDomain(spec)

		// Then
		if err == nil {
			t.Fatalf("accepted unsafe spec: %#v", spec)
		}
	}
}

func TestDomainCleanupPlanNeedsOnlyOwnedObjectIdentity(t *testing.T) {
	// Given / When
	plan, err := CompileDomainCleanup("domain-1", "org--demo")

	// Then
	if err != nil || plan.DomainID != "domain-1" || plan.Name != "custom-domain-domain-1" || len(plan.Manifests) != 0 {
		t.Fatalf("cleanup plan = %#v, err = %v", plan, err)
	}
}

func TestDomainObservationRequiresExactReadyCertificateAndIngress(t *testing.T) {
	// Given
	plan, err := CompileDomain(DomainSpec{DomainID: "domain-1", OrganizationID: "org-1", ProjectID: "project-1", ServiceID: "service-1", Hostname: "app.example.test", Namespace: "org--demo", ServiceName: "web", ServicePort: 8080, Generation: 3, ClusterIssuer: "issuer", IngressClassName: "nginx"})
	if err != nil { t.Fatal(err) }
	certificate := plan.Manifests[0]
	certificate["status"] = map[string]any{"conditions": []any{map[string]any{"type": "Ready", "status": "True"}}}
	certificateJSON, err := json.Marshal(certificate)
	if err != nil { t.Fatal(err) }
	ingressJSON, err := json.Marshal(plan.Manifests[1])
	if err != nil { t.Fatal(err) }

	// When / Then
	if !certificateReady(certificateJSON, plan) || !ingressReady(ingressJSON, plan) {
		t.Fatal("exact observed objects were not ready")
	}
	var observedCertificate map[string]any
	if err := json.Unmarshal(certificateJSON, &observedCertificate); err != nil { t.Fatal(err) }
	observedCertificate["spec"].(map[string]any)["dnsNames"] = []any{"other.example.test"}
	certificateJSON, err = json.Marshal(observedCertificate)
	if err != nil { t.Fatal(err) }
	if certificateReady(certificateJSON, plan) {
		t.Fatal("wrong SAN was accepted")
	}
}
