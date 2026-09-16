package kube

import (
	"errors"
	"strconv"
	"strings"
)

type DomainSpec struct {
	DomainID        string
	OrganizationID  string
	ProjectID       string
	ServiceID       string
	Hostname        string
	Namespace       string
	ServiceName     string
	ServicePort     int
	Generation      int
	ClusterIssuer   string
	IngressClassName string
}

type DomainPlan struct {
	Name      string
	Namespace string
	DomainID  string
	Manifests []map[string]any
}

func CompileDomainCleanup(domainID, namespace string) (DomainPlan, error) {
	if domainID == "" || namespace == "" || !dnsSubdomainValidationPattern.MatchString(namespace) {
		return DomainPlan{}, errors.New("custom domain cleanup binding is invalid")
	}
	return DomainPlan{
		Name: boundedDNSName("custom-domain-"+domainID, domainID, 63),
		Namespace: namespace,
		DomainID: domainID,
	}, nil
}

func DomainTenantNamespace(organizationID, projectID, projectSlug string) (string, error) {
	if organizationID == "" || projectID == "" {
		return "", errors.New("custom domain tenant identity is incomplete")
	}
	organization := normalizeDNSName(organizationID)
	project := normalizeDNSName(firstNonEmpty(projectSlug, projectID))
	return boundedDNSName(organization+"--"+project, organizationID+"\x00"+projectID, 63), nil
}

func CompileDomain(spec DomainSpec) (DomainPlan, error) {
	if spec.DomainID == "" || spec.OrganizationID == "" || spec.ProjectID == "" || spec.ServiceID == "" ||
		spec.Namespace == "" || spec.ServiceName == "" || spec.ServicePort < 1 || spec.ServicePort > 65535 ||
		spec.Generation < 1 || spec.ClusterIssuer == "" || spec.IngressClassName == "" {
		return DomainPlan{}, errors.New("custom domain binding is incomplete")
	}
	if strings.Contains(spec.Hostname, "*") || len(spec.Hostname) > 253 || !strings.Contains(spec.Hostname, ".") ||
		!dnsSubdomainValidationPattern.MatchString(spec.Hostname) || !dnsSubdomainValidationPattern.MatchString(spec.Namespace) ||
		!dnsSubdomainValidationPattern.MatchString(spec.ClusterIssuer) || !dnsSubdomainValidationPattern.MatchString(spec.IngressClassName) {
		return DomainPlan{}, errors.New("custom domain binding contains an invalid DNS name")
	}
	name := boundedDNSName("custom-domain-"+spec.DomainID, spec.DomainID, 63)
	secretName := boundedDNSName(name+"-tls", spec.DomainID+"-tls", 63)
	labels := map[string]any{
		"app.kubernetes.io/managed-by": "raibitserver",
		"raibitserver.io/custom-domain": "true",
		"raibitserver.io/domain-id": spec.DomainID,
		"raibitserver.io/organization-id": spec.OrganizationID,
		"raibitserver.io/project-id": spec.ProjectID,
		"raibitserver.io/service-id": spec.ServiceID,
		"raibitserver.io/domain-generation": strconv.Itoa(spec.Generation),
	}
	certificate := map[string]any{
		"apiVersion": "cert-manager.io/v1", "kind": "Certificate",
		"metadata": map[string]any{"name": name, "namespace": spec.Namespace, "labels": labels},
		"spec": map[string]any{
			"secretName": secretName,
			"dnsNames": []any{spec.Hostname},
			"issuerRef": map[string]any{"name": spec.ClusterIssuer, "kind": "ClusterIssuer", "group": "cert-manager.io"},
		},
	}
	ingress := map[string]any{
		"apiVersion": "networking.k8s.io/v1", "kind": "Ingress",
		"metadata": map[string]any{"name": name, "namespace": spec.Namespace, "labels": labels, "annotations": map[string]any{"raibitserver.io/hostname": spec.Hostname}},
		"spec": map[string]any{
			"ingressClassName": spec.IngressClassName,
			"tls": []any{map[string]any{"hosts": []any{spec.Hostname}, "secretName": secretName}},
			"rules": []any{map[string]any{"host": spec.Hostname, "http": map[string]any{"paths": []any{map[string]any{
				"path": "/", "pathType": "Prefix", "backend": map[string]any{"service": map[string]any{"name": spec.ServiceName, "port": map[string]any{"number": spec.ServicePort}}},
			}}}}},
		},
	}
	return DomainPlan{Name: name, Namespace: spec.Namespace, DomainID: spec.DomainID, Manifests: []map[string]any{certificate, ingress}}, nil
}
