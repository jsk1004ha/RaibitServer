package config

import (
	"os"
	"testing"
)

func TestDomainControllerSettingsFromEnvironment(t *testing.T) {
	// Given
	t.Setenv("RAIBITSERVER_DOMAIN_CLUSTER_ISSUER", "letsencrypt-production")
	t.Setenv("RAIBITSERVER_DOMAIN_RETRY_SECONDS", "17")

	// When
	cfg := FromEnv()

	// Then
	if cfg.DomainClusterIssuer != "letsencrypt-production" || cfg.DomainRetryAfter.Seconds() != 17 {
		t.Fatalf("domain controller settings = %#v", cfg)
	}
}

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

func TestIngressErrorSettingsFromEnvironment(t *testing.T) {
	original, existed := os.LookupEnv("RAIBITSERVER_INGRESS_CUSTOM_HTTP_ERRORS")
	if err := os.Unsetenv("RAIBITSERVER_INGRESS_CUSTOM_HTTP_ERRORS"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if existed {
			_ = os.Setenv("RAIBITSERVER_INGRESS_CUSTOM_HTTP_ERRORS", original)
		} else {
			_ = os.Unsetenv("RAIBITSERVER_INGRESS_CUSTOM_HTTP_ERRORS")
		}
	})
	t.Setenv("RAIBITSERVER_INGRESS_ERROR_MIDDLEWARE", "")
	cfg := FromEnv()
	if cfg.IngressCustomHTTPErrors != "500,502,503,504" {
		t.Fatalf("default custom HTTP errors = %q", cfg.IngressCustomHTTPErrors)
	}
	if cfg.IngressErrorMiddleware != "" {
		t.Fatalf("default error middleware = %q, want empty", cfg.IngressErrorMiddleware)
	}

	t.Setenv("RAIBITSERVER_INGRESS_CUSTOM_HTTP_ERRORS", "")
	cfg = FromEnv()
	if cfg.IngressCustomHTTPErrors != "disabled" {
		t.Fatalf("explicit empty custom HTTP errors = %q, want disabled", cfg.IngressCustomHTTPErrors)
	}

	t.Setenv("RAIBITSERVER_INGRESS_CUSTOM_HTTP_ERRORS", "404, 500")
	t.Setenv("RAIBITSERVER_INGRESS_ERROR_MIDDLEWARE", "platform-errors@kubernetescrd")
	cfg = FromEnv()
	if cfg.IngressCustomHTTPErrors != "404, 500" || cfg.IngressErrorMiddleware != "platform-errors@kubernetescrd" {
		t.Fatalf("configured ingress error settings = %#v", cfg)
	}
}
