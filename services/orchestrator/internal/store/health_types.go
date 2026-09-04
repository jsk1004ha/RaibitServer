package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"time"
)

const (
	PublicHealthObserve     = "public-health-observe"
	HealthLeaseDuration     = 30 * time.Second
	HealthRenewInterval     = 10 * time.Second
	HealthObservationWindow = 180 * time.Second
)

var (
	ErrHealthLeaseLost   = errors.New("public health lease ownership lost")
	ErrHealthObservation = errors.New("invalid public health observation")
)

type HealthStore interface {
	CompleteRollout(context.Context, RolloutCompletion) (*Deployment, error)
	ClaimNextHealth(context.Context, ClaimOptions) (*HealthJob, error)
	RenewHealthLease(context.Context, HealthLease, time.Time) error
	FinishHealth(context.Context, HealthCompletion) error
	CancelHealth(context.Context, HealthLease, time.Time) error
}

type RolloutCompletion struct {
	Lease         DeploymentLease
	Now           time.Time
	Observation   *HealthObservation
	ImageURL      string
	LeaseDuration time.Duration
	PreviewOwned  []PreviewOwnedObject
}

type HealthObservation struct {
	Version            int       `json:"version"`
	ProjectID          string    `json:"projectId"`
	ServiceID          string    `json:"serviceId"`
	DeploymentID       string    `json:"deploymentId"`
	Namespace          string    `json:"namespace"`
	WorkloadName       string    `json:"workloadName"`
	WorkloadUID        string    `json:"workloadUid"`
	GeneratedHost      string    `json:"generatedHost"`
	EffectivePath      string    `json:"effectivePath"`
	RolloutAttempt     int       `json:"rolloutAttempt"`
	ObservedGeneration int       `json:"observedGeneration"`
	AbsoluteDeadline   time.Time `json:"absoluteDeadline"`
	Public             bool      `json:"public"`
}

type HealthJob struct {
	DeploymentType    string
	PullRequestNumber int
	PreviewLineageID  string
	PreviewGeneration int
	PreviewRuntime    json.RawMessage
	ID                string
	Payload           HealthObservation
	Attempts          int
	LockedBy          string
	LeaseExpiresAt    time.Time
}

func (job *HealthJob) Lease() HealthLease {
	return HealthLease{JobID: job.ID, WorkerID: job.LockedBy, Attempt: job.Attempts}
}

type HealthLease struct {
	JobID, WorkerID string
	Attempt         int
}

type HealthCompletion struct {
	Lease               HealthLease
	Now                 time.Time
	Status, FailureCode string
	Retryable           bool
}

func healthJobID(p HealthObservation) string {
	tuple := "public-health-observe:v1"
	for _, value := range []string{p.DeploymentID, strconv.Itoa(p.RolloutAttempt), p.WorkloadUID, strconv.Itoa(p.ObservedGeneration)} {
		tuple += ":" + strconv.Itoa(len(value)) + ":" + value
	}
	digest := sha256.Sum256([]byte(tuple))
	return hex.EncodeToString(digest[:])
}

func healthClock(at time.Time) time.Time {
	if at.IsZero() {
		return time.Now().UTC().Truncate(time.Millisecond)
	}
	return at.UTC().Truncate(time.Millisecond)
}

func healthOutcome(job HealthJob, result HealthCompletion) (string, string, string, time.Time) {
	if !result.Now.Before(job.Payload.AbsoluteDeadline) {
		return "failed", "DEGRADED", "PUBLIC_HEALTH_TIMEOUT", result.Now
	}
	if result.Status == "HEALTHY" {
		return "succeeded", "HEALTHY", "", result.Now
	}
	delay := 5 * time.Second
	if job.Attempts >= 2 {
		delay = 15 * time.Second
	}
	if result.Retryable && job.Attempts < 3 && result.Now.Add(delay).Before(job.Payload.AbsoluteDeadline) {
		return "queued", "CHECKING", "", result.Now.Add(delay)
	}
	return "failed", "DEGRADED", result.FailureCode, result.Now
}

func validHealthResult(result HealthCompletion) bool {
	switch result.Status {
	case "HEALTHY":
		return result.FailureCode == "" && !result.Retryable
	case "DEGRADED":
		switch result.FailureCode {
		case "PUBLIC_HEALTH_INVALID_TARGET", "PUBLIC_HEALTH_DNS_FAILED", "PUBLIC_HEALTH_UNSAFE_ADDRESS", "PUBLIC_HEALTH_CONNECT_FAILED", "PUBLIC_HEALTH_TLS_FAILED", "PUBLIC_HEALTH_TIMEOUT", "PUBLIC_HEALTH_REDIRECT", "PUBLIC_HEALTH_HTTP_STATUS", "PUBLIC_HEALTH_RESPONSE_TOO_LARGE", "PUBLIC_HEALTH_CANCELLED":
			return true
		}
	}
	return false
}
