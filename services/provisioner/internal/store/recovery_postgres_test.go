package store

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

type recoveryFixture struct {
	s   *PostgresStore
	ctx context.Context
	id  string
}

func recoveryDB(t *testing.T) recoveryFixture {
	t.Helper()
	id := strings.ReplaceAll(t.Name(), "/", "_")
	if len(id) > 85 {
		id = id[:85]
	}
	return recoveryDBWithID(t, id)
}

func recoveryDBWithID(t *testing.T, id string) recoveryFixture {
	t.Helper()
	dsn := os.Getenv("RAIBITSERVER_RECOVERY_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("requires isolated recovery PostgreSQL database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	s, closeDB, err := OpenPostgresStore(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := closeDB(); err != nil {
			t.Error(err)
		}
	})
	f := recoveryFixture{s: s, ctx: ctx, id: id}
	t.Cleanup(func() {
		if _, err := s.db.Exec(`UPDATE "WorkflowJob" SET status='cancelled',"lockedAt"=NULL,"lockedBy"=NULL WHERE "targetId" IN ($1,$2)`, id, id+"-restore"); err != nil {
			t.Error(err)
		}
	})
	f.exec(t, `INSERT INTO "Organization" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,CURRENT_TIMESTAMP)`, id)
	f.exec(t, `INSERT INTO "Project" (id,"organizationId",name,slug,status,"updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE',CURRENT_TIMESTAMP)`, id)
	f.exec(t, `INSERT INTO "Resource" (id,"projectId",name,slug,type,engine,provider,plan,region,status,"desiredSpec","desiredState","connectionSecretName","updatedAt") VALUES ($1,$1,$1,$1,'database','postgresql','raibitserver','shared-small','local','READY','{}',$2,'db-connection',CURRENT_TIMESTAMP)`, id, recoveryState())
	return f
}

func recoveryState() string {
	keys := `"DATABASE_URL","PGDATABASE","PGHOST","PGPASSWORD","PGPORT","PGUSER","POSTGRES_URL"`
	return `{"providerIdentity":{"namespace":"tenant","name":"db"},"providerResult":{"engine":"postgresql","provider":"raibitserver","name":"db","namespace":"tenant","secretName":"db-connection","endpoint":"db.tenant.svc.cluster.local:5432","environmentKeys":[` + keys + `]},"providerConnection":{"secretName":"db-connection","endpoint":"db.tenant.svc.cluster.local:5432","environmentKeys":[` + keys + `]},"credentialSecretUID":"secret-uid","credentialSecretGeneration":"` + strings.Repeat("a", 43) + `","providerImageProvenance":{"schema":"raibitserver.provider-image/v1","image":"registry.invalid/postgres@sha256:` + strings.Repeat("1", 64) + `","workloadUid":"workload-uid","workloadGeneration":1,"observedAt":"2026-09-03T00:00:00Z"}}`
}

func (f recoveryFixture) exec(t *testing.T, q string, args ...any) {
	t.Helper()
	if _, err := f.s.db.ExecContext(f.ctx, q, args...); err != nil {
		t.Fatal(err)
	}
}

func (f recoveryFixture) backup(t *testing.T) {
	t.Helper()
	resource := &Resource{ID: f.id, ProjectID: f.id, Type: "database", Engine: "postgresql", Provider: "raibitserver", Plan: "shared-small", Region: "local", ConnectionSecretName: "db-connection", DesiredState: decodeMap([]byte(recoveryState()))}
	generation, err := recoverySourceGeneration(resource)
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, `INSERT INTO "ResourceBackup" (id,"resourceId",status,"formatVersion","organizationId","projectId",engine,provider,"sourceGeneration","sourceProvenance","sourceSpec","requestedByUserId","requestIdempotencyKey","requestFingerprint","updatedAt") VALUES ($1,$1,'QUEUED',1,$1,$1,'postgresql','raibitserver',$2,'{}','{}','actor','key','fingerprint',CURRENT_TIMESTAMP)`, f.id, generation)
	f.exec(t, `INSERT INTO "ResourceRecoveryPin" (id,"resourceId","backupId",kind) VALUES ($1,$1,$1,'ARTIFACT_SOURCE')`, f.id)
}

func (f recoveryFixture) job(t *testing.T) {
	f.exec(t, `INSERT INTO "WorkflowJob" (id,type,"targetType","targetId",payload,"updatedAt") VALUES ($1,'resource.backup','resource-backup',$2,jsonb_build_object('version',1,'operationId',$2::text),CURRENT_TIMESTAMP)`, recoveryJobID(RecoveryBackup, f.id), f.id)
}

