package objectstorage

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func Test_ProviderLock_when_loaded_by_Go_package(t *testing.T) {
	// Given
	raw, err := os.ReadFile("../../../../test-fixtures/contracts/object-storage-provider-lock.json")
	if err != nil {
		t.Fatal(err)
	}
	var lock struct {
		Release struct {
			Version      string `json:"version"`
			SourceCommit string `json:"sourceCommit"`
		} `json:"release"`
		Artifact struct {
			Image          string `json:"image"`
			OCIIndexDigest string `json:"ociIndexDigest"`
		} `json:"artifact"`
	}

	// When
	err = json.Unmarshal(raw, &lock)

	// Then
	if err != nil {
		t.Fatal(err)
	}
	if lock.Release.Version != Version ||
		lock.Release.SourceCommit != SourceCommit ||
		lock.Artifact.OCIIndexDigest != OCIIndexDigest ||
		lock.Artifact.Image != PinnedImage {
		t.Fatalf("Go package and provider lock diverged: %#v", lock)
	}
}

const (
	testAdminAccess  = "admin-access-key-fixture"
	testAdminSecret  = "admin-secret-key-fixture-0123456789"
	testTenantAccess = "tenant-access-key-fixture"
	testTenantSecret = "tenant-secret-key-fixture-0123456789"
)

func validConfig() Config {
	return Config{
		Image: PinnedImage, Bucket: "team-assets", SecretName: "storage-connection",
		GatewayNamespace:   "raibit-system",
		TrustedTLSEndpoint: "https://resources--club--project-assets.raibitserver.app",
		Admin:              Credentials{AccessKey: testAdminAccess, SecretKey: testAdminSecret},
		Tenant:             Credentials{AccessKey: testTenantAccess, SecretKey: testTenantSecret},
	}
}

func Test_Compile_when_authenticated_package_is_complete(t *testing.T) {
	// Given
	config := validConfig()

	// When
	runtime, err := Compile(config)

	// Then
	if err != nil {
		t.Fatal(err)
	}
	if runtime.Image != PinnedImage || runtime.Port != 8333 || runtime.RunAsUser != 1000 {
		t.Fatalf("unexpected pinned runtime: %#v", runtime)
	}
	if strings.Join(runtime.Args, " ") != "server -dir=/data -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json -filer" {
		t.Fatalf("unexpected finite command: %q", runtime.Args)
	}
	if runtime.SecretData["S3_ENDPOINT"] != config.TrustedTLSEndpoint {
		t.Fatalf("tenant endpoint is not the trusted TLS route: %q", runtime.SecretData["S3_ENDPOINT"])
	}
	var auth struct {
		Identities []struct {
			Name        string `json:"name"`
			Credentials []struct {
				AccessKey string `json:"accessKey"`
				SecretKey string `json:"secretKey"`
			} `json:"credentials"`
			Actions []string `json:"actions"`
		} `json:"identities"`
	}
	if err := json.Unmarshal([]byte(runtime.SecretData[ConfigSecretKey]), &auth); err != nil {
		t.Fatal(err)
	}
	if len(auth.Identities) != 2 {
		t.Fatalf("admin and tenant identities are both mandatory: %#v", auth)
	}
	if got := strings.Join(auth.Identities[0].Actions, ","); got != "Admin,Read,Write,List,Tagging" {
		t.Fatalf("provider identity is not administrative: %q", got)
	}
	wantTenantActions := "Read:team-assets,Write:team-assets,List:team-assets,Tagging:team-assets"
	if got := strings.Join(auth.Identities[1].Actions, ","); got != wantTenantActions || strings.Contains(got, "Admin") {
		t.Fatalf("tenant identity is not exact-bucket scoped: %q", got)
	}
}

func Test_Compile_when_required_authentication_or_pin_is_invalid(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{"tag-only image", func(config *Config) { config.Image = "chrislusf/seaweedfs:4.46" }},
		{"other digest", func(config *Config) { config.Image = "chrislusf/seaweedfs@sha256:" + strings.Repeat("f", 64) }},
		{"missing admin access", func(config *Config) { config.Admin.AccessKey = "" }},
		{"missing admin secret", func(config *Config) { config.Admin.SecretKey = "" }},
		{"missing tenant access", func(config *Config) { config.Tenant.AccessKey = "" }},
		{"missing tenant secret", func(config *Config) { config.Tenant.SecretKey = "" }},
		{"missing gateway namespace", func(config *Config) { config.GatewayNamespace = "" }},
		{"shared access key", func(config *Config) { config.Tenant.AccessKey = config.Admin.AccessKey }},
		{"insecure route", func(config *Config) { config.TrustedTLSEndpoint = "http://storage.test" }},
		{"foreign route", func(config *Config) { config.TrustedTLSEndpoint = "https://storage.example.test" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Given
			config := validConfig()
			test.mutate(&config)

			// When
			_, err := Compile(config)

			// Then
			if err == nil {
				t.Fatal("unsafe object-storage package accepted")
			}
		})
	}
}
