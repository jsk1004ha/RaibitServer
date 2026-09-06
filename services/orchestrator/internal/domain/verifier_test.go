package domain

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"
)

type fixedResolver struct {
	answer TXTAnswer
	err    error
	name   string
}

func (r *fixedResolver) LookupTXT(ctx context.Context, name string) (TXTAnswer, error) {
	r.name = name
	if err := ctx.Err(); err != nil {
		return TXTAnswer{}, err
	}
	return r.answer, r.err
}

func TestDomainVerifierHappy(t *testing.T) {
	// Given
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	token := "fresh-token"
	digest := sha256.Sum256([]byte(token))
	resolver := &fixedResolver{answer: TXTAnswer{Records: []string{"raibit-verification=" + token}, Authoritative: true}}
	verifier := NewVerifier(resolver, func() time.Time { return now })

	// When
	result, err := verifier.Verify(t.Context(), Challenge{
		Hostname: "app.example.test", TokenHash: hex.EncodeToString(digest[:]),
		ExpiresAt: now.Add(-time.Hour), VerifiedAt: now.Add(-25 * time.Hour), ConsecutiveFailures: 2,
	})

	// Then
	if err != nil || result.Outcome != VerificationMatched || result.ConsecutiveFailures != 0 {
		t.Fatalf("result = %#v, err = %v", result, err)
	}
	if resolver.name != "_raibit-challenge.app.example.test" {
		t.Fatalf("lookup = %q", resolver.name)
	}
}

func TestDomainVerifierFailureMatrix(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	tokenDigest := sha256.Sum256([]byte("expected"))
	hash := hex.EncodeToString(tokenDigest[:])
	tests := []struct {
		name       string
		challenge  Challenge
		answer     TXTAnswer
		err        error
		outcome    VerificationOutcome
		failures   int
	}{
		{name: "expiry exact", challenge: Challenge{Hostname: "app.example.test", TokenHash: hash, ExpiresAt: now}, outcome: VerificationExpired},
		{name: "authoritative mismatch increments", challenge: Challenge{Hostname: "app.example.test", TokenHash: hash, ExpiresAt: now.Add(time.Hour), ConsecutiveFailures: 1}, answer: TXTAnswer{Records: []string{"raibit-verification=wrong"}, Authoritative: true}, outcome: VerificationFailed, failures: 2},
		{name: "third authoritative failure loses ownership", challenge: Challenge{Hostname: "app.example.test", TokenHash: hash, ExpiresAt: now.Add(time.Hour), VerifiedAt: now.Add(-time.Hour), ConsecutiveFailures: 2}, answer: TXTAnswer{Authoritative: true}, outcome: VerificationOwnershipLost, failures: 3},
		{name: "timeout retries without counting", challenge: Challenge{Hostname: "app.example.test", TokenHash: hash, ExpiresAt: now.Add(time.Hour), ConsecutiveFailures: 2}, err: ErrDNSRetryable, outcome: VerificationRetry, failures: 2},
		{name: "servfail retries without counting", challenge: Challenge{Hostname: "app.example.test", TokenHash: hash, ExpiresAt: now.Add(time.Hour), ConsecutiveFailures: 2}, err: errors.New("SERVFAIL"), outcome: VerificationRetry, failures: 2},
		{name: "missing token hash loses ownership", challenge: Challenge{Hostname: "app.example.test", ExpiresAt: now.Add(time.Hour), VerifiedAt: now.Add(-time.Hour)}, answer: TXTAnswer{Authoritative: true}, outcome: VerificationOwnershipLost, failures: 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Given
			verifier := NewVerifier(&fixedResolver{answer: tt.answer, err: tt.err}, func() time.Time { return now })

			// When
			result, err := verifier.Verify(context.Background(), tt.challenge)

			// Then
			if err != nil && !errors.Is(err, ErrDNSRetryable) {
				t.Fatalf("unexpected error: %v", err)
			}
			if result.Outcome != tt.outcome || result.ConsecutiveFailures != tt.failures {
				t.Fatalf("result = %#v", result)
			}
		})
	}
	t.Run("cancellation propagates", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		verifier := NewVerifier(&fixedResolver{}, func() time.Time { return now })
		_, err := verifier.Verify(ctx, Challenge{Hostname: "app.example.test", TokenHash: hash, ExpiresAt: now.Add(time.Hour)})
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v", err)
		}
	})
}
