package recoverydb

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/raibitserver/provisioner/internal/recoverywire"
)

func testEnvelope(t *testing.T, actionName, payload string) []byte {
	t.Helper()
	selected, err := parseAction(actionName)
	if err != nil {
		t.Fatalf("parse action: %v", err)
	}
	version := "8.4.1"
	if selected.engine == enginePostgreSQL {
		version = "160004"
	}
	baseline, err := parseBaseline([]byte(baselineOutput(version, "descriptor")))
	if err != nil {
		t.Fatalf("parse baseline: %v", err)
	}
	metadata, err := wireMetadata(selected.engine, baseline)
	if err != nil {
		t.Fatalf("wire metadata: %v", err)
	}
	var encoded bytes.Buffer
	if _, err := recoverywire.NewEncoder(recoverywire.DefaultLimits()).Encode(context.Background(), &encoded, recoverywire.Envelope{Metadata: metadata, Payload: strings.NewReader(payload)}); err != nil {
		t.Fatalf("encode envelope: %v", err)
	}
	return encoded.Bytes()
}

func decodeEnvelope(t *testing.T, encoded []byte) (string, recoverywire.Decoded) {
	t.Helper()
	var payload bytes.Buffer
	decoded, err := recoverywire.NewDecoder(recoverywire.DefaultLimits()).Decode(context.Background(), &payload, bytes.NewReader(encoded))
	if err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	return payload.String(), decoded
}

func Test_VerifyDecoded_rejects_engine_version_and_structural_mismatch(t *testing.T) {
	// Given
	encoded := testEnvelope(t, "postgresql-dump", "archive")
	_, decoded := decodeEnvelope(t, encoded)
	target, err := parseBaseline([]byte(baselineOutput("170001", "other")))
	if err != nil {
		t.Fatalf("parse target: %v", err)
	}

	// When
	err = verifyDecoded(enginePostgreSQL, decoded, target)

	// Then
	if err == nil {
		t.Fatal("mismatched version and structural baseline accepted")
	}
}

func Test_Run_restore_rejects_invalid_wire_before_native_process(t *testing.T) {
	// Given
	executor := &fakeExecutor{hook: func(_ context.Context, _ recordedProcess, _ Streams) error {
		return errors.New("native process must not start")
	}}
	deps, scratch := testDependencies(t, executor, validEnvironment(), "secret")

	// When
	err := run(context.Background(), invocation{action: "postgresql-restore", streams: Streams{Stdin: strings.NewReader("truncated"), Stdout: io.Discard, Stderr: io.Discard}}, deps)

	// Then
	if err == nil || len(executor.records) != 0 {
		t.Fatalf("err=%v executions=%d", err, len(executor.records))
	}
	if coordinator := deps.receipts.(*fakeReceiptCoordinator); coordinator.stage != nil || len(coordinator.receipts) != 0 {
		t.Fatal("rejected wire wrote recovery state")
	}
	assertScratchClean(t, scratch)
}

func Test_Run_dump_rejects_source_structural_drift_before_wire_output(t *testing.T) {
	// Given
	probe := 0
	executor := &fakeExecutor{hook: func(_ context.Context, record recordedProcess, streams Streams) error {
		if record.spec.executable == "psql" {
			probe++
			descriptor := "before"
			if probe == 2 {
				descriptor = "after"
			}
			_, err := io.WriteString(streams.Stdout, baselineOutput("160004", descriptor))
			return err
		}
		_, err := io.WriteString(streams.Stdout, "archive")
		return err
	}}
	deps, scratch := testDependencies(t, executor, validEnvironment(), "secret")
	setDumpStage(t, deps, enginePostgreSQL, "160004", "before")
	var stdout bytes.Buffer

	// When
	err := run(context.Background(), invocation{action: "postgresql-dump", streams: Streams{Stdout: &stdout, Stderr: io.Discard}}, deps)

	// Then
	if !errors.Is(err, ErrBaseline) || stdout.Len() != 0 || len(executor.records) != 3 {
		t.Fatalf("err=%v stdout=%q executions=%d", err, stdout.String(), len(executor.records))
	}
	assertScratchClean(t, scratch)
}

func Test_ScratchCapacity_requires_wire_limit_plus_reserve(t *testing.T) {
	// Given
	limit := recoverywire.DefaultLimits().MaxBytes()

	// When / Then
	if scratchCapacitySufficient(limit+scratchReserveBytes-1, limit) || !scratchCapacitySufficient(limit+scratchReserveBytes, limit) {
		t.Fatal("scratch capacity boundary is not enforced")
	}
}
