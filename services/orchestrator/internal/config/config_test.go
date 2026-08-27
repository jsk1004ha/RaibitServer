package config

import "testing"

func TestIngressGatewayNamespaceFromEnvironment(t *testing.T) {
	t.Setenv("RAIBITSERVER_INGRESS_GATEWAY_NAMESPACE", "")
	if got := FromEnv().IngressGatewayNamespace; got != "ingress-nginx" {
		t.Fatalf("default ingress gateway namespace = %q, want ingress-nginx", got)
	}

	t.Setenv("RAIBITSERVER_INGRESS_GATEWAY_NAMESPACE", "edge-gateway-system")
	if got := FromEnv().IngressGatewayNamespace; got != "edge-gateway-system" {
		t.Fatalf("configured ingress gateway namespace = %q, want edge-gateway-system", got)
	}
}

func TestIngressClassNameFromEnvironment(t *testing.T) {
	t.Setenv("RAIBITSERVER_INGRESS_CLASS_NAME", "")
	if got := FromEnv().IngressClassName; got != "nginx" {
		t.Fatalf("default ingress class name = %q, want nginx", got)
	}

	t.Setenv("RAIBITSERVER_INGRESS_CLASS_NAME", "traefik")
	if got := FromEnv().IngressClassName; got != "traefik" {
		t.Fatalf("configured ingress class name = %q, want traefik", got)
	}
}
