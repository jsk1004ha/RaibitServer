package health

import (
	"context"
	"crypto/x509"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const fixtureHost = "example.com"

func fixtureRequest() Request {
	return Request{Hostname: fixtureHost, Path: "/ready", Deadline: time.Now().Add(time.Minute)}
}

func localChecker(t *testing.T, handler http.HandlerFunc) (*httpsChecker, *httptest.Server) {
	t.Helper()
	srv := httptest.NewTLSServer(handler)
	t.Cleanup(srv.Close)
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	c := NewChecker().(*httpsChecker)
	c.roots = pool
	c.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}
	c.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" || address != "8.8.8.8:443" {
			t.Errorf("unvalidated dial: %s %s", network, address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
	}
	return c, srv
}

func Test_Check_when_TLS_response(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		code   string
		retry  bool
	}{
		{"success", 200, "ok", "", false},
		{"no_content", 204, "", "", false},
		{"redirect", 302, "", "PUBLIC_HEALTH_REDIRECT", false},
		{"refusal", 503, "unavailable", "PUBLIC_HEALTH_HTTP_STATUS", true},
		{"client_error", 404, "missing", "PUBLIC_HEALTH_HTTP_STATUS", false},
		{"large_body", 200, strings.Repeat("x", 65537), "PUBLIC_HEALTH_RESPONSE_TOO_LARGE", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Given: a real TLS endpoint and a public DNS answer mapped only by test dialer.
			var calls atomic.Int32
			c, _ := localChecker(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Host != fixtureHost || r.TLS.ServerName != fixtureHost || r.Method != "GET" || r.RequestURI != "/ready" {
					t.Error("request identity changed")
				}
				if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Accept-Encoding") != "" {
					t.Error("unexpected credential or compression header")
				}
				w.Header().Set("Location", "https://127.0.0.1/secret")
				w.WriteHeader(tc.status)
				if _, err := w.Write([]byte(tc.body)); err != nil {
					t.Logf("bounded client closed: %v", err)
				}
			})
			// When.
			got := c.Check(t.Context(), fixtureRequest())
			// Then: exactly one request, bounded typed observation, no body returned.
			wantStatus := "DEGRADED"
			if tc.code == "" {
				wantStatus = "HEALTHY"
			}
			if got != (Result{Status: wantStatus, FailureCode: tc.code, Retryable: tc.retry}) || calls.Load() != 1 {
				t.Fatalf("got %+v calls=%d", got, calls.Load())
			}
		})
	}
}

func Test_Check_when_DNS_contains_unsafe_answer(t *testing.T) {
	for _, raw := range []string{"127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.169.254", "192.0.2.1", "198.18.0.1", "224.0.0.1", "240.1.1.1", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "64:ff9b::808:808", "2001:db8::1", "2002:808:808::1", "fc00::1", "fe80::1", "3fff::1", "2620:4f:8000::1"} {
		t.Run(raw, func(t *testing.T) {
			// Given: mixed public and forbidden records; no private-address bypass exists.
			c := NewChecker().(*httpsChecker)
			c.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
				return []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr(raw)}, nil
			}
			c.dial = func(context.Context, string, string) (net.Conn, error) {
				t.Fatal("unsafe set dialed")
				return nil, net.ErrClosed
			}
			// When.
			got := c.Check(t.Context(), fixtureRequest())
			// Then.
			if got.FailureCode != "PUBLIC_HEALTH_UNSAFE_ADDRESS" || got.Retryable {
				t.Fatalf("got %+v", got)
			}
		})
	}
}

func Test_Check_when_proxy_environment_and_rebinding(t *testing.T) {
	// Given: environment proxy traps and DNS changing after the first lookup.
	var proxyCalls atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { proxyCalls.Add(1) }))
	defer proxy.Close()
	for _, key := range []string{"HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"} {
		t.Setenv(key, proxy.URL)
	}
	c, _ := localChecker(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	var lookups atomic.Int32
	c.lookup = func(_ context.Context, network, host string) ([]netip.Addr, error) {
		if network != "ip" || host != fixtureHost+"." {
			t.Errorf("DNS identity: %s %s", network, host)
		}
		if lookups.Add(1) == 1 {
			return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
		}
		return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
	}
	// When: one observation followed by a new observation.
	first := c.Check(t.Context(), fixtureRequest())
	second := c.Check(t.Context(), fixtureRequest())
	// Then: no relookup inside an attempt; every new attempt revalidates; no proxy used.
	if first.Status != "HEALTHY" || second.FailureCode != "PUBLIC_HEALTH_UNSAFE_ADDRESS" || lookups.Load() != 2 || proxyCalls.Load() != 0 {
		t.Fatalf("first=%+v second=%+v lookups=%d proxy=%d", first, second, lookups.Load(), proxyCalls.Load())
	}
}
