package store

import (
	"errors"
	"testing"
	"time"
)

func (f recoveryFixture) restore(t *testing.T) string {
	t.Helper()
	id := f.id + "-restore"
	target := f.id + "-target"
	f.exec(t, `INSERT INTO "Resource" (id,"projectId",name,slug,type,engine,provider,plan,region,status,"desiredState","updatedAt")
 VALUES ($1,$2,'restore-target','restore-target','database','postgresql','raibitserver','shared-small','local','PROVISIONING',
 jsonb_build_object('recoveryRestoreId',$3::text,'recoveryPublicationBlocked',true),CURRENT_TIMESTAMP)`, target, f.id, id)
	f.exec(t, `INSERT INTO "ResourceRestore" (id,"organizationId","projectId","backupId","sourceResourceId","targetResourceId",engine,provider,"sourceGeneration","requestedByUserId","requestIdempotencyKey","requestFingerprint","updatedAt")
 SELECT $2,"organizationId","projectId",id,"resourceId",$3,engine,provider,"sourceGeneration",'actor','restore-key','fingerprint',CURRENT_TIMESTAMP FROM "ResourceBackup" WHERE id=$1`, f.id, id, target)
	f.exec(t, `INSERT INTO "ResourceRecoveryPin" (id,"resourceId","backupId","restoreId",kind) VALUES ($1,$2,$3,$1,'RESTORE_TARGET')`, id, target, f.id)
	f.exec(t, `INSERT INTO "WorkflowJob" (id,type,"targetType","targetId",payload,"updatedAt") VALUES ($1,'resource.restore','resource-restore',$2,jsonb_build_object('version',1,'operationId',$2::text),CURRENT_TIMESTAMP)`, recoveryJobID(RecoveryRestore, id), id)
	return id
}

func (f recoveryFixture) prepare(t *testing.T, id string) {
	t.Helper()
	var claimed time.Time
	if err := f.s.db.QueryRowContext(f.ctx, `UPDATE "Resource" SET status='RECONCILING' WHERE id=$1 RETURNING "updatedAt"`, f.id+"-target").Scan(&claimed); err != nil {
		t.Fatal(err)
	}
	state := decodeMap([]byte(recoveryState()))
	state["recoveryRestoreId"] = id
	state["recoveryPublicationBlocked"] = true
	state["resourceExecution"] = map[string]any{"intent": "live-provision", "environment": "local", "image": "image"}
	err := f.s.MarkResourceReady(f.ctx, &Resource{ID: f.id + "-target", Status: StatusReconciling, ClaimToken: claimed.Format(time.RFC3339Nano)}, "raibitserver", "target-connection", "target:5432", []string{"DATABASE_URL"}, state)
	if !errors.Is(err, ErrRecoveryPrepared) {
		t.Fatalf("target was not privately prepared: %v", err)
	}
}

