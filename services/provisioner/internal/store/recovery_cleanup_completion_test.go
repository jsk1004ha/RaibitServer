package store

import (
	"sync"
	"testing"
	"time"
)

func TestRecoveryPostgresCleanupRemoteCompletionIsExactAtomicAndIdempotent(t *testing.T) {
	// Given a failed backup with an exact PREPARED descriptor and live cleanup claim.
	f := recoveryDBWithID(t, "018f47a2-3d91-7c62-a4b8-91e562a94031")
	f.backup(t)
	f.job(t)
	workerClaim := f.claim(t)
	artifact := f.candidate(t, workerClaim)
	if err := f.s.FailRecovery(f.ctx, workerClaim); err != nil {
		t.Fatal(err)
	}
	cleanup, err := f.s.ClaimRecoveryCleanup(f.ctx, workerClaim.Identity(), "cleanup")
	if err != nil {
		t.Fatal(err)
	}

	// When any cleanup identity or durable candidate field differs.
	mismatches := []struct {
		name   string
		mutate func(*RecoveryArtifact)
	}{
		{"organization", func(a *RecoveryArtifact) { a.OrganizationID = "other" }},
		{"resource", func(a *RecoveryArtifact) { a.ResourceID = "other" }},
		{"backup", func(a *RecoveryArtifact) { a.BackupID = "other" }},
		{"key version", func(a *RecoveryArtifact) { a.KeyVersion = "other" }},
		{"attempt", func(a *RecoveryArtifact) { a.Attempt++ }},
		{"first claim", func(a *RecoveryArtifact) { a.FirstClaimAt = a.FirstClaimAt.Add(time.Millisecond) }},
		{"stored bytes", func(a *RecoveryArtifact) { a.StoredBytes++ }},
		{"plaintext bytes", func(a *RecoveryArtifact) { a.PlaintextBytes++ }},
		{"checksum", func(a *RecoveryArtifact) { a.SHA256[0]++ }},
	}
	for _, mismatch := range mismatches {
		t.Run(mismatch.name, func(t *testing.T) {
			other := artifact
			mismatch.mutate(&other)
			if err := f.s.RecordRecoveryCleanupRemoteCompletion(f.ctx, cleanup, other); err == nil {
				t.Fatal("mismatched completion was accepted")
			}
		})
	}
	wrongToken := cleanup
	wrongToken.token = "wrong"
	if err := f.s.RecordRecoveryCleanupRemoteCompletion(f.ctx, wrongToken, artifact); err == nil {
		t.Fatal("wrong cleanup token was accepted")
	}
	wrongWorker := cleanup
	wrongWorker.worker = "other"
	if err := f.s.RecordRecoveryCleanupRemoteCompletion(f.ctx, wrongWorker, artifact); err == nil {
		t.Fatal("wrong cleanup worker was accepted")
	}
	wrongOperation := cleanup
	wrongOperation.operationID = "118f47a2-3d91-7c62-a4b8-91e562a94031"
	if err := f.s.RecordRecoveryCleanupRemoteCompletion(f.ctx, wrongOperation, artifact); err == nil {
		t.Fatal("wrong cleanup operation was accepted")
	}
	if err := f.s.RecordRecoveryCleanupRemoteCompletion(f.ctx, cleanup, RecoveryArtifact{}); err == nil {
		t.Fatal("partial completion was accepted")
	}
	var beforeState, beforeKey, beforeChecksum string
	var beforeStored, beforePlaintext int64
	var beforeUpdatedAt time.Time
	if err := f.s.db.QueryRowContext(f.ctx, `SELECT state,"keyVersion","candidateStoredBytes","candidatePlaintextBytes","candidateChecksum","updatedAt" FROM "ResourceRecoveryAttempt" WHERE "backupId"=$1 AND attempt=1`, f.id).Scan(&beforeState, &beforeKey, &beforeStored, &beforePlaintext, &beforeChecksum, &beforeUpdatedAt); err != nil {
		t.Fatal(err)
	}
	if beforeState != "PREPARED" || beforeKey != artifact.KeyVersion || beforeStored != artifact.StoredBytes || beforePlaintext != artifact.PlaintextBytes {
		t.Fatal("rejected completion mutated the durable candidate")
	}

	// A newly active restore parent and an expired cleanup lease must also fail closed.
	restoreID := f.restore(t)
	if err := f.s.RecordRecoveryCleanupRemoteCompletion(f.ctx, cleanup, artifact); err == nil {
		t.Fatal("active restore allowed remote completion persistence")
	}
	assertPreparedUnchanged(t, f, beforeUpdatedAt)
	f.exec(t, `UPDATE "ResourceRestore" SET status='FAILED' WHERE id=$1`, restoreID)
	f.exec(t, `UPDATE "WorkflowJob" SET status='failed' WHERE "targetId"=$1`, restoreID)
	f.exec(t, `DELETE FROM "ResourceRecoveryPin" WHERE "restoreId"=$1`, restoreID)
	f.exec(t, `UPDATE "ResourceBackup" SET "cleanupLeaseUntil"=CURRENT_TIMESTAMP-interval '1 second' WHERE id=$1`, f.id)
	if err := f.s.RecordRecoveryCleanupRemoteCompletion(f.ctx, cleanup, artifact); err == nil {
		t.Fatal("expired cleanup claim was accepted")
	}
	assertPreparedUnchanged(t, f, beforeUpdatedAt)
	cleanup, err = f.s.ClaimRecoveryCleanup(f.ctx, workerClaim.Identity(), "cleanup-next")
	if err != nil {
		t.Fatal(err)
	}

	// Two callbacks racing on the same witness must both observe success.
	errs := make(chan error, 2)
	var start sync.WaitGroup
	start.Add(1)
	for range 2 {
		go func() {
			start.Wait()
			errs <- f.s.RecordRecoveryCleanupRemoteCompletion(f.ctx, cleanup, artifact)
		}()
	}
	start.Done()
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}

	// Then only PREPARED -> COMPLETE occurred; publication, job and pin are unchanged.
	var state, backupStatus, jobStatus, key, checksum string
	var stored, plaintext int64
	var sourcePinned bool
	var completedAt time.Time
	if err := f.s.db.QueryRowContext(f.ctx, `SELECT a.state,b.status,j.status,a."keyVersion",a."candidateStoredBytes",a."candidatePlaintextBytes",a."candidateChecksum",a."updatedAt",EXISTS(SELECT 1 FROM "ResourceRecoveryPin" WHERE "backupId"=b.id AND kind='ARTIFACT_SOURCE') FROM "ResourceRecoveryAttempt" a JOIN "ResourceBackup" b ON b.id=a."backupId" JOIN "WorkflowJob" j ON j."targetId"=b.id AND j.type='resource.backup' WHERE b.id=$1 AND a.attempt=1`, f.id).Scan(&state, &backupStatus, &jobStatus, &key, &stored, &plaintext, &checksum, &completedAt, &sourcePinned); err != nil {
		t.Fatal(err)
	}
	if state != "COMPLETE" || backupStatus != "DELETING" || jobStatus != "failed" || !sourcePinned || key != beforeKey || stored != beforeStored || plaintext != beforePlaintext || checksum != beforeChecksum {
		t.Fatal("completion changed publication, job, pin, or immutable descriptor")
	}
	if err := f.s.RecordRecoveryCleanupRemoteCompletion(f.ctx, cleanup, artifact); err != nil {
		t.Fatal(err)
	}
	var replayedAt time.Time
	if err := f.s.db.QueryRowContext(f.ctx, `SELECT "updatedAt" FROM "ResourceRecoveryAttempt" WHERE "backupId"=$1 AND attempt=1`, f.id).Scan(&replayedAt); err != nil || !replayedAt.Equal(completedAt) {
		t.Fatalf("COMPLETE replay was not mutation-free: %v", err)
	}
	f.exec(t, `UPDATE "ResourceRecoveryAttempt" SET state='VERIFIED' WHERE "backupId"=$1 AND attempt=1`, f.id)
	if err := f.s.RecordRecoveryCleanupRemoteCompletion(f.ctx, cleanup, artifact); err != nil {
		t.Fatal(err)
	}
	var verifiedReplayAt time.Time
	if err := f.s.db.QueryRowContext(f.ctx, `SELECT "updatedAt" FROM "ResourceRecoveryAttempt" WHERE "backupId"=$1 AND attempt=1`, f.id).Scan(&verifiedReplayAt); err != nil || !verifiedReplayAt.Equal(completedAt) {
		t.Fatalf("VERIFIED replay was not mutation-free: %v", err)
	}
}

func assertPreparedUnchanged(t *testing.T, f recoveryFixture, updatedAt time.Time) {
	t.Helper()
	var state string
	var gotUpdatedAt time.Time
	if err := f.s.db.QueryRowContext(f.ctx, `SELECT state,"updatedAt" FROM "ResourceRecoveryAttempt" WHERE "backupId"=$1 AND attempt=1`, f.id).Scan(&state, &gotUpdatedAt); err != nil {
		t.Fatal(err)
	}
	if state != "PREPARED" || !gotUpdatedAt.Equal(updatedAt) {
		t.Fatal("rejected completion mutated the prepared attempt")
	}
}
