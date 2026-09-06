package controlplane

import (
	"context"
	"errors"
	"time"
)

const (
	PreviewResolveJobType = "github.preview-resolve"
	PreviewApplyJobType   = "github.preview-apply"
	PreviewTargetType     = "preview-lineage"
	PreviewLeaseDuration  = 60 * time.Second
	PreviewHeartbeat      = 20 * time.Second
	PreviewMaxAttempts    = 3
	PreviewDeadline       = 5 * time.Minute

	PreviewErrorAuth     = "GITHUB_PREVIEW_AUTH"
	PreviewErrorFetch    = "GITHUB_PREVIEW_FETCH"
	PreviewErrorInvalid  = "GITHUB_PREVIEW_INVALID"
	PreviewErrorDeadline = "GITHUB_PREVIEW_DEADLINE"
)

var ErrPreviewResolutionLeaseLost = errors.New("preview resolution lease ownership lost")

type PreviewResolutionClaim struct {
	Target     PreviewResolutionTarget
	JobID      string
	WorkerID   string
	Attempt    int
	ClaimToken string
	DeadlineAt time.Time
}

type PreviewResolverStore interface {
	ClaimNextPreviewResolution(context.Context, string, time.Time) (*PreviewResolutionClaim, error)
	RenewPreviewResolutionLease(context.Context, PreviewResolutionClaim, time.Time) error
	CommitPreviewResolution(context.Context, PreviewResolutionClaim, PreviewResolutionObservation, time.Time) (bool, error)
	FailPreviewResolution(context.Context, PreviewResolutionClaim, string, time.Time) error
}
