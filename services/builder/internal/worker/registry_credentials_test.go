package worker

import (
	"bytes"
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"testing"
	"time"
)

type registryCredentialRoundTripFunc func(*http.Request) (*http.Response, error)

func (function registryCredentialRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestRequestRegistryCredentialRetriesOnlyTransientConnectivity(t *testing.T) {
	payload := []byte(`{"repository":"registry.example.test/team/service"}`)
	attempts := 0
	client := &http.Client{Transport: registryCredentialRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		attempts++
		if request.Header.Get("Authorization") != "Bearer broker-token" {
			t.Fatalf("missing broker authorization on attempt %d", attempts)
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(body, payload) {
			t.Fatalf("request body changed on attempt %d: %q", attempts, body)
		}
		if attempts == 1 {
			return nil, fmt.Errorf("dial broker: %w", syscall.ECONNREFUSED)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
			Header:     make(http.Header),
			Request:    request,
		}, nil
	})}

	response, err := requestRegistryCredential(context.Background(), client, "https://broker.example.test/credentials", "broker-token", payload)
	if err != nil {
		t.Fatalf("transient request did not recover: %v", err)
	}
	defer response.Body.Close()
	if attempts != 2 {
		t.Fatalf("expected one retry, got %d attempts", attempts)
	}

	attempts = 0
	client.Transport = registryCredentialRoundTripFunc(func(_ *http.Request) (*http.Response, error) {
		attempts++
		return nil, x509.UnknownAuthorityError{}
	})
	_, err = requestRegistryCredential(context.Background(), client, "https://broker.example.test/credentials", "broker-token", payload)
	if err == nil || err.Error() != "registry credential broker TLS certificate validation failed" {
		t.Fatalf("expected permanent TLS failure, got %v", err)
	}
	if attempts != 1 {
		t.Fatalf("permanent TLS failure was retried %d times", attempts)
	}
}

func TestRequestRegistryCredentialRetriesTemporaryDNS(t *testing.T) {
	attempts := 0
	client := &http.Client{Transport: registryCredentialRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		attempts++
		if attempts == 1 {
			return nil, &net.DNSError{Err: "server misbehaving", Name: "broker.example.test", IsTemporary: true}
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
			Header:     make(http.Header),
			Request:    request,
		}, nil
	})}

	response, err := requestRegistryCredentialWithRetry(
		context.Background(), client, "https://broker.example.test/credentials", "broker-token", []byte(`{}`), time.Millisecond, time.Millisecond,
	)
	if err != nil {
		t.Fatalf("temporary DNS failure did not recover: %v", err)
	}
	defer response.Body.Close()
	if attempts != 2 {
		t.Fatalf("expected one DNS retry, got %d attempts", attempts)
	}
}

func TestRequestRegistryCredentialBoundsRetriesAndHonorsCancellation(t *testing.T) {
	t.Run("maximum attempts", func(t *testing.T) {
		attempts := 0
		client := &http.Client{Transport: registryCredentialRoundTripFunc(func(_ *http.Request) (*http.Response, error) {
			attempts++
			return nil, &net.DNSError{Err: "server misbehaving", Name: "broker.example.test", IsTemporary: true}
		})}

		_, err := requestRegistryCredentialWithRetry(
			context.Background(), client, "https://broker.example.test/credentials", "broker-token", []byte(`{}`), time.Millisecond, time.Millisecond,
		)
		if err == nil || err.Error() != "registry credential broker DNS lookup failed" {
			t.Fatalf("expected classified DNS failure, got %v", err)
		}
		if attempts != registryBrokerMaxAttempts {
			t.Fatalf("expected %d attempts, got %d", registryBrokerMaxAttempts, attempts)
		}
	})

	t.Run("context cancellation", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		attempts := 0
		client := &http.Client{Transport: registryCredentialRoundTripFunc(func(_ *http.Request) (*http.Response, error) {
			attempts++
			cancel()
			return nil, fmt.Errorf("dial broker: %w", syscall.ECONNREFUSED)
		})}

		_, err := requestRegistryCredentialWithRetry(
			ctx, client, "https://broker.example.test/credentials", "broker-token", []byte(`{}`), time.Hour, time.Hour,
		)
		if err == nil || err.Error() != "registry credential broker request was canceled" {
			t.Fatalf("expected cancellation, got %v", err)
		}
		if attempts != 1 {
			t.Fatalf("canceled request retried %d times", attempts)
		}
	})
}

func TestClassifyRegistryCredentialBrokerTransportError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{
			name: "redirect",
			err:  &url.Error{Op: "Post", URL: "https://secret.example.test/broker", Err: errRegistryCredentialBrokerRedirect},
			want: "registry credential broker redirects are not allowed",
		},
		{
			name: "timeout",
			err:  fmt.Errorf("request: %w", context.DeadlineExceeded),
			want: "registry credential broker request timed out",
		},
		{
			name: "dns",
			err: &url.Error{
				Op:  "Post",
				URL: "https://secret.example.test/broker",
				Err: &net.DNSError{Err: "no such host", Name: "secret.example.test"},
			},
			want: "registry credential broker DNS lookup failed",
		},
		{
			name: "certificate",
			err:  &url.Error{Op: "Post", URL: "https://secret.example.test/broker", Err: x509.UnknownAuthorityError{}},
			want: "registry credential broker TLS certificate validation failed",
		},
		{
			name: "refused",
			err:  fmt.Errorf("dial: %w", syscall.ECONNREFUSED),
			want: "registry credential broker connection was refused",
		},
		{
			name: "unreachable",
			err:  fmt.Errorf("dial: %w", syscall.ENETUNREACH),
			want: "registry credential broker network is unreachable",
		},
		{
			name: "generic",
			err:  errors.New("secret transport details"),
			want: "registry credential broker transport failed",
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			got := classifyRegistryCredentialBrokerTransportError(testCase.err)
			if got.Error() != testCase.want {
				t.Fatalf("classification mismatch: got %q want %q", got, testCase.want)
			}
			if strings.Contains(got.Error(), "secret") {
				t.Fatalf("classified error leaked transport details: %q", got)
			}
		})
	}
}
