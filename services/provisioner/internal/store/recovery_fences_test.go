package store

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestRecoveryPostgresConcurrentClaims(t *testing.T) {
	// Given one claimable exact backup job.
	f := recoveryDB(t)
	f.backup(t)
	f.job(t)
	// When concurrent workers claim through independent transactions.
	var wg sync.WaitGroup
	results := make(chan *RecoveryClaim, 8)
	failures := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() { defer wg.Done(); c, e := f.s.ClaimNextRecovery(f.ctx, "worker"); results <- c; failures <- e }()
	}
	wg.Wait()
	close(results)
	close(failures)
	// Then exactly one claim commits.
	count := 0
	for c := range results {
		if c != nil {
			count++
		}
	}
	for e := range failures {
		if e != nil {
			t.Fatal(e)
		}
	}
	if count != 1 {
		t.Fatalf("claims=%d", count)
	}
}

func TestRecoveryPostgresEveryMutationRejectsLostFence(t *testing.T) {
	for _, change := range []string{"lease", "deadline", "worker", "attempt", "project", "resource", "provenance", "terminal"} {
		t.Run(change, func(t *testing.T) {
			// Given a claimed backup and prepared durable candidate.
			f := recoveryDB(t)
			f.backup(t)
			f.job(t)
			c := f.claim(t)
			f.candidate(t, c)
			switch change {
			case "lease":
				f.exec(t, `UPDATE "WorkflowJob" SET "lockedAt"=CURRENT_TIMESTAMP-interval '61 seconds' WHERE "targetId"=$1`, f.id)
			case "deadline":
				f.exec(t, `UPDATE "ResourceBackup" SET "startedAt"=CURRENT_TIMESTAMP-interval '31 minutes',"deadlineAt"=CURRENT_TIMESTAMP-interval '1 minute' WHERE id=$1`, f.id)
			case "worker":
				f.exec(t, `UPDATE "WorkflowJob" SET "lockedBy"='other' WHERE "targetId"=$1`, f.id)
			case "attempt":
				f.exec(t, `UPDATE "WorkflowJob" SET attempts=2 WHERE "targetId"=$1`, f.id)
			case "project":
				f.exec(t, `UPDATE "Project" SET "deletionRequestedAt"=CURRENT_TIMESTAMP WHERE id=$1`, f.id)
			case "resource":
				f.exec(t, `UPDATE "Resource" SET "deletionRequestedAt"=CURRENT_TIMESTAMP WHERE id=$1`, f.id)
			case "provenance":
				f.exec(t, `UPDATE "Resource" SET "desiredState"=jsonb_set("desiredState",'{providerImageProvenance,workloadUid}','"replacement"') WHERE id=$1`, f.id)
			case "terminal":
				f.exec(t, `UPDATE "ResourceBackup" SET status='FAILED' WHERE id=$1`, f.id)
			}
			// When every network fence/renew/result attempts mutation.
			actions := []func() error{
				func() error { return f.s.FenceRecovery(f.ctx, c) },
				func() error { return f.s.RenewRecovery(f.ctx, c) },
				func() error { return f.s.RecordRecoveryComplete(f.ctx, c) },
				func() error { return f.s.RecordRecoveryVerified(f.ctx, c) },
				func() error { return f.s.FinishRecovery(f.ctx, c) },
				func() error { return f.s.RetryRecovery(f.ctx, c) },
			}
			// Then none authorizes side effects or publishes READY.
			for i, action := range actions {
				if err := action(); err == nil {
					t.Fatalf("mutation %d escaped %s fence", i, change)
				}
			}
			var ready bool
			if err := f.s.db.QueryRowContext(f.ctx, `SELECT status='READY' FROM "ResourceBackup" WHERE id=$1`, f.id).Scan(&ready); err != nil {
				t.Fatal(err)
			}
			if ready {
				t.Fatal("stale published READY")
			}
		})
	}
}

