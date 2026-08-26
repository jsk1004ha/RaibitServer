package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTLSGatewayRoutesOnlyExactBrokerHost(t *testing.T) {
	cfg := testGatewayConfig(t, "http://registry.internal:5000")
	broker := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	handler := newTLSGatewayHandler(cfg, broker)

	req := httptest.NewRequest(http.MethodPost, "https://broker.example.test/broker", nil)
	req.Host = "broker.example.test:8443"
	req.TLS = &tls.ConnectionState{ServerName: "broker.example.test"}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusNoContent {
		t.Fatalf("expected broker handler status %d, got %d", http.StatusNoContent, recorder.Code)
	}
}

func TestTLSGatewayProxiesRegistryToFixedUpstream(t *testing.T) {
	requestSeen := make(chan *http.Request, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestSeen <- r.Clone(r.Context())
		_, _ = io.WriteString(w, "registry-ok")
	}))
	defer upstream.Close()

	cfg := testGatewayConfig(t, upstream.URL)
	handler := newTLSGatewayHandler(cfg, http.NotFoundHandler())
	req := httptest.NewRequest(http.MethodGet, "https://attacker.invalid/v2/catalog?n=10", nil)
	req.Host = "registry.example.test"
	req.TLS = &tls.ConnectionState{ServerName: "registry.example.test"}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusOK || strings.TrimSpace(recorder.Body.String()) != "registry-ok" {
		t.Fatalf("expected fixed upstream response, got status=%d body=%q", recorder.Code, recorder.Body.String())
	}
	seen := <-requestSeen
	if seen.URL.Path != "/v2/catalog" || seen.URL.RawQuery != "n=10" {
		t.Fatalf("unexpected upstream request target %q", seen.URL.RequestURI())
	}
	if seen.Host != strings.TrimPrefix(upstream.URL, "http://") {
		t.Fatalf("expected fixed upstream Host header, got %q", seen.Host)
	}
}

func TestTLSGatewayRejectsUnknownOrMismatchedHosts(t *testing.T) {
	cfg := testGatewayConfig(t, "http://registry.internal:5000")
	handler := newTLSGatewayHandler(cfg, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Fatal("broker handler must not be reached")
	}))

	tests := []struct {
		name string
		host string
		sni  string
		tls  bool
	}{
		{name: "unknown host", host: "unknown.example.test", sni: "unknown.example.test", tls: true},
		{name: "host and SNI mismatch", host: "broker.example.test", sni: "registry.example.test", tls: true},
		{name: "missing SNI", host: "broker.example.test", tls: true},
		{name: "cleartext", host: "broker.example.test"},
		{name: "malformed host", host: "broker.example.test:not-a-port", sni: "broker.example.test", tls: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "https://gateway.invalid/", nil)
			req.Host = tt.host
			if tt.tls {
				req.TLS = &tls.ConnectionState{ServerName: tt.sni}
			}
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, req)
			if recorder.Code != http.StatusMisdirectedRequest {
				t.Fatalf("expected 421, got %d", recorder.Code)
			}
		})
	}
}

func TestLoadTLSGatewayConfig(t *testing.T) {
	valid := map[string]string{
		"BROKER_HOST":            "broker.example.test",
		"INTERNAL_TLS_PORT":      "8443",
		"INTERNAL_TLS_CERT_FILE": "/tls/tls.crt",
		"INTERNAL_TLS_KEY_FILE":  "/tls/tls.key",
		"REGISTRY_UPSTREAM_URL":  "http://raibit-registry:5000",
	}
	getenv := func(values map[string]string) func(string) string {
		return func(key string) string { return values[key] }
	}

	disabled, err := loadTLSGatewayConfig(getenv(map[string]string{}), "registry.example.test")
	if err != nil || disabled.Enabled {
		t.Fatalf("empty gateway configuration should be disabled, got %#v, %v", disabled, err)
	}
	cfg, err := loadTLSGatewayConfig(getenv(valid), "registry.example.test")
	if err != nil {
		t.Fatalf("valid gateway configuration failed: %v", err)
	}
	if !cfg.Enabled || cfg.Port != "8443" || cfg.BrokerHost != "broker.example.test" || cfg.RegistryUpstream.Host != "raibit-registry:5000" {
		t.Fatalf("unexpected gateway configuration: %#v", cfg)
	}

	tests := []struct {
		name  string
		key   string
		value string
	}{
		{name: "partial", key: "INTERNAL_TLS_KEY_FILE", value: ""},
		{name: "invalid broker host", key: "BROKER_HOST", value: "https://broker.example.test"},
		{name: "same public hosts", key: "BROKER_HOST", value: "registry.example.test"},
		{name: "invalid port", key: "INTERNAL_TLS_PORT", value: "70000"},
		{name: "https upstream", key: "REGISTRY_UPSTREAM_URL", value: "https://raibit-registry:5000"},
		{name: "upstream path", key: "REGISTRY_UPSTREAM_URL", value: "http://raibit-registry:5000/arbitrary"},
		{name: "upstream credentials", key: "REGISTRY_UPSTREAM_URL", value: "http://user:secret@raibit-registry:5000"},
		{name: "arbitrary upstream", key: "REGISTRY_UPSTREAM_URL", value: "http://metadata.internal:5000"},
		{name: "lookalike upstream", key: "REGISTRY_UPSTREAM_URL", value: "http://raibit-registry.attacker.test:5000"},
		{name: "wrong upstream port", key: "REGISTRY_UPSTREAM_URL", value: "http://raibit-registry:8080"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			values := make(map[string]string, len(valid))
			for key, value := range valid {
				values[key] = value
			}
			values[tt.key] = tt.value
			if _, err := loadTLSGatewayConfig(getenv(values), "registry.example.test"); err == nil {
				t.Fatal("expected configuration validation error")
			}
		})
	}
}

