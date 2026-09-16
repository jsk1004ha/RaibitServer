package health

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/netip"
	"testing"
	"time"
)

func Test_Check_when_stage_stalls_with_long_caller_deadline(t *testing.T) {
	for _, stage := range []string{"dns", "connect", "tls", "header", "body"} {
		t.Run(stage, func(t *testing.T) {
			t.Parallel()
			// Given: a long caller budget; production's tighter stage budget must win.
			c, srv := localChecker(t, func(w http.ResponseWriter, r *http.Request) {
				if stage == "body" {
					w.WriteHeader(200)
					w.(http.Flusher).Flush()
				}
				<-r.Context().Done()
			})
			limit := 3 * time.Second
			switch stage {
			case "dns":
				limit = 2 * time.Second
				c.lookup = func(ctx context.Context, _, _ string) ([]netip.Addr, error) { <-ctx.Done(); return nil, ctx.Err() }
			case "connect":
				c.dial = func(ctx context.Context, _, _ string) (net.Conn, error) { <-ctx.Done(); return nil, ctx.Err() }
			case "tls":
				release := make(chan struct{})
				srv.TLS.GetConfigForClient = func(*tls.ClientHelloInfo) (*tls.Config, error) { <-release; return nil, nil }
				t.Cleanup(func() { close(release) })
			case "header":
			case "body":
				limit = 2 * time.Second
			}
			// When.
			started := time.Now()
			got := c.Check(t.Context(), fixtureRequest())
			elapsed := time.Since(started)
			// Then: bounded failure, not a 60-second wait or a successful observation.
			if got.FailureCode != "PUBLIC_HEALTH_TIMEOUT" || elapsed > limit+time.Second {
				t.Fatalf("got %+v elapsed=%s limit=%s", got, elapsed, limit)
			}
		})
	}
}
