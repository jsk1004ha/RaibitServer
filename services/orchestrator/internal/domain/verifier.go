package domain

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

const challengePrefix = "raibit-verification="

var ErrDNSRetryable = errors.New("DNS verification is retryable")

type TXTAnswer struct {
	Records       []string
	Authoritative bool
}

type TXTResolver interface {
	LookupTXT(context.Context, string) (TXTAnswer, error)
}

type Challenge struct {
	Hostname           string
	TokenHash          string
	ExpiresAt          time.Time
	VerifiedAt         time.Time
	ConsecutiveFailures int
}

type VerificationOutcome string

const (
	VerificationMatched       VerificationOutcome = "MATCHED"
	VerificationFailed        VerificationOutcome = "FAILED"
	VerificationRetry         VerificationOutcome = "RETRY"
	VerificationExpired       VerificationOutcome = "EXPIRED"
	VerificationOwnershipLost VerificationOutcome = "OWNERSHIP_LOST"
)

type Verification struct {
	Outcome             VerificationOutcome
	CheckedAt           time.Time
	ConsecutiveFailures int
}

type Verifier struct {
	resolver TXTResolver
	now      func() time.Time
}

func NewVerifier(resolver TXTResolver, now func() time.Time) *Verifier {
	return &Verifier{resolver: resolver, now: now}
}

func (v *Verifier) Verify(ctx context.Context, challenge Challenge) (Verification, error) {
	checkedAt := v.now().UTC()
	result := Verification{CheckedAt: checkedAt, ConsecutiveFailures: challenge.ConsecutiveFailures}
	if challenge.VerifiedAt.IsZero() && !checkedAt.Before(challenge.ExpiresAt) {
		result.Outcome = VerificationExpired
		return result, nil
	}

	answer, err := v.resolver.LookupTXT(ctx, "_raibit-challenge."+challenge.Hostname)
	if err != nil {
		result.Outcome = VerificationRetry
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return result, err
		}
		return result, nil
	}
	matched, err := matchesTokenHash(answer.Records, challenge.TokenHash)
	if err != nil {
		result.Outcome = VerificationOwnershipLost
		result.ConsecutiveFailures = 3
		return result, nil
	}
	if matched {
		result.Outcome = VerificationMatched
		result.ConsecutiveFailures = 0
		return result, nil
	}
	if !answer.Authoritative {
		result.Outcome = VerificationRetry
		return result, nil
	}
	result.ConsecutiveFailures++
	if result.ConsecutiveFailures >= 3 {
		result.Outcome = VerificationOwnershipLost
		return result, nil
	}
	result.Outcome = VerificationFailed
	return result, nil
}

func matchesTokenHash(records []string, storedHash string) (bool, error) {
	expected, err := hex.DecodeString(storedHash)
	if err != nil || len(expected) != sha256.Size {
		return false, errors.New("stored verification token hash is invalid")
	}
	for _, record := range records {
		if !strings.HasPrefix(record, challengePrefix) || len(record) == len(challengePrefix) {
			continue
		}
		digest := sha256.Sum256([]byte(strings.TrimPrefix(record, challengePrefix)))
		if subtle.ConstantTimeCompare(digest[:], expected) == 1 {
			return true, nil
		}
	}
	return false, nil
}
