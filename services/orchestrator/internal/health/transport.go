package health

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/netip"
)

type phaseError struct {
	code  failureCode
	cause error
}

func (e *phaseError) Error() string { return string(e.code) }
func (e *phaseError) Unwrap() error { return e.cause }

func (c *httpsChecker) transport(host string, ip netip.Addr) *http.Transport {
	return &http.Transport{
		Proxy:                  nil,
		DisableKeepAlives:      true,
		DisableCompression:     true,
		MaxResponseHeaderBytes: maxHeaderBytes,
		ResponseHeaderTimeout:  headerTimeout,
		TLSNextProto:           map[string]func(string, *tls.Conn) http.RoundTripper{},
		DialTLSContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			if network != "tcp" || address != net.JoinHostPort(host, "443") {
				return nil, &phaseError{code: invalidTarget, cause: errors.New("unexpected transport target")}
			}
			connectCtx, cancelConnect := context.WithTimeout(ctx, connectTimeout)
			defer cancelConnect()
			conn, err := c.dial(connectCtx, "tcp", net.JoinHostPort(ip.String(), "443"))
			if err != nil {
				return nil, &phaseError{code: connectFailed, cause: err}
			}
			tlsConn := tls.Client(conn, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12, RootCAs: c.roots, NextProtos: []string{"http/1.1"}})
			tlsCtx, cancelTLS := context.WithTimeout(ctx, tlsTimeout)
			defer cancelTLS()
			if err := tlsConn.HandshakeContext(tlsCtx); err != nil {
				return nil, &phaseError{code: tlsFailed, cause: errors.Join(err, conn.Close())}
			}
			return tlsConn, nil
		},
	}
}
