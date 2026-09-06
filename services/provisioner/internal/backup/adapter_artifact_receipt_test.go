package backup

import (
	"testing"

	"github.com/raibitserver/provisioner/internal/recoveryreceipt"
)

func parsedToolReceipt(t *testing.T, action recoveryreceipt.Action, direction recoveryreceipt.Direction) recoveryreceipt.Receipt {
	t.Helper()
	receipt, err := recoveryreceipt.Parse([]byte(testTerminationReceipt(t, action, direction)))
	if err != nil {
		t.Fatal(err)
	}
	return receipt
}

func helperJobReceipt(t *testing.T, job IsolatedJob, direction streamDirection, tool recoveryreceipt.Receipt) JobReceipt {
	t.Helper()
	observed := testCompletedJob(job, "helper-job")
	observed.receipt, observed.receiptPresent = tool, true
	receipt, err := newJobReceipt(observed, 4, job, direction)
	if err != nil {
		t.Fatal(err)
	}
	return receipt
}

func Test_DumpResult_exposes_helper_observed_baseline_and_decoded_digest(t *testing.T) {
	// Given
	source := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	plans, err := postgresqlDumpPlan(source)
	if err != nil {
		t.Fatal(err)
	}
	job, err := newSQLJob(source, plans)
	if err != nil {
		t.Fatal(err)
	}
	tool := parsedToolReceipt(t, recoveryreceipt.ActionPostgreSQLDump, recoveryreceipt.DirectionDump)
	receipt := helperJobReceipt(t, job, dumpDirection, tool)
	request, _ := NewDumpRequest(source, source.Generation())
	format, descriptor, _ := sqlMetadata(source, postgresqlCustomFormat)

	// When
	result, err := newDumpResult(request, receipt, format, descriptor)

	// Then
	if err != nil {
		t.Fatal(err)
	}
	baseline, ok := result.ObservedBaseline()
	decodedBytes, decodedSHA, decodedOK := result.DecodedArtifact()
	if !ok || !decodedOK || baseline != tool.Baseline() || decodedBytes != tool.DecodedBytes() || decodedSHA != tool.DecodedSHA256() {
		t.Fatalf("dynamic helper evidence was not exposed")
	}
}

func Test_NewVerificationReceipt_accepts_authenticated_wire_evidence_after_restart_without_dump_receipt(t *testing.T) {
	// Given: the rehydrated artifact retains static descriptors, while dynamic source evidence comes from the authenticated wire decoded by the restore helper.
	source := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	target := testNetworkConnection(t, "target", "target.db.internal", "target-secret", "DATABASE_URL", "16.7")
	artifact := testArtifact(t, source)
	request, err := NewRestoreRequest(source, target, artifact, NewMajorVersionCompatibility(artifact.Format()))
	if err != nil {
		t.Fatal(err)
	}
	plans, _ := postgresqlRestorePlan(target)
	job, _ := newSQLJob(target, plans)
	tool := parsedToolReceipt(t, recoveryreceipt.ActionPostgreSQLRestore, recoveryreceipt.DirectionRestore)
	targetJob := helperJobReceipt(t, job, restoreDirection, tool)

	// When
	verified, err := NewVerificationReceipt(request, targetJob, artifact.Baseline())

	// Then
	if err != nil {
		t.Fatal(err)
	}
	observed, ok := verified.RecoveryReceipt()
	if !ok || observed.DecodedSHA256() != tool.DecodedSHA256() || observed.Baseline() != tool.Baseline() {
		t.Fatalf("authenticated restore evidence was not retained")
	}
}

func Test_NewVerificationReceipt_rejects_invalid_aggregate_tool_evidence(t *testing.T) {
	// Given
	source := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	target := testNetworkConnection(t, "target", "target.db.internal", "target-secret", "DATABASE_URL", "16.7")
	artifact := testArtifact(t, source)
	request, _ := NewRestoreRequest(source, target, artifact, NewMajorVersionCompatibility(artifact.Format()))
	job, _ := NewIsolatedJob(testJobSpec(t, target, StreamStdin))
	observed := testCompletedJob(job, "restore-job")
	observed.receiptPresent = true
	targetJob, _ := newJobReceipt(observed, 4, job, restoreDirection)

	// When
	_, err := NewVerificationReceipt(request, targetJob, artifact.Baseline())

	// Then
	if err == nil {
		t.Fatal("invalid aggregate receipt accepted")
	}
}

func Test_NewJobReceipt_rejects_reserved_helper_without_tool_receipt(t *testing.T) {
	// Given
	job := testPostgreSQLHelperJob(t, recoveryreceipt.DirectionDump)
	observed := testCompletedJob(job, "helper-job")

	// When
	_, err := newJobReceipt(observed, 4, job, dumpDirection)

	// Then
	if err == nil {
		t.Fatal("reserved helper completed without a receipt")
	}
}

func Test_NewVerificationReceipt_rejects_network_restore_without_tool_receipt(t *testing.T) {
	// Given
	source := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	target := testNetworkConnection(t, "target", "target.db.internal", "target-secret", "DATABASE_URL", "16.7")
	artifact := testArtifact(t, source)
	request, _ := NewRestoreRequest(source, target, artifact, NewMajorVersionCompatibility(artifact.Format()))
	job, _ := NewIsolatedJob(testJobSpec(t, target, StreamStdin))
	targetJob, _ := newJobReceipt(testCompletedJob(job, "restore-job"), 4, job, restoreDirection)

	// When
	_, err := NewVerificationReceipt(request, targetJob, artifact.Baseline())

	// Then
	if err == nil {
		t.Fatal("network restore completed without aggregate tool evidence")
	}
}
