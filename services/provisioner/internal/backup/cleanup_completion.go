package backup

import (
	"context"
	"errors"
	"io"
)

// RemoteWriteState describes positive completion evidence, not worker liveness.
// A nil state is unknown. Neither INTENT nor UPLOADING proves remote completion.
type RemoteWriteState interface{ remoteWriteState() }

type UnknownRemoteWrite struct{}

func (UnknownRemoteWrite) remoteWriteState() {}

// PreparedRemoteWrite has a durable descriptor, but Complete may still be running.
type PreparedRemoteWrite struct{ Candidate Candidate }

func (PreparedRemoteWrite) remoteWriteState() {}

// RemoteCompletion witnesses the sole Complete request's successful processing
// (parsed SDK response or full authenticated readback). It is NOT READY authority.
// This requires atomic S3 completion/object visibility, one Create/Complete per
// attempt, disabled SDK retries, and exclusive writes to the attempt key.
type RemoteCompletion struct{ record ArtifactRecord }

func (RemoteCompletion) remoteWriteState()        {}
func (r RemoteCompletion) Record() ArtifactRecord { return r.record }

// ParseRemoteCompletion rehydrates ONLY trusted server-owned COMPLETE/VERIFIED
// rows recorded from this module's callback. A valid descriptor alone is NOT
// evidence: never call this for INTENT, UPLOADING, PREPARED, or client input.
func ParseRemoteCompletion(record ArtifactRecord) (RemoteCompletion, error) {
	if _, err := ParseCandidate(record); err != nil {
		return RemoteCompletion{}, err
	}
	return RemoteCompletion{record: record}, nil
}

func (s *Service) resolveCleanupCompletion(ctx context.Context, req CleanupRequest, journal CleanupAuthorizer) error {
	switch remote := req.Remote.(type) {
	case nil, UnknownRemoteWrite:
		return ErrCleanupPending
	case RemoteCompletion:
		if _, err := ParseRemoteCompletion(remote.record); err != nil {
			return errors.Join(ErrCleanupPending, err)
		}
		if remote.record.Attempt != req.Attempt.spec {
			return errors.Join(ErrCleanupPending, ErrIdentity)
		}
		return nil
	case PreparedRemoteWrite:
		if remote.Candidate.record.Attempt != req.Attempt.spec {
			return errors.Join(ErrCleanupPending, ErrIdentity)
		}
		// Cleanup can occur after the original upload deadline. The caller's
		// bounded cleanup context, not a renewed upload lease, owns this read.
		verified, err := s.Readback(ctx, remote.Candidate, discardSink{Writer: io.Discard})
		if err != nil {
			return errors.Join(ErrCleanupPending, err)
		}
		// Persist before the first mutation, including abort: a crash or rejected
		// callback must never erase the sole witness and strand PREPARED forever.
		if err := journal.RecordRemoteCompletion(ctx, RemoteCompletion{record: verified.record}); err != nil {
			return errors.Join(ErrCleanupPending, ErrFence)
		}
		return nil
	default:
		return errors.Join(ErrCleanupPending, ErrConfig)
	}
}