func TestRecoveryPostgresClaimJournalAndPublication(t *testing.T) {
	// Given a queued backup, independent pin, exact workflow job and observed source.
	f := recoveryDB(t)
	f.backup(t)
	f.job(t)
	// When the private worker claims and journals an upload.
	c, err := f.s.ClaimNextRecovery(f.ctx, "worker")
	if err != nil || c == nil {
		t.Fatalf("claim: %v", err)
	}
	execution, err := f.s.ReadRecoveryExecution(f.ctx, *c)
	if err != nil || execution.Source.SecretUID != "secret-uid" || execution.Source.WorkloadUID != "workload-uid" || execution.Identity.OperationID != f.id {
		t.Fatalf("typed execution metadata unavailable: %v", err)
	}
	attempt, err := f.s.RecordRecoveryIntent(f.ctx, *c, "key1")
	if err != nil {
		t.Fatal(err)
	}
	if err = f.s.RecordRecoveryUpload(f.ctx, *c, "upload-private"); err != nil {
		t.Fatal(err)
	}
	descriptor := attempt.Artifact
	descriptor.StoredBytes = 400
	descriptor.PlaintextBytes = 100
	descriptor.SHA256 = [32]byte{1}
	if err = f.s.RecordRecoveryCandidate(f.ctx, *c, descriptor); err != nil {
		t.Fatal(err)
	}
	if err = f.s.RecordRecoveryComplete(f.ctx, *c); err != nil {
		t.Fatal(err)
	}
	if err = f.s.RecordRecoveryVerified(f.ctx, *c); err != nil {
		t.Fatal(err)
	}
	if err = f.s.FinishRecovery(f.ctx, *c); err != nil {
		t.Fatal(err)
	}
	// Then backup and job publish atomically with exact immutable descriptor and retention.
	var status, job, checksum string
	var size int64
	var retention bool
	if err = f.s.db.QueryRowContext(f.ctx, `SELECT b.status,j.status,b."artifactChecksum",b."artifactSize",b."expiresAt"=b."readyAt"+interval '30 days' FROM "ResourceBackup" b JOIN "WorkflowJob" j ON j."targetId"=b.id WHERE b.id=$1`, f.id).Scan(&status, &job, &checksum, &size, &retention); err != nil {
		t.Fatal(err)
	}
	if status != "READY" || job != "succeeded" || size != 400 || !retention || checksum != "01"+strings.Repeat("0", 62) {
		t.Fatalf("publication mismatch: %s %s %d %t %s", status, job, size, retention, checksum)
	}
}

func (f recoveryFixture) claim(t *testing.T) RecoveryClaim {
	t.Helper()
	c, err := f.s.ClaimNextRecovery(f.ctx, "worker")
	if err != nil || c == nil {
		t.Fatalf("claim failed: %v", err)
	}
	return *c
}

func (f recoveryFixture) candidate(t *testing.T, c RecoveryClaim) RecoveryArtifact {
	t.Helper()
	a, err := f.s.RecordRecoveryIntent(f.ctx, c, "key1")
	if err != nil {
		t.Fatal(err)
	}
	if err = f.s.RecordRecoveryUpload(f.ctx, c, "upload-private"); err != nil {
		t.Fatal(err)
	}
	artifact := a.Artifact
	artifact.StoredBytes = 400
	artifact.PlaintextBytes = 100
	artifact.SHA256 = [32]byte{1}
	if err = f.s.RecordRecoveryCandidate(f.ctx, c, artifact); err != nil {
		t.Fatal(err)
	}
	return artifact
}

func (f recoveryFixture) readyBackup(t *testing.T) RecoveryClaim {
	t.Helper()
	f.backup(t)
	f.job(t)
	c := f.claim(t)
	f.candidate(t, c)
	if err := f.s.RecordRecoveryComplete(f.ctx, c); err != nil {
		t.Fatal(err)
	}
	if err := f.s.RecordRecoveryVerified(f.ctx, c); err != nil {
		t.Fatal(err)
	}
	if err := f.s.FinishRecovery(f.ctx, c); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestRecoveryPostgresPinnedDeletionCannotClaim(t *testing.T) {
	// Given an independent artifact pin on a deletion-requested resource.
	f := recoveryDB(t)
	f.backup(t)
	f.exec(t, `UPDATE "Resource" SET status='DELETE_REQUESTED' WHERE id=$1`, f.id)
	// When the ordinary provisioner asks for deletion work.
	got, err := f.s.ClaimNextResourceDeletion(f.ctx, time.Minute, 0)
	// Then no runtime deletion is authorized.
	if err != nil || got != nil {
		t.Fatalf("pinned deletion claimed: resource=%v err=%v", got, err)
	}
}

func TestRecoveryPostgresPinnedDeletionCannotRenew(t *testing.T) {
	// Given a pinned resource with a previously obtained deletion token.
	f := recoveryDB(t)
	f.backup(t)
	var claimed time.Time
	if err := f.s.db.QueryRowContext(f.ctx, `UPDATE "Resource" SET status='DELETING' WHERE id=$1 RETURNING "updatedAt"`, f.id).Scan(&claimed); err != nil {
		t.Fatal(err)
	}
	// When the existing pre-Kubernetes command renewal runs.
	err := f.s.RenewResourceClaim(f.ctx, &Resource{ID: f.id, Status: StatusDeleting, ClaimToken: claimed.Format(time.RFC3339Nano)})
	// Then the pin blocks even a previously issued claim.
	if err == nil {
		t.Fatal("pinned deletion renewal authorized Kubernetes side effects")
	}
}

func TestRecoveryPostgresRestoreMarkerCannotPublishReady(t *testing.T) {
	// Given a target marker without its required independent pin.
	f := recoveryDB(t)
	var claimed time.Time
	if err := f.s.db.QueryRowContext(f.ctx, `UPDATE "Resource" SET status='RECONCILING',"desiredState"='{"recoveryRestoreId":"restore","recoveryPublicationBlocked":true}' WHERE id=$1 RETURNING "updatedAt"`, f.id).Scan(&claimed); err != nil {
		t.Fatal(err)
	}
	state := map[string]any{"recoveryRestoreId": "restore", "recoveryPublicationBlocked": true}
	// When ordinary provisioning attempts READY.
	err := f.s.MarkResourceReady(f.ctx, &Resource{ID: f.id, Status: StatusReconciling, ClaimToken: claimed.Format(time.RFC3339Nano)}, "raibitserver", "db-connection", "db:5432", []string{"DATABASE_URL"}, state)
	// Then it must fail closed and leave the target unpublished.
	if err == nil {
		t.Fatal("ordinary provisioner published restore target")
	}
}
