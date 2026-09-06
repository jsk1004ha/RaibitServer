package backup

import (
	"context"
	"io"

	"golang.org/x/sync/errgroup"
)

func (l *RecoveryLifecycle) backup(ctx context.Context, work RecoveryWork) error {
	identity := work.Execution.Identity
	attempt, err := NewAttempt(AttemptSpec{OrganizationID: identity.OrganizationID, ResourceID: identity.SourceID, BackupID: identity.BackupID, KeyVersion: l.artifacts.CurrentKeyVersion(), Number: identity.Attempt, FirstClaimAt: identity.FirstClaimAt})
	if err != nil {
		return err
	}
	request, err := NewDumpRequest(work.Source, work.Source.Generation())
	if err != nil {
		return err
	}
	reader, writer := io.Pipe()
	handoff, err := NewDumpHandoff(ctx, writer, MaxStoredBytes)
	if err != nil {
		_ = reader.Close()
		return err
	}
	var dump DumpResult
	var candidate Candidate
	group, groupCtx := errgroup.WithContext(ctx)
	group.SetLimit(2)
	group.Go(func() error {
		var dumpErr error
		dump, dumpErr = l.binding.adapter.Dump(groupCtx, request, handoff, work.Runner)
		return dumpErr
	})
	group.Go(func() error {
		var uploadErr error
		candidate, uploadErr = l.artifacts.Upload(groupCtx, UploadRequest{Attempt: attempt, Source: reader}, recoveryJournalBridge{state: l.state, claim: work.Claim})
		return uploadErr
	})
	if err = group.Wait(); err != nil {
		return err
	}
	verified, err := l.artifacts.Verify(ctx, candidate)
	if err != nil {
		return err
	}
	if _, err = NewRecoveryArtifact(dump, verified); err != nil {
		return err
	}
	if err = l.state.FenceRecovery(ctx, work.Claim); err != nil {
		return err
	}
	if err = l.state.RecordRecoveryVerified(ctx, work.Claim); err != nil {
		return err
	}
	return l.state.FinishRecovery(ctx, work.Claim)
}
