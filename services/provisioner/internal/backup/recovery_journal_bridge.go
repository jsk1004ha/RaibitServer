package backup

import (
	"context"
	"errors"

	"github.com/raibitserver/provisioner/internal/store"
)

type recoveryJournalBridge struct {
	state store.RecoveryStore
	claim store.RecoveryClaim
}

func (b recoveryJournalBridge) RecordIntent(ctx context.Context, attempt Attempt) error {
	recorded, err := b.state.RecordRecoveryIntent(ctx, b.claim, attempt.spec.KeyVersion)
	if err != nil {
		return journalError(err)
	}
	if artifactRecord(recorded.Artifact).Attempt != attempt.spec {
		return ErrFence
	}
	return nil
}

func (b recoveryJournalBridge) RecordUpload(ctx context.Context, upload Upload) error {
	return journalError(b.state.RecordRecoveryUpload(ctx, b.claim, upload.UploadID))
}

func (b recoveryJournalBridge) RecordCandidate(ctx context.Context, candidate Candidate) error {
	return journalError(b.state.RecordRecoveryCandidate(ctx, b.claim, storeArtifact(candidate.record)))
}

func (b recoveryJournalBridge) RecordRemoteCompletion(ctx context.Context, _ RemoteCompletion) error {
	return journalError(b.state.RecordRecoveryComplete(ctx, b.claim))
}

func (b recoveryJournalBridge) Fence(ctx context.Context, _ Attempt) error {
	return journalError(b.state.FenceRecovery(ctx, b.claim))
}

type recoveryCleanupBridge struct {
	state store.RecoveryStore
	claim store.RecoveryCleanupClaim
}

func (b recoveryCleanupBridge) AuthorizeCleanup(ctx context.Context, _ Attempt) error {
	return journalError(b.state.FenceRecoveryCleanup(ctx, b.claim))
}

func (b recoveryCleanupBridge) RecordRemoteCompletion(ctx context.Context, completion RemoteCompletion) error {
	return journalError(b.state.RecordRecoveryCleanupRemoteCompletion(ctx, b.claim, storeArtifact(completion.record)))
}

func journalError(err error) error {
	if errors.Is(err, store.ErrRecoveryFence) {
		return errors.Join(ErrFence, err)
	}
	return err
}

func storeArtifact(record ArtifactRecord) store.RecoveryArtifact {
	return store.RecoveryArtifact{OrganizationID: record.Attempt.OrganizationID, ResourceID: record.Attempt.ResourceID, BackupID: record.Attempt.BackupID, KeyVersion: record.Attempt.KeyVersion, Attempt: record.Attempt.Number, FirstClaimAt: record.Attempt.FirstClaimAt, StoredBytes: record.StoredBytes, PlaintextBytes: record.PlaintextBytes, SHA256: record.SHA256}
}

func artifactRecord(value store.RecoveryArtifact) ArtifactRecord {
	return ArtifactRecord{Attempt: AttemptSpec{OrganizationID: value.OrganizationID, ResourceID: value.ResourceID, BackupID: value.BackupID, KeyVersion: value.KeyVersion, Number: value.Attempt, FirstClaimAt: value.FirstClaimAt}, StoredBytes: value.StoredBytes, PlaintextBytes: value.PlaintextBytes, SHA256: value.SHA256}
}

func cleanupRequest(value store.RecoveryAttempt) (CleanupRequest, error) {
	attempt, err := NewAttempt(artifactRecord(value.Artifact).Attempt)
	if err != nil {
		return CleanupRequest{}, err
	}
	request := CleanupRequest{Attempt: attempt, UploadID: value.UploadID, Remote: UnknownRemoteWrite{}}
	switch value.State {
	case "PREPARED":
		candidate, parseErr := ParseCandidate(artifactRecord(value.Artifact))
		if parseErr != nil {
			return CleanupRequest{}, parseErr
		}
		request.Remote = PreparedRemoteWrite{Candidate: candidate}
	case "COMPLETE", "VERIFIED":
		completion, parseErr := ParseRemoteCompletion(artifactRecord(value.Artifact))
		if parseErr != nil {
			return CleanupRequest{}, parseErr
		}
		request.Remote = completion
	case "INTENT", "UPLOADING":
	default:
		return CleanupRequest{}, ErrRecoveryRequest
	}
	return request, nil
}
