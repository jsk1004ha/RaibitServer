package backup

import (
	"context"
	"io"

	"github.com/raibitserver/provisioner/internal/store"
	"golang.org/x/sync/errgroup"
)

func (l *RecoveryLifecycle) restore(ctx context.Context, work RecoveryWork) error {
	if work.Target == nil || !work.Execution.TargetPrepared {
		return ErrRecoveryRequest
	}
	attempts, err := l.state.ReadRecoveryAttempts(ctx, work.Claim)
	if err != nil {
		return err
	}
	candidate, err := verifiedRecoveryCandidate(attempts)
	if err != nil {
		return err
	}
	verified, err := l.artifacts.Readback(ctx, candidate, discardSink{Writer: io.Discard})
	if err != nil {
		return err
	}
	artifact, err := l.binding.rehydrator.Rehydrate(work.Source, verified)
	if err != nil {
		return err
	}
	request, err := NewRestoreRequest(work.Source, *work.Target, artifact, NewMajorVersionCompatibility(artifact.Format()))
	if err != nil {
		return err
	}
	reader, writer := io.Pipe()
	handoff, err := NewRestoreHandoff(ctx, reader, candidate.record.PlaintextBytes)
	if err != nil {
		_ = writer.Close()
		return err
	}
	var receipt VerificationReceipt
	group, groupCtx := errgroup.WithContext(ctx)
	group.SetLimit(2)
	group.Go(func() error {
		var restoreErr error
		receipt, restoreErr = l.binding.adapter.Restore(groupCtx, request, handoff, work.Runner)
		return restoreErr
	})
	group.Go(func() error {
		_, readErr := l.artifacts.Readback(groupCtx, candidate, writer)
		return readErr
	})
	if err = group.Wait(); err != nil {
		return err
	}
	if receipt.Target().ResourceID() != work.Target.ResourceID() || receipt.Artifact().Record() != artifact.Record() {
		return ErrRecoveryRequest
	}
	if err = l.state.FenceRecovery(ctx, work.Claim); err != nil {
		return err
	}
	if err = l.state.StartRestoreVerification(ctx, work.Claim); err != nil {
		return err
	}
	return l.state.FinishRecovery(ctx, work.Claim)
}

func verifiedRecoveryCandidate(attempts []store.RecoveryAttempt) (Candidate, error) {
	var result Candidate
	found := false
	for _, attempt := range attempts {
		if attempt.State != "VERIFIED" {
			continue
		}
		if found {
			return Candidate{}, ErrRecoveryRequest
		}
		candidate, err := ParseCandidate(artifactRecord(attempt.Artifact))
		if err != nil {
			return Candidate{}, err
		}
		result, found = candidate, true
	}
	if !found {
		return Candidate{}, ErrRecoveryRequest
	}
	return result, nil
}
