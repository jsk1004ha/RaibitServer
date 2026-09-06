package store

import (
	"testing"
	"time"
)

func TestRecoveryPostgresSourceRetirementPreservesSuccessfulRestore(t *testing.T) {
	// Given a completed restore whose target is now independently READY.
	f := recoveryDB(t)
	f.readyBackup(t)
	id := f.restore(t)
	f.prepare(t, id)
	restore := f.claim(t)
	if err := f.s.StartRestoreVerification(f.ctx, restore); err != nil {
		t.Fatal(err)
	}
	if err := f.s.FinishRecovery(f.ctx, restore); err != nil {
		t.Fatal(err)
	}
	f.exec(t, `UPDATE "ResourceBackup" SET status='EXPIRED' WHERE id=$1`, f.id)
	// When the terminal artifact cleanup is acknowledged and the ordinary source finalizer runs.
	cleanup, err := f.s.ClaimRecoveryCleanup(f.ctx, RecoveryIdentity{Kind: RecoveryBackup, OperationID: f.id}, "cleanup")
	if err != nil {
		t.Fatal(err)
	}
	if err = f.s.MarkRecoveryAttemptCleaned(f.ctx, cleanup, 1); err != nil {
		t.Fatal(err)
	}
	if err = f.s.FinishRecoveryCleanup(f.ctx, cleanup); err != nil {
		t.Fatal(err)
	}
	f.exec(t, `UPDATE "Resource" SET status='DELETE_REQUESTED' WHERE id=$1`, f.id)
	source, err := f.s.ClaimNextResourceDeletion(f.ctx, time.Minute, 0)
	if err != nil || source == nil {
		t.Fatalf("source retirement claim: %v", err)
	}
	if err = f.s.FinalizeResourceDeletion(f.ctx, source); err != nil {
		t.Fatal(err)
	}
	// Then terminal recovery history retires while the restored target survives.
	var status string
	if err = f.s.db.QueryRowContext(f.ctx, `SELECT status FROM "Resource" WHERE id=$1`, f.id+"-target").Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "READY" {
		t.Fatalf("restored target changed during source retirement: %s", status)
	}
}

func TestRecoveryPostgresExpiredDeadlineTerminalizesWithoutNewAttempt(t *testing.T) {
	// Given a first claim whose fixed operation deadline expired.
	f := recoveryDB(t)
	f.backup(t)
	f.job(t)
	c := f.claim(t)
	f.exec(t, `UPDATE "ResourceBackup" SET "startedAt"=CURRENT_TIMESTAMP-interval '31 minutes',"deadlineAt"=CURRENT_TIMESTAMP-interval '1 minute' WHERE id=$1`, f.id)
	f.exec(t, `UPDATE "WorkflowJob" SET "lockedAt"=CURRENT_TIMESTAMP-interval '61 seconds' WHERE "targetId"=$1`, f.id)
	// When a replacement worker scans expired work.
	next, err := f.s.ClaimNextRecovery(f.ctx, "next")
	// Then the operation and job fail atomically without giving the replacement another lease.
	if next != nil || err != nil {
		t.Fatalf("expired claim issued: %v", err)
	}
	if err = f.s.FenceRecovery(f.ctx, c); err == nil {
		t.Fatal("expired original worker remains live")
	}
	var backup, job string
	var attempts int
	if err = f.s.db.QueryRowContext(f.ctx, `SELECT b.status,j.status,j.attempts FROM "ResourceBackup" b JOIN "WorkflowJob" j ON j."targetId"=b.id WHERE b.id=$1`, f.id).Scan(&backup, &job, &attempts); err != nil {
		t.Fatal(err)
	}
	if backup != "FAILED" || job != "failed" || attempts != 1 {
		t.Fatal("deadline did not fence operation and job")
	}
}