func TestRecoveryPostgresRestoreOnlyFinalSuccessPublishes(t *testing.T) {
	// Given a retained verified backup and a new pinned unpublished target.
	f := recoveryDB(t)
	f.readyBackup(t)
	id := f.restore(t)
	var secret *string
	if err := f.s.db.QueryRowContext(f.ctx, `SELECT "connectionSecretName" FROM "Resource" WHERE id=$1`, f.id+"-target").Scan(&secret); err != nil || secret != nil {
		t.Fatalf("new target has credentials: %v", err)
	}
	f.prepare(t, id)
	// When ordinary preparation finishes and recovery has not verified the restore.
	var status string
	var blocked, prepared, pinned bool
	if err := f.s.db.QueryRowContext(f.ctx, `SELECT status,("desiredState"->>'recoveryPublicationBlocked')::boolean,("desiredState"->>'recoveryPrepared')::boolean,EXISTS(SELECT 1 FROM "ResourceRecoveryPin" WHERE "restoreId"=$2) FROM "Resource" WHERE id=$1`, f.id+"-target", id).Scan(&status, &blocked, &prepared, &pinned); err != nil {
		t.Fatal(err)
	}
	if status != "PROVISIONING" || !blocked || !prepared || !pinned {
		t.Fatal("ordinary provisioning exposed target")
	}
	f.s.ConfigureResourceClaims("local", map[string]string{"postgresql": "image"})
	if got, err := f.s.ClaimNextResource(f.ctx, time.Minute, 0); err != nil || got != nil {
		t.Fatalf("prepared target reprovisioned: %v", err)
	}
	f.exec(t, `UPDATE "Resource" SET "updatedAt"=CURRENT_TIMESTAMP-interval '10 minutes',"desiredState"="desiredState"||'{"healthManaged":true}' WHERE id=$1`, f.id+"-target")
	// Exclude the source health candidate to isolate the prepared target claim.
	f.exec(t, `UPDATE "Resource" SET "updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`, f.id)
	if got, err := f.s.ClaimNextReadyResource(f.ctx, time.Minute); err != nil || got != nil {
		t.Fatalf("prepared target health-published: %v", err)
	}
	c := f.claim(t)
	if err := f.s.FinishRecovery(f.ctx, c); err == nil {
		t.Fatal("unverified restore published")
	}
	if err := f.s.StartRestoreVerification(f.ctx, c); err != nil {
		t.Fatal(err)
	}
	if err := f.s.FinishRecovery(f.ctx, c); err != nil {
		t.Fatal(err)
	}
	// Then only final success publishes the target and releases its independent pin.
	if err := f.s.db.QueryRowContext(f.ctx, `SELECT status,"desiredState" ? 'recoveryPublicationBlocked',EXISTS(SELECT 1 FROM "ResourceRecoveryPin" WHERE "restoreId"=$2) FROM "Resource" WHERE id=$1`, f.id+"-target", id).Scan(&status, &blocked, &pinned); err != nil {
		t.Fatal(err)
	}
	if status != "READY" || blocked || pinned {
		t.Fatal("restore finalization not atomic")
	}
}

func TestRecoveryPostgresCancelledRestoreCleanupReleasesOnlyTarget(t *testing.T) {
	// Given a running restore with an independently pinned target.
	f := recoveryDB(t)
	f.readyBackup(t)
	id := f.restore(t)
	f.prepare(t, id)
	c := f.claim(t)
	// When cancellation fences publication before the separate cleanup lease.
	if err := f.s.CancelRestore(f.ctx, c); err != nil {
		t.Fatal(err)
	}
	eligible, err := f.s.NextRecoveryCleanup(f.ctx)
	if err != nil || eligible == nil || eligible.Kind != RecoveryRestore || eligible.OperationID != id {
		t.Fatalf("cancelled restore cleanup was not scheduled: %+v %v", eligible, err)
	}
	if err := f.s.StartRestoreVerification(f.ctx, c); err == nil {
		t.Fatal("cancelled worker remained live")
	}
	cleanup, err := f.s.ClaimRecoveryCleanup(f.ctx, *eligible, "cleanup")
	if err != nil {
		t.Fatal(err)
	}
	if err = f.s.FenceRecoveryCleanup(f.ctx, cleanup); err != nil {
		t.Fatal(err)
	}
	if err = f.s.FinishRecoveryCleanup(f.ctx, cleanup); err != nil {
		t.Fatal(err)
	}
	// Then target metadata is removed after cleanup, source backup and source pin remain.
	var target, sourcePin, backup bool
	if err = f.s.db.QueryRowContext(f.ctx, `SELECT EXISTS(SELECT 1 FROM "Resource" WHERE id=$1),EXISTS(SELECT 1 FROM "ResourceRecoveryPin" WHERE "backupId"=$2 AND kind='ARTIFACT_SOURCE'),EXISTS(SELECT 1 FROM "ResourceBackup" WHERE id=$2 AND status='READY')`, f.id+"-target", f.id).Scan(&target, &sourcePin, &backup); err != nil {
		t.Fatal(err)
	}
	if target || !sourcePin || !backup {
		t.Fatal("target cleanup changed retained source")
	}
}
