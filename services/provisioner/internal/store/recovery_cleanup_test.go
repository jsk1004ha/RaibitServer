package store

import (
	"testing"
	"time"
)

func TestRecoveryPostgresCandidateImmutableAndOrderingStrict(t *testing.T) {
	// Given a claimed backup.
	f := recoveryDB(t)
	f.backup(t)
	f.job(t)
	c := f.claim(t)
	// When callbacks arrive without their durable predecessor or try to replace one.
	if err := f.s.RecordRecoveryUpload(f.ctx, c, "unrecorded"); err == nil {
		t.Fatal("upload before intent")
	}
	if err := f.s.RecordRecoveryComplete(f.ctx, c); err == nil {
		t.Fatal("complete before descriptor")
	}
	a := f.candidate(t, c)
	if _, err := f.s.RecordRecoveryIntent(f.ctx, c, "key2"); err == nil {
		t.Fatal("duplicate multipart create authorized")
	}
	if err := f.s.RecordRecoveryUpload(f.ctx, c, "other-upload"); err == nil {
		t.Fatal("immutable upload ID replaced")
	}
	a.StoredBytes++
	if err := f.s.RecordRecoveryCandidate(f.ctx, c, a); err == nil {
		t.Fatal("immutable candidate replaced")
	}
	if err := f.s.RecordRecoveryVerified(f.ctx, c); err == nil {
		t.Fatal("PREPARED treated as complete object")
	}
	// Then crash recovery can read the exact original provisional descriptor.
	records, err := f.s.ReadRecoveryAttempts(f.ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || records[0].State != "PREPARED" || records[0].Artifact.StoredBytes != 400 || records[0].UploadID != "upload-private" {
		t.Fatal("durable provisional record changed")
	}
}

func TestRecoveryPostgresCleanupRetainsUncertainAttemptsAndFencesLease(t *testing.T) {
	// Given a terminally failed upload with uncertain remote completion.
	f := recoveryDB(t)
	f.backup(t)
	f.job(t)
	c := f.claim(t)
	f.candidate(t, c)
	if err := f.s.FailRecovery(f.ctx, c); err != nil {
		t.Fatal(err)
	}
	eligible, err := f.s.NextRecoveryCleanup(f.ctx)
	if err != nil || eligible == nil || eligible.Kind != RecoveryBackup || eligible.OperationID != f.id {
		t.Fatalf("failed backup cleanup was not scheduled: %+v %v", eligible, err)
	}
	cleanup, err := f.s.ClaimRecoveryCleanup(f.ctx, *eligible, "cleanup")
	if err != nil {
		t.Fatal(err)
	}
	// When cleanup cannot yet prove remote absence, and then loses its lease.
	if err = f.s.FinishRecoveryCleanup(f.ctx, cleanup); err == nil {
		t.Fatal("uncertain artifact released source pin")
	}
	records, err := f.s.ReadRecoveryCleanup(f.ctx, cleanup)
	if err != nil || len(records) != 1 || records[0].State != "PREPARED" {
		t.Fatalf("cleanup identity lost: %v", err)
	}
	f.exec(t, `UPDATE "ResourceBackup" SET "cleanupLeaseUntil"=CURRENT_TIMESTAMP-interval '1 second' WHERE id=$1`, f.id)
	if err = f.s.MarkRecoveryAttemptCleaned(f.ctx, cleanup, 1); err == nil {
		t.Fatal("expired cleanup lease acknowledged")
	}
	newer, err := f.s.ClaimRecoveryCleanup(f.ctx, c.Identity(), "next-cleanup")
	if err != nil {
		t.Fatal(err)
	}
	if newer.token == cleanup.token {
		t.Fatal("cleanup token reused")
	}
	if err = f.s.FenceRecoveryCleanup(f.ctx, cleanup); err == nil {
		t.Fatal("stale cleanup authorized network delete")
	}
	if err = f.s.MarkRecoveryAttemptCleaned(f.ctx, newer, 1); err != nil {
		t.Fatal(err)
	}
	if err = f.s.FinishRecoveryCleanup(f.ctx, newer); err != nil {
		t.Fatal(err)
	}
	// Then exact acknowledged cleanup releases source pin and enables ordinary finalization.
	f.exec(t, `UPDATE "Resource" SET status='DELETE_REQUESTED' WHERE id=$1`, f.id)
	resource, err := f.s.ClaimNextResourceDeletion(f.ctx, time.Minute, 0)
	if err != nil || resource == nil {
		t.Fatalf("cleaned source deletion claim: %v", err)
	}
	if err = f.s.FinalizeResourceDeletion(f.ctx, resource); err != nil {
		t.Fatal(err)
	}
}

func TestRecoveryPostgresCleanupSelectorIncludesFailureBeforeIntent(t *testing.T) {
	f := recoveryDB(t)
	f.backup(t)
	f.job(t)
	claim := f.claim(t)
	if err := f.s.FailRecovery(f.ctx, claim); err != nil {
		t.Fatal(err)
	}
	identity, err := f.s.NextRecoveryCleanup(f.ctx)
	if err != nil || identity == nil || identity.Kind != RecoveryBackup || identity.OperationID != f.id {
		t.Fatalf("pre-intent failure was not selected: %+v %v", identity, err)
	}
	cleanup, err := f.s.ClaimRecoveryCleanup(f.ctx, *identity, "cleanup")
	if err != nil {
		t.Fatal(err)
	}
	if attempts, readErr := f.s.ReadRecoveryCleanup(f.ctx, cleanup); readErr != nil || len(attempts) != 0 {
		t.Fatalf("unexpected remote attempts: %+v %v", attempts, readErr)
	}
	if err = f.s.FinishRecoveryCleanup(f.ctx, cleanup); err != nil {
		t.Fatal(err)
	}
	var deleted, pinned bool
	if err = f.s.db.QueryRowContext(f.ctx, `SELECT status='DELETED',EXISTS(SELECT 1 FROM "ResourceRecoveryPin" WHERE "backupId"=$1 AND kind='ARTIFACT_SOURCE') FROM "ResourceBackup" WHERE id=$1`, f.id).Scan(&deleted, &pinned); err != nil {
		t.Fatal(err)
	}
	if !deleted || pinned {
		t.Fatalf("deleted=%v source pinned=%v", deleted, pinned)
	}
}

func TestRecoveryPostgresParentDeletionPinBarrier(t *testing.T) {
	for _, table := range []string{"Resource", "Project", "Organization"} {
		t.Run(table, func(t *testing.T) {
			// Given a durable upload intent and source pin.
			f := recoveryDB(t)
			f.backup(t)
			f.job(t)
			c := f.claim(t)
			if _, err := f.s.RecordRecoveryIntent(f.ctx, c, "key1"); err != nil {
				t.Fatal(err)
			}
			// When a direct ancestor cascade bypasses the application.
			_, err := f.s.db.ExecContext(f.ctx, `DELETE FROM "`+table+`" WHERE id=$1`, f.id)
			// Then RESTRICT/cleanup guards preserve the cleanup identity.
			if err == nil {
				t.Fatal("ancestor cascade erased pending recovery")
			}
			records, err := f.s.ReadRecoveryAttempts(f.ctx, c)
			if err != nil || len(records) != 1 {
				t.Fatalf("pending identity lost: %v", err)
			}
		})
	}
}

func TestRecoveryPostgresActiveRestoreBlocksArtifactCleanup(t *testing.T) {
	// Given an active pinned restore referencing a retained backup.
	f := recoveryDB(t)
	f.readyBackup(t)
	f.restore(t)
	f.exec(t, `UPDATE "ResourceBackup" SET status='EXPIRED' WHERE id=$1`, f.id)
	// When retention requests deletion.
	_, err := f.s.ClaimRecoveryCleanup(f.ctx, RecoveryIdentity{Kind: RecoveryBackup, OperationID: f.id}, "cleanup")
	// Then the restore pin blocks object mutation independently of expiry.
	if err == nil {
		t.Fatal("active restore permitted artifact cleanup")
	}
}
