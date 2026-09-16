package health

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func Test_Check_when_network_failure(t *testing.T) {
	for _, phase := range []string{"dns_error", "dns_empty", "dns_stall", "connect_refused", "connect_stall", "tls_trust", "tls_hostname", "tls_stall", "header_stall", "body_stall", "header_oversize", "body_chunked_oversize"} {
		t.Run(phase, func(t *testing.T) {
			// Given: real local TLS/HTTP boundaries except the isolated DNS/dial failure seam.
			c, srv := localChecker(t, func(w http.ResponseWriter, r *http.Request) {
				switch phase {
				case "header_stall":
					<-r.Context().Done()
				case "body_stall":
					w.WriteHeader(200)
					w.(http.Flusher).Flush()
					<-r.Context().Done()
				case "header_oversize":
					w.Header().Set("X-Large", strings.Repeat("x", maxHeaderBytes+1))
					w.WriteHeader(200)
				case "body_chunked_oversize":
					w.WriteHeader(200)
					w.(http.Flusher).Flush()
					if _, err := w.Write([]byte(strings.Repeat("x", maxBodyBytes+1))); err != nil {
						t.Logf("bounded close: %v", err)
					}
				default:
					w.WriteHeader(200)
				}
			})
			want := "PUBLIC_HEALTH_TIMEOUT"
			request := fixtureRequest()
			switch phase {
			case "dns_error":
				c.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
					return nil, &net.DNSError{IsNotFound: true}
				}
				want = "PUBLIC_HEALTH_DNS_FAILED"
			case "dns_empty":
				c.lookup = func(context.Context, string, string) ([]netip.Addr, error) { return nil, nil }
				want = "PUBLIC_HEALTH_DNS_FAILED"
			case "dns_stall":
				c.lookup = func(ctx context.Context, _, _ string) ([]netip.Addr, error) { <-ctx.Done(); return nil, ctx.Err() }
			case "connect_refused":
				address := srv.Listener.Addr().String()
				srv.Close()
				c.dial = func(ctx context.Context, _, _ string) (net.Conn, error) {
					return (&net.Dialer{}).DialContext(ctx, "tcp", address)
				}
				want = "PUBLIC_HEALTH_CONNECT_FAILED"
			case "connect_stall":
				c.dial = func(ctx context.Context, _, _ string) (net.Conn, error) { <-ctx.Done(); return nil, ctx.Err() }
			case "tls_trust":
				c.roots = x509.NewCertPool()
				want = "PUBLIC_HEALTH_TLS_FAILED"
			case "tls_hostname":
				request.Hostname = "different.example.net"
				want = "PUBLIC_HEALTH_TLS_FAILED"
			case "tls_stall":
				release := make(chan struct{})
				srv.TLS.GetConfigForClient = func(*tls.ClientHelloInfo) (*tls.Config, error) { <-release; return nil, nil }
				t.Cleanup(func() { close(release) })
			case "header_oversize":
				want = "PUBLIC_HEALTH_CONNECT_FAILED"
			case "body_chunked_oversize":
				want = "PUBLIC_HEALTH_RESPONSE_TOO_LARGE"
			}
			// When: caller's fixed deadline bounds every stage, with no test-only timeout knob.
			request.Deadline = time.Now().Add(150 * time.Millisecond)
			started := time.Now()
			got := c.Check(t.Context(), request)
			// Then.
			if got.Status != "DEGRADED" || got.FailureCode != want || time.Since(started) > 2*time.Second {
				t.Fatalf("got %+v elapsed=%s", got, time.Since(started))
			}
		})
	}
}

func Test_Check_when_already_cancelled_or_expired(t *testing.T) {
	for _, expired := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancelled", true: "expired"}[expired], func(t *testing.T) {
			// Given: an unusable caller budget and DNS that must never run.
			c := NewChecker().(*httpsChecker)
			c.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
				t.Fatal("DNS after deadline")
				return nil, nil
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			request := fixtureRequest()
			want := "PUBLIC_HEALTH_CANCELLED"
			if expired {
				request.Deadline = time.Now().Add(-time.Second)
				want = "PUBLIC_HEALTH_TIMEOUT"
			} else {
				cancel()
			}
			// When.
			got := c.Check(ctx, request)
			// Then.
			if got.FailureCode != want {
				t.Fatalf("got %+v", got)
			}
		})
	}
}

func Test_Check_when_cancelled_during_body(t *testing.T) {
	// Given: the response body is streaming when the caller cancels.
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	c, _ := localChecker(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		cancel()
		<-r.Context().Done()
	})
	// When.
	got := c.Check(ctx, fixtureRequest())
	// Then.
	if got.FailureCode != "PUBLIC_HEALTH_CANCELLED" || got.Retryable {
		t.Fatalf("got %+v", got)
	}
}
