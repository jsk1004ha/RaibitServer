package backup

import (
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
	"time"
)

func Test_Bundle_when_strict_boundary(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))
	for _, scenario := range []struct {
		name  string
		raw   string
		valid bool
	}{
		{"valid", bundleJSON(), true},
		{"unknown", strings.Replace(bundleJSON(), `"version":1`, `"version":1,"extra":true`, 1), false},
		{"duplicate", strings.Replace(bundleJSON(), `"version":1`, `"version":1,"version":1`, 1), false},
		{"escaped-duplicate", strings.Replace(bundleJSON(), `"version":1`, `"version":1,"vers\u0069on":1`, 1), false},
		{"trailing", bundleJSON() + `{}`, false},
		{"oversize", strings.Repeat(" ", MaxBundleBytes) + bundleJSON(), false},
		{"version", strings.Replace(bundleJSON(), `"version":1`, `"version":2`, 1), false},
		{"missing-current", strings.Replace(bundleJSON(), `"currentKeyVersion":"key-1"`, `"currentKeyVersion":"missing"`, 1), false},
		{"malformed-key-id", strings.ReplaceAll(bundleJSON(), "key-1", "../key"), false},
		{"empty-access", strings.Replace(bundleJSON(), "local-access", "", 1), false},
		{"null-secret", strings.Replace(bundleJSON(), `"local-secret"`, `null`, 1), false},
		{"short-key", `{"version":1,"accessKeyId":"a","secretAccessKey":"s","currentKeyVersion":"k","keys":{"k":"AA=="}}`, false},
		{"duplicate-material", `{"version":1,"accessKeyId":"a","secretAccessKey":"s","currentKeyVersion":"k","keys":{"k":"` + key + `","old":"` + key + `"}}`, false},
		{"duplicate-key", `{"version":1,"accessKeyId":"a","secretAccessKey":"s","currentKeyVersion":"k","keys":{"k":"` + key + `","k":"` + key + `"}}`, false},
		{"base64-newline", `{"version":1,"accessKeyId":"a","secretAccessKey":"s","currentKeyVersion":"k","keys":{"k":"` + key + `\n"}}`, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			// Given: one bounded operator-projected Secret JSON value.
			// When: parsing at the only credential/key boundary.
			bundle, err := ParseBundle(strings.NewReader(scenario.raw))
			// Then: ambiguity/invalid key material fails without credential leakage.
			if (err == nil) != scenario.valid {
				t.Fatalf("parse outcome: %v", err)
			}
			if strings.Contains(fmt.Sprintf("%v %#v", bundle, bundle), "local-secret") {
				t.Fatal("bundle formatter leaked secret")
			}
		})
	}
}

func Test_Attempt_when_invalid_or_retry(t *testing.T) {
	for _, name := range []string{"slash", "dot", "unicode", "empty", "oversize", "zero", "four", "missing-time"} {
		t.Run(name, func(t *testing.T) {
			// Given
			spec := AttemptSpec{OrganizationID: "org", ResourceID: "r", BackupID: "b", KeyVersion: "v1", Number: 1, FirstClaimAt: time.Now()}
			switch name {
			case "slash":
				spec.OrganizationID = "a/b"
			case "dot":
				spec.OrganizationID = ".."
			case "unicode":
				spec.OrganizationID = "한글"
			case "empty":
				spec.OrganizationID = ""
			case "oversize":
				spec.OrganizationID = strings.Repeat("x", 129)
			case "zero":
				spec.Number = 0
			case "four":
				spec.Number = 4
			case "missing-time":
				spec.FirstClaimAt = time.Time{}
			}
			// When
			_, err := NewAttempt(spec)
			// Then
			if err == nil {
				t.Fatal("invalid attempt accepted")
			}
		})
	}
}

func Test_Operator_when_invalid(t *testing.T) {
	for _, scenario := range []struct{ name, key, value string }{{"http", "ENDPOINT", "http://localhost"}, {"userinfo", "ENDPOINT", "https://user:password@example.test"}, {"query", "ENDPOINT", "https://example.test?a=b"}, {"path", "ENDPOINT", "https://example.test/path"}, {"bucket-path", "BUCKET", "a/b"}, {"file", "CONFIG_FILE", "/tmp/config"}, {"enabled", "ENABLED", "TRUE"}} {
		t.Run(scenario.name, func(t *testing.T) {
			// Given
			const prefix = "RAIBITSERVER_PROVISIONER_BACKUP_"
			env := map[string]string{prefix + "ENABLED": "true", prefix + "ENDPOINT": "https://example.test", prefix + "BUCKET": "private-test", prefix + "CONFIG_FILE": ConfigFile}
			env[prefix+scenario.key] = scenario.value
			// When
			_, err := ParseOperator(env)
			// Then
			if err == nil {
				t.Fatal("invalid operator config accepted")
			}
		})
	}
}

func Test_Service_when_insecure_transport_or_excessive_bounds(t *testing.T) {
	for _, options := range []Options{{TLSConfig: &tls.Config{InsecureSkipVerify: true}}, {MaxStoredBytes: MaxStoredBytes + 1}, {MaxPlaintextBytes: -1}} {
		// Given
		bundle, err := ParseBundle(strings.NewReader(bundleJSON()))
		if err != nil {
			t.Fatal(err)
		}
		// When
		_, err = NewService(OperatorConfig{enabled: true, endpoint: "https://example.test", bucket: "private-test"}, bundle, options)
		// Then
		if err == nil {
			t.Fatal("unsafe service config accepted")
		}
	}
}
