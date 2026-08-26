package worker

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"syscall"
	"testing"
)

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
