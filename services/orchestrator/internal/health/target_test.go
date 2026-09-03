package health

import (
	"context"
	"net/netip"
	"strings"
	"testing"
)

func Test_Check_when_target_is_invalid(t *testing.T) {
	for _, path := range []string{"", "ready", "//host", "/a?x=1", "/a#x", "/\\host", "/a b", "/a\n", "/%", "/%zz", "/%2f", "/%5c", "/%3f", "/%23", "/%25", "/%00", "/%7f", "/%c2%a0", "/./x", "/../x", "/%2e%2E/x", "/" + strings.Repeat("x", 1024)} {
		t.Run(path, func(t *testing.T) {
			// Given: raw paths that must not be normalized into a different target.
			request := fixtureRequest()
			request.Path = path
			c := NewChecker().(*httpsChecker)
			c.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
				t.Fatal("invalid target queried DNS")
				return nil, nil
			}
			// When.
			got := c.Check(t.Context(), request)
			// Then.
			if got.FailureCode != "PUBLIC_HEALTH_INVALID_TARGET" || got.Retryable {
				t.Fatalf("got %+v", got)
			}
		})
	}
	for _, host := range []string{"", "localhost", "127.0.0.1", "[::1]", "::ffff:8.8.8.8", "host:443", "https://example.com", "user@example.com", "example.com.", "EXAMPLE.com", "a..com", "-a.com", "a-.com", "a_b.com", strings.Repeat("a", 64) + ".com"} {
		t.Run(host, func(t *testing.T) {
			// Given.
			request := fixtureRequest()
			request.Hostname = host
			// When.
			got := NewChecker().Check(t.Context(), request)
			// Then.
			if got.FailureCode != "PUBLIC_HEALTH_INVALID_TARGET" {
				t.Fatalf("got %+v", got)
			}
		})
	}
}

func Test_publicAddress_when_ordinary_public_or_special(t *testing.T) {
	for _, tc := range []struct {
		raw    string
		public bool
	}{
		{"1.1.1.1", true},
		{"8.8.8.8", true},
		{"2606:4700:4700::1111", true},
		{"192.0.0.9", false},
		{"192.31.196.1", false},
		{"192.52.193.1", false},
		{"192.175.48.1", false},
		{"2001:1::1", false},
		{"5f00::1", false},
		{"ff02::1", false},
		{"fec0::1", false},
		{"::", false},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			// Given.
			ip := netip.MustParseAddr(tc.raw)
			// When.
			got := publicAddress(ip)
			// Then.
			if got != tc.public {
				t.Fatalf("public=%v", got)
			}
		})
	}
}
