package recoverydb

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/raibitserver/provisioner/internal/recoveryreceipt"
)

func Test_ReceiptFlow_source_preflight_then_dump_emits_verified_receipt(t *testing.T) {
	// Given
	executor := successfulExecutor()
	deps, _ := testDependencies(t, executor, validEnvironment(), "secret")
	coordinator := deps.receipts.(*fakeReceiptCoordinator)

	// When
	verifyErr := run(context.Background(), invocation{action: "postgresql-verify", streams: Streams{Stderr: io.Discard}}, deps)
	var encoded bytes.Buffer
	dumpErr := run(context.Background(), invocation{action: "postgresql-dump", streams: Streams{Stdout: &encoded, Stderr: io.Discard}}, deps)

	// Then
	if verifyErr != nil || dumpErr != nil {
		t.Fatalf("verify=%v dump=%v", verifyErr, dumpErr)
	}
	if coordinator.stage != nil || len(coordinator.receipts) != 1 {
		t.Fatalf("stage=%v receipts=%d", coordinator.stage != nil, len(coordinator.receipts))
	}
	if err := coordinator.receipts[0].ValidateFor(recoveryreceipt.EnginePostgreSQL, recoveryreceipt.ActionPostgreSQLDump, recoveryreceipt.DirectionDump); err != nil {
		t.Fatalf("dump receipt=%v", err)
	}
	if payload, _ := decodeEnvelope(t, encoded.Bytes()); payload != "archive" {
		t.Fatalf("payload=%q", payload)
	}
}

func Test_ReceiptFlow_restore_stages_intent_before_write_then_finalizes_patch_compatible_target(t *testing.T) {
	// Given
	var coordinator *fakeReceiptCoordinator
	executor := &fakeExecutor{hook: func(_ context.Context, record recordedProcess, streams Streams) error {
		args := strings.Join(record.spec.args, " ")
		if record.spec.executable == "psql" && strings.Contains(args, "server_version_num") {
			_, err := io.WriteString(streams.Stdout, baselineOutput("160008", "descriptor"))
			return err
		}
		if record.spec.executable == "pg_restore" {
			if coordinator == nil || coordinator.stage == nil || coordinator.stage.Direction() != recoveryreceipt.DirectionRestore {
				return errors.New("restore mutated target before durable intent")
			}
			return nil
		}
		if record.spec.executable == "psql" && strings.Contains(args, "recovery_verify") {
			_, err := io.WriteString(streams.Stdout, "raibitserver-recovery-v1\n")
			return err
		}
		return errors.New("unexpected native process")
	}}
	deps, _ := testDependencies(t, executor, validEnvironment(), "secret")
	coordinator = deps.receipts.(*fakeReceiptCoordinator)
	envelope := testEnvelope(t, "postgresql-dump", "archive")

	// When
	restoreErr := run(context.Background(), invocation{action: "postgresql-restore", streams: Streams{Stdin: bytes.NewReader(envelope), Stderr: io.Discard}}, deps)
	if restoreErr != nil {
		t.Fatalf("restore=%v", restoreErr)
	}
	if coordinator.stage == nil || len(coordinator.receipts) != 0 {
		t.Fatalf("restore stage=%v receipts=%d", coordinator.stage != nil, len(coordinator.receipts))
	}
	verifyErr := run(context.Background(), invocation{action: "postgresql-verify", streams: Streams{Stderr: io.Discard}}, deps)

	// Then
	if verifyErr != nil || coordinator.stage != nil || len(coordinator.receipts) != 1 {
		t.Fatalf("verify=%v stage=%v receipts=%d", verifyErr, coordinator.stage != nil, len(coordinator.receipts))
	}
	if err := coordinator.receipts[0].ValidateFor(recoveryreceipt.EnginePostgreSQL, recoveryreceipt.ActionPostgreSQLRestore, recoveryreceipt.DirectionRestore); err != nil {
		t.Fatalf("restore receipt=%v", err)
	}
}

func Test_ReceiptFlow_rejects_major_mismatch_before_intent_or_target_write(t *testing.T) {
	// Given
	executor := &fakeExecutor{hook: func(_ context.Context, record recordedProcess, streams Streams) error {
		if record.spec.executable != "psql" {
			return errors.New("target mutation must not start")
		}
		_, err := io.WriteString(streams.Stdout, baselineOutput("170001", "descriptor"))
		return err
	}}
	deps, _ := testDependencies(t, executor, validEnvironment(), "secret")
	envelope := testEnvelope(t, "postgresql-dump", "archive")

	// When
	err := run(context.Background(), invocation{action: "postgresql-restore", streams: Streams{Stdin: bytes.NewReader(envelope), Stderr: io.Discard}}, deps)

	// Then
	coordinator := deps.receipts.(*fakeReceiptCoordinator)
	if !errors.Is(err, ErrBaseline) || len(executor.records) != 1 || coordinator.stage != nil || len(coordinator.receipts) != 0 {
		t.Fatalf("err=%v executions=%d stage=%v receipts=%d", err, len(executor.records), coordinator.stage != nil, len(coordinator.receipts))
	}
}