func TestRecoveryPostgresWrongJobAndOrphanRejected(t *testing.T) {
	for _, change := range []string{"type", "target", "payload", "orphan", "maximum"} {
		t.Run(change, func(t *testing.T) {
			// Given malformed workflow identity or absent operation.
			f := recoveryDB(t)
			if change != "orphan" {
				f.backup(t)
			}
			f.job(t)
			switch change {
			case "type":
				f.exec(t, `UPDATE "WorkflowJob" SET type='resource.provision' WHERE "targetId"=$1`, f.id)
			case "target":
				f.exec(t, `UPDATE "WorkflowJob" SET "targetType"='resource' WHERE "targetId"=$1`, f.id)
			case "payload":
				f.exec(t, `UPDATE "WorkflowJob" SET payload=payload||'{"extra":1}' WHERE "targetId"=$1`, f.id)
			case "maximum":
				f.exec(t, `UPDATE "WorkflowJob" SET "maxAttempts"=4 WHERE "targetId"=$1`, f.id)
			}
			// When claiming recovery jobs.
			c, err := f.s.ClaimNextRecovery(f.ctx, "worker")
			// Then no claim is issued.
			if c != nil || err != nil {
				t.Fatalf("invalid claim: %v %v", c, err)
			}
		})
	}
}

func TestRecoveryPostgresRetryKeepsDeadlineAndAllCrashIntents(t *testing.T) {
	// Given a crash after durable intent for attempt one.
	f := recoveryDB(t)
	f.backup(t)
	f.job(t)
	first := f.claim(t)
	if _, err := f.s.RecordRecoveryIntent(f.ctx, first, "key1"); err != nil {
		t.Fatal(err)
	}
	// When leases expire and replacements claim up to the fixed maximum.
	previous := first
	for expected := 2; expected <= 3; expected++ {
		f.exec(t, `UPDATE "WorkflowJob" SET "lockedAt"=CURRENT_TIMESTAMP-interval '61 seconds' WHERE "targetId"=$1`, f.id)
		c := f.claim(t)
		if c.attempt != expected || !c.startedAt.Equal(first.startedAt) || !c.deadlineAt.Equal(first.deadlineAt) {
			t.Fatal("retry reset durable clock or attempt")
		}
		if err := f.s.FenceRecovery(f.ctx, previous); !errors.Is(err, ErrRecoveryFence) {
			t.Fatalf("old worker not fenced: %v", err)
		}
		if _, err := f.s.RecordRecoveryIntent(f.ctx, c, "key1"); err != nil {
			t.Fatal(err)
		}
		previous = c
	}
	f.exec(t, `UPDATE "WorkflowJob" SET "lockedAt"=CURRENT_TIMESTAMP-interval '61 seconds' WHERE "targetId"=$1`, f.id)
	c, err := f.s.ClaimNextRecovery(f.ctx, "worker")
	// Then exhaustion terminalizes atomically and preserves all uncertain cleanup identities.
	if c != nil || err != nil {
		t.Fatalf("exhausted claim: %v %v", c, err)
	}
	var status, job string
	var attempts int
	if err = f.s.db.QueryRowContext(f.ctx, `SELECT b.status,j.status,(SELECT count(*) FROM "ResourceRecoveryAttempt" WHERE "backupId"=b.id AND state='INTENT' AND "cleanupPending") FROM "ResourceBackup" b JOIN "WorkflowJob" j ON j."targetId"=b.id WHERE b.id=$1`, f.id).Scan(&status, &job, &attempts); err != nil {
		t.Fatal(err)
	}
	if status != "FAILED" || job != "failed" || attempts != 3 {
		t.Fatalf("exhaustion lost intent: %s %s %d", status, job, attempts)
	}
}

func TestRecoveryPostgresRenewalDoesNotExtendDeadline(t *testing.T) {
	// Given a live lease.
	f := recoveryDB(t)
	f.backup(t)
	f.job(t)
	c := f.claim(t)
	// When the heartbeat renews.
	if err := f.s.RenewRecovery(f.ctx, c); err != nil {
		t.Fatal(err)
	}
	// Then first claim and absolute deadline remain fixed.
	var start, end time.Time
	if err := f.s.db.QueryRowContext(f.ctx, `SELECT "startedAt","deadlineAt" FROM "ResourceBackup" WHERE id=$1`, f.id).Scan(&start, &end); err != nil {
		t.Fatal(err)
	}
	if !start.Equal(c.startedAt) || !end.Equal(start.Add(30*time.Minute)) {
		t.Fatal("renewal shifted operation deadline")
	}
}
