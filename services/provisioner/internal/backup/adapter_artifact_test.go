package backup

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func Test_RecoveryAdapter_when_authority_surface_is_inspected(t *testing.T) {
	// Given: the complete adapter interface consumed by future engine implementations.
	typeOf := reflect.TypeOf((*RecoveryAdapter)(nil)).Elem()
	// When / Then: it exposes execution only, never deletion or READY publication.
	if typeOf.NumMethod() != 3 {
		t.Fatalf("methods=%d", typeOf.NumMethod())
	}
	for _, forbidden := range []string{"Delete", "Ready", "PublishReady"} {
		if _, exists := typeOf.MethodByName(forbidden); exists {
			t.Fatalf("forbidden method=%s", forbidden)
		}
	}
}

func Test_ArtifactLifecycle_when_dump_is_uploaded_then_restored(t *testing.T) {
	// Given: pre-dump identity with no guessed byte count or checksum.
	source := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	dumpRequest, err := NewDumpRequest(source, source.Generation())
	if err != nil {
		t.Fatal(err)
	}
	output := &countingWriteCloser{}
	handoff, err := NewDumpHandoff(context.Background(), output, 16)
	if err != nil {
		t.Fatal(err)
	}
	job, err := NewIsolatedJob(testJobSpec(t, source, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	// When: a concrete job run produces typed adapter metadata before Task23 records upload bytes.
	receipt, err := handoff.Execute(context.Background(), job, writeRunner{payload: "dump"})
	if err != nil {
		t.Fatal(err)
	}
	dumpResult, err := newDumpResult(dumpRequest, receipt, testFormat(t, EnginePostgreSQL), testBaseline(t))
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := NewAttempt(AttemptSpec{OrganizationID: "org-1", ResourceID: "source", BackupID: "operation-1", KeyVersion: "key-1", Number: 2, FirstClaimAt: time.Unix(1, 0)})
	if err != nil {
		t.Fatal(err)
	}
	artifact, err := NewRecoveryArtifact(dumpResult, VerifiedArtifact{record: ArtifactRecord{Attempt: attempt.Spec(), StoredBytes: 24, PlaintextBytes: 4, SHA256: [32]byte{9}}})
	if err != nil {
		t.Fatal(err)
	}
	target := testNetworkConnection(t, "target", "target.db.internal", "target-secret", "DATABASE_URL", "16.8")
	restore, err := NewRestoreRequest(source, target, artifact, NewMajorVersionCompatibility(artifact.Format()))
	if err != nil {
		t.Fatal(err)
	}
	verification, err := NewVerificationReceipt(restore, testRestoreReceipt(t, target), testBaseline(t))
	// Then: durable bytes/checksum and observed typed metadata are composed without publication authority.
	if err != nil || artifact.Record().StoredBytes != 24 || artifact.Record().PlaintextBytes != 4 || verification.Observed().Spec().Schema != "postgres-catalog" {
		t.Fatalf("artifact=%+v verification=%+v err=%v", artifact.Record(), verification, err)
	}
}

func Test_NewRecoveryArtifact_when_Task23_bytes_do_not_match_stream(t *testing.T) {
	// Given: a dump result observing four plaintext bytes.
	source := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	request, err := NewDumpRequest(source, source.Generation())
	if err != nil {
		t.Fatal(err)
	}
	job, err := NewIsolatedJob(testJobSpec(t, source, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := newJobReceipt("job-1", 4, job, dumpDirection)
	if err != nil {
		t.Fatal(err)
	}
	result, err := newDumpResult(request, receipt, testFormat(t, EnginePostgreSQL), testBaseline(t))
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := NewAttempt(AttemptSpec{OrganizationID: "org-1", ResourceID: "source", BackupID: "operation-1", KeyVersion: "key-1", Number: 2, FirstClaimAt: time.Unix(1, 0)})
	if err != nil {
		t.Fatal(err)
	}
	// When: Task23 reports a different plaintext count.
	_, err = NewRecoveryArtifact(result, VerifiedArtifact{record: ArtifactRecord{Attempt: attempt.Spec(), StoredBytes: 24, PlaintextBytes: 5, SHA256: [32]byte{9}}})
	// Then: the lifecycle cannot splice unrelated upload metadata.
	if !errors.Is(err, ErrRecoveryRequest) {
		t.Fatalf("err=%v", err)
	}
}

func Test_NewRecoveryArtifact_when_Task23_authenticated_readback_succeeds(t *testing.T) {
	// Given: Task23 uploads and fully authenticates an encrypted artifact by readback.
	service, _, journal, attempt := fixture(t, "", Options{})
	candidate := uploadFixture(t, service, journal, attempt, 4)
	verified, err := service.Readback(readbackContext(t), candidate, &bufferSink{})
	if err != nil {
		t.Fatal(err)
	}
	source := testNetworkConnection(t, attempt.Spec().ResourceID, "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	source, err = newConnection(source.Spec(), source.toolImage, attempt.Spec().BackupID, attempt.Spec().Number)
	if err != nil {
		t.Fatal(err)
	}
	request, err := NewDumpRequest(source, source.Generation())
	if err != nil {
		t.Fatal(err)
	}
	job, err := NewIsolatedJob(testJobSpec(t, source, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := newJobReceipt("job-1", 4, job, dumpDirection)
	if err != nil {
		t.Fatal(err)
	}
	result, err := newDumpResult(request, receipt, testFormat(t, EnginePostgreSQL), testBaseline(t))
	if err != nil {
		t.Fatal(err)
	}
	// When: the opaque authentication capability is joined to the dump result.
	artifact, err := NewRecoveryArtifact(result, verified)
	// Then: its exact Task23 attempt/fence identity survives the boundary.
	if err != nil || artifact.Record().Attempt != attempt.Spec() {
		t.Fatalf("attempt=%+v err=%v", artifact.Record().Attempt, err)
	}
}

func Test_NewRecoveryArtifact_when_constructor_signature_is_inspected(t *testing.T) {
	// Given: raw Task23 Candidate/ArtifactRecord values and the recovery constructor type.
	constructor := reflect.TypeOf(NewRecoveryArtifact)
	verifiedType := reflect.TypeOf(VerifiedArtifact{})
	// When / Then: only the opaque verified capability can cross parameter two.
	if constructor.In(1) != verifiedType || constructor.In(1) == reflect.TypeOf(Candidate{}) || constructor.In(1) == reflect.TypeOf(ArtifactRecord{}) {
		t.Fatalf("artifact input=%v", constructor.In(1))
	}
}

func Test_NewRestoreRequest_when_durable_source_generation_changed(t *testing.T) {
	// Given: an artifact recorded for one exact source incarnation.
	source := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	artifact := testArtifact(t, source)
	changedSpec := source.Spec()
	changedSpec.Generation, _ = NewSourceGeneration("resource-incarnation/v1:sha256:" + strings.Repeat("d", 64))
	changed, err := newConnection(changedSpec, source.toolImage, source.operationID, source.attempt)
	if err != nil {
		t.Fatal(err)
	}
	target := testNetworkConnection(t, "target", "target.db.internal", "target-secret", "DATABASE_URL", "16.7")
	// When: restore is attempted with the changed live source.
	_, err = NewRestoreRequest(changed, target, artifact, NewMajorVersionCompatibility(artifact.Format()))
	// Then: durable provenance equality is enforced.
	if !errors.Is(err, ErrRecoveryRequest) {
		t.Fatalf("err=%v", err)
	}
}

func Test_NewVerificationReceipt_when_observation_differs_from_baseline(t *testing.T) {
	// Given: a restore whose durable baseline records 42 sentinel rows.
	source := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	target := testNetworkConnection(t, "target", "target.db.internal", "target-secret", "DATABASE_URL", "16.7")
	artifact := testArtifact(t, source)
	restore, err := NewRestoreRequest(source, target, artifact, NewMajorVersionCompatibility(artifact.Format()))
	if err != nil {
		t.Fatal(err)
	}
	observed, err := NewVerificationMetadata(VerificationMetadataSpec{Schema: "postgres-catalog", Version: 1, Fields: []VerificationField{{Name: "schema_digest", Value: "sha256:catalog"}, {Name: "sentinel_rows", Value: "41"}}})
	if err != nil {
		t.Fatal(err)
	}
	// When: the adapter submits actual observed typed fields.
	_, err = NewVerificationReceipt(restore, testRestoreReceipt(t, target), observed)
	// Then: an arbitrary mismatching observation cannot become a receipt.
	if !errors.Is(err, ErrRecoveryRequest) {
		t.Fatalf("err=%v", err)
	}
}

func Test_NewVerificationReceipt_when_target_job_did_not_run(t *testing.T) {
	// Given: a valid restore request and matching observed metadata but no completed target job.
	source := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	target := testNetworkConnection(t, "target", "target.db.internal", "target-secret", "DATABASE_URL", "16.7")
	artifact := testArtifact(t, source)
	restore, err := NewRestoreRequest(source, target, artifact, NewMajorVersionCompatibility(artifact.Format()))
	if err != nil {
		t.Fatal(err)
	}
	// When: a no-run adapter attempts to mint verification.
	_, err = NewVerificationReceipt(restore, JobReceipt{}, testBaseline(t))
	// Then: missing target execution proof is rejected.
	if !errors.Is(err, ErrRecoveryRequest) {
		t.Fatalf("err=%v", err)
	}
}

func Test_NewVerificationReceipt_when_completed_job_is_from_another_attempt(t *testing.T) {
	source := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	target := testNetworkConnection(t, "target", "target.db.internal", "target-secret", "DATABASE_URL", "16.7")
	artifact := testArtifact(t, source)
	restore, err := NewRestoreRequest(source, target, artifact, NewMajorVersionCompatibility(artifact.Format()))
	if err != nil {
		t.Fatal(err)
	}
	receipt := testRestoreReceipt(t, target)
	receipt.fence.attempt++
	if _, err = NewVerificationReceipt(restore, receipt, testBaseline(t)); !errors.Is(err, ErrRecoveryRequest) {
		t.Fatalf("receipt from another attempt accepted: %v", err)
	}
}