func Test_ReceiptFlow_rejects_target_version_drift_before_sentinel(t *testing.T) {
	// Given
	probe := 0
	executor := &fakeExecutor{hook: func(_ context.Context, record recordedProcess, streams Streams) error {
		args := strings.Join(record.spec.args, " ")
		if record.spec.executable == "psql" && strings.Contains(args, "server_version_num") {
			probe++
			version := "160008"
			if probe == 2 {
				version = "160009"
			}
			_, err := io.WriteString(streams.Stdout, baselineOutput(version, "descriptor"))
			return err
		}
		if record.spec.executable == "pg_restore" {
			return nil
		}
		return errors.New("sentinel must not run after version drift")
	}}
	deps, _ := testDependencies(t, executor, validEnvironment(), "secret")
	envelope := testEnvelope(t, "postgresql-dump", "archive")
	if err := run(context.Background(), invocation{action: "postgresql-restore", streams: Streams{Stdin: bytes.NewReader(envelope), Stderr: io.Discard}}, deps); err != nil {
		t.Fatalf("restore=%v", err)
	}

	// When
	err := run(context.Background(), invocation{action: "postgresql-verify", streams: Streams{Stderr: io.Discard}}, deps)

	// Then
	coordinator := deps.receipts.(*fakeReceiptCoordinator)
	if !errors.Is(err, ErrBaseline) || len(executor.records) != 3 || len(coordinator.receipts) != 0 {
		t.Fatalf("err=%v executions=%d receipts=%d", err, len(executor.records), len(coordinator.receipts))
	}
}

func Test_ReceiptFlow_missing_final_stage_cannot_forge_restore_receipt(t *testing.T) {
	// Given
	executor := successfulExecutor()
	deps, _ := testDependencies(t, executor, validEnvironment(), "secret")

	// When
	err := run(context.Background(), invocation{action: "postgresql-verify", streams: Streams{Stderr: io.Discard}}, deps)

	// Then: absent state is only a source preflight; the production runner rejects a final job without a termination receipt.
	coordinator := deps.receipts.(*fakeReceiptCoordinator)
	if err != nil || coordinator.stage == nil || coordinator.stage.Direction() != recoveryreceipt.DirectionDump || len(coordinator.receipts) != 0 {
		t.Fatalf("err=%v stage=%v receipts=%d", err, coordinator.stage != nil, len(coordinator.receipts))
	}
}

type invalidRestoreCoordinator struct{ fakeReceiptCoordinator }

func (*invalidRestoreCoordinator) ConsumeRestoreStageIfPresent(recoveryreceipt.Engine, recoveryreceipt.Action) (recoveryreceipt.Stage, bool, error) {
	return recoveryreceipt.Stage{}, true, recoveryreceipt.ErrStage
}

func Test_ReceiptFlow_present_invalid_or_orphan_stage_fails_before_probe(t *testing.T) {
	// Given
	executor := successfulExecutor()
	deps, _ := testDependencies(t, executor, validEnvironment(), "secret")
	deps.receipts = &invalidRestoreCoordinator{}

	// When
	err := run(context.Background(), invocation{action: "mongodb-verify", streams: Streams{Stderr: io.Discard}}, deps)

	// Then
	if !errors.Is(err, ErrReceipt) || len(executor.records) != 0 {
		t.Fatalf("err=%v executions=%d", err, len(executor.records))
	}
}

func Test_ReceiptFlow_dump_rejects_source_version_change_before_artifact_write(t *testing.T) {
	// Given
	executor := &fakeExecutor{hook: func(_ context.Context, record recordedProcess, streams Streams) error {
		if record.spec.executable != "psql" {
			return errors.New("dump must not start")
		}
		_, err := io.WriteString(streams.Stdout, baselineOutput("160005", "descriptor"))
		return err
	}}
	deps, _ := testDependencies(t, executor, validEnvironment(), "secret")
	setDumpStage(t, deps, enginePostgreSQL, "160004", "descriptor")
	var output bytes.Buffer

	// When
	err := run(context.Background(), invocation{action: "postgresql-dump", streams: Streams{Stdout: &output, Stderr: io.Discard}}, deps)

	// Then
	coordinator := deps.receipts.(*fakeReceiptCoordinator)
	if !errors.Is(err, ErrBaseline) || len(executor.records) != 1 || output.Len() != 0 || len(coordinator.receipts) != 0 {
		t.Fatalf("err=%v executions=%d output=%d receipts=%d", err, len(executor.records), output.Len(), len(coordinator.receipts))
	}
}
