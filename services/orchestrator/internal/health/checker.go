// Package health observes one restricted public HTTPS endpoint per attempt.
package health

import (
	"context"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"time"
)

type Request struct {
	Hostname string
	Path     string
	Deadline time.Time
}

type Result struct {
	Status      string
	FailureCode string
	Retryable   bool
}

type Checker interface {
	Check(context.Context, Request) Result
}

type failureCode string

const (
	invalidTarget    failureCode = "PUBLIC_HEALTH_INVALID_TARGET"
	dnsFailed        failureCode = "PUBLIC_HEALTH_DNS_FAILED"
	unsafeAddress    failureCode = "PUBLIC_HEALTH_UNSAFE_ADDRESS"
	connectFailed    failureCode = "PUBLIC_HEALTH_CONNECT_FAILED"
	tlsFailed        failureCode = "PUBLIC_HEALTH_TLS_FAILED"
	timeout          failureCode = "PUBLIC_HEALTH_TIMEOUT"
	redirect         failureCode = "PUBLIC_HEALTH_REDIRECT"
	httpStatus       failureCode = "PUBLIC_HEALTH_HTTP_STATUS"
	responseTooLarge failureCode = "PUBLIC_HEALTH_RESPONSE_TOO_LARGE"
	cancelled        failureCode = "PUBLIC_HEALTH_CANCELLED"
	attemptTimeout               = 15 * time.Second
	dnsTimeout                   = 2 * time.Second
	connectTimeout               = 3 * time.Second
	tlsTimeout                   = 3 * time.Second
	headerTimeout                = 3 * time.Second
	bodyTimeout                  = 2 * time.Second
	maxBodyBytes                 = 64 * 1024
	maxHeaderBytes               = 16 * 1024
)

type httpsChecker struct {
	lookup func(context.Context, string, string) ([]netip.Addr, error)
	dial   func(context.Context, string, string) (net.Conn, error)
	roots  *x509.CertPool
}

// NewChecker has no proxy, trust override, or tenant-configurable transport knobs.
func NewChecker() Checker {
	resolver := &net.Resolver{PreferGo: true, StrictErrors: true}
	dialer := &net.Dialer{Timeout: connectTimeout, KeepAlive: -1}
	return &httpsChecker{lookup: resolver.LookupNetIP, dial: dialer.DialContext}
}

func failure(code failureCode, retryable bool) Result {
	return Result{Status: "DEGRADED", FailureCode: string(code), Retryable: retryable}
}

func failureFor(err error, fallback failureCode) Result {
	var netError net.Error
	var phase *phaseError
	switch {
	case errors.Is(err, context.Canceled):
		return failure(cancelled, false)
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &netError) && netError.Timeout():
		return failure(timeout, true)
	case errors.As(err, &phase):
		return failure(phase.code, phase.code == connectFailed)
	default:
		return failure(fallback, true)
	}
}

func (c *httpsChecker) Check(ctx context.Context, request Request) (result Result) {
	target, valid := parseTarget(request)
	if !valid || request.Deadline.IsZero() {
		return failure(invalidTarget, false)
	}
	deadlineCtx, cancelDeadline := context.WithDeadline(ctx, request.Deadline)
	defer cancelDeadline()
	attemptCtx, cancelAttempt := context.WithTimeout(deadlineCtx, attemptTimeout)
	defer cancelAttempt()
	if err := attemptCtx.Err(); err != nil {
		return failureFor(err, timeout)
	}
	dnsCtx, cancelDNS := context.WithTimeout(attemptCtx, dnsTimeout)
	// A trailing root label prevents resolver search-domain expansion.
	ips, err := c.lookup(dnsCtx, "ip", target.hostname+".")
	cancelDNS()
	if err != nil {
		return failureFor(err, dnsFailed)
	}
	if len(ips) == 0 {
		return failure(dnsFailed, true)
	}
	for _, ip := range ips {
		if !publicAddress(ip) {
			return failure(unsafeAddress, false)
		}
	}
	transport := c.transport(target.hostname, ips[0])
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(attemptCtx, http.MethodGet, "https://"+target.hostname+target.path, nil)
	if err != nil {
		return failure(invalidTarget, false)
	}
	response, err := client.Do(req)
	if err != nil {
		return failureFor(err, connectFailed)
	}
	defer func() {
		if err := response.Body.Close(); err != nil && result.Status == "HEALTHY" {
			result = failureFor(err, connectFailed)
		}
	}()
	switch {
	case response.StatusCode >= 300 && response.StatusCode < 400:
		return failure(redirect, false)
	case response.StatusCode < 200 || response.StatusCode >= 300:
		return failure(httpStatus, response.StatusCode >= 500 || response.StatusCode == 429)
	case response.ContentLength > maxBodyBytes:
		return failure(responseTooLarge, false)
	}
	bodyCtx, cancelBody := context.WithTimeout(attemptCtx, bodyTimeout)
	defer cancelBody()
	stop := context.AfterFunc(bodyCtx, cancelAttempt)
	defer stop()
	count, readErr := io.Copy(io.Discard, io.LimitReader(response.Body, maxBodyBytes+1))
	if count > maxBodyBytes {
		return failure(responseTooLarge, false)
	}
	if err := bodyCtx.Err(); err != nil {
		return failureFor(err, timeout)
	}
	if readErr != nil {
		return failureFor(readErr, connectFailed)
	}
	return Result{Status: "HEALTHY"}
}