func TestInternalTLSServerReloadsCertificateAndRejectsUnknownSNI(t *testing.T) {
	directory := t.TempDir()
	certificateFile := filepath.Join(directory, "tls.crt")
	privateKeyFile := filepath.Join(directory, "tls.key")
	writeTestCertificatePair(t, certificateFile, privateKeyFile, 1)

	cfg := testGatewayConfig(t, "http://raibit-registry:5000")
	cfg.InternalTLS.CertificateFile = certificateFile
	cfg.InternalTLS.PrivateKeyFile = privateKeyFile
	server, err := newInternalTLSServer(cfg, http.NotFoundHandler())
	if err != nil {
		t.Fatal(err)
	}

	first, err := server.TLSConfig.GetCertificate(&tls.ClientHelloInfo{ServerName: "broker.example.test"})
	if err != nil || certificateSerial(t, first) != 1 {
		t.Fatalf("expected initial certificate serial 1, got certificate=%v err=%v", first != nil, err)
	}

	writeTestCertificatePair(t, certificateFile, privateKeyFile, 2)
	second, err := server.TLSConfig.GetCertificate(&tls.ClientHelloInfo{ServerName: "registry.example.test"})
	if err != nil || certificateSerial(t, second) != 2 {
		t.Fatalf("expected rotated certificate serial 2, got certificate=%v err=%v", second != nil, err)
	}

	if _, err := server.TLSConfig.GetCertificate(&tls.ClientHelloInfo{ServerName: "unknown.example.test"}); err == nil {
		t.Fatal("unknown SNI must fail before a certificate is returned")
	}
}

func writeTestCertificatePair(t *testing.T, certificateFile, privateKeyFile string, serial int64) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	template := &x509.Certificate{
		SerialNumber: big.NewInt(serial),
		Subject:      pkix.Name{CommonName: "registry.example.test"},
		DNSNames:     []string{"registry.example.test", "broker.example.test"},
		NotBefore:    now.Add(-time.Minute),
		NotAfter:     now.Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	certificateDER, err := x509.CreateCertificate(rand.Reader, template, template, publicKey, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	privateKeyDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	writeAtomicTestFile(t, certificateFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificateDER}))
	writeAtomicTestFile(t, privateKeyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateKeyDER}))
}

func writeAtomicTestFile(t *testing.T, target string, contents []byte) {
	t.Helper()
	temporary := target + ".tmp"
	if err := os.WriteFile(temporary, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(temporary, target); err != nil {
		t.Fatal(err)
	}
}

func certificateSerial(t *testing.T, certificate *tls.Certificate) int64 {
	t.Helper()
	if certificate == nil || len(certificate.Certificate) == 0 {
		t.Fatal("missing leaf certificate")
	}
	leaf, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	return leaf.SerialNumber.Int64()
}

func testGatewayConfig(t *testing.T, upstream string) config {
	t.Helper()
	parsed, err := url.Parse(upstream)
	if err != nil {
		t.Fatal(err)
	}
	return config{
		RegistryHost: "registry.example.test",
		InternalTLS: tlsGatewayConfig{
			Enabled:          true,
			Port:             "8443",
			BrokerHost:       "broker.example.test",
			RegistryUpstream: parsed,
		},
	}
}
