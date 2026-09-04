package backup

import (
	"context"

	"github.com/raibitserver/provisioner/internal/store"
)

func (l *RecoveryLifecycle) Cleanup(ctx context.Context, identity store.RecoveryIdentity) error {
	if identity.Kind != store.RecoveryBackup {
		return ErrRecoveryRequest
	}
	claim, err := l.state.ClaimRecoveryCleanup(ctx, identity, "provisioner-recovery-cleanup")
	if err != nil {
		return err
	}
	if err = l.state.FenceRecoveryCleanup(ctx, claim); err != nil {
		return err
	}
	attempts, err := l.state.ReadRecoveryCleanup(ctx, claim)
	if err != nil {
		return err
	}
	bridge := recoveryCleanupBridge{state: l.state, claim: claim}
	for _, attempt := range attempts {
		if !attempt.CleanupPending {
			continue
		}
		request, requestErr := cleanupRequest(attempt)
		if requestErr != nil {
			return requestErr
		}
		result, cleanupErr := l.artifacts.Cleanup(ctx, request, bridge)
		if cleanupErr != nil {
			return cleanupErr
		}
		if !result.MultipartAbsent || !result.ObjectAbsent {
			return ErrCleanupPending
		}
		if err = l.state.MarkRecoveryAttemptCleaned(ctx, claim, attempt.Artifact.Attempt); err != nil {
			return err
		}
	}
	return l.state.FinishRecoveryCleanup(ctx, claim)
}
