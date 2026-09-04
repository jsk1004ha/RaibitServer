package recoveryreceipt

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func validStageSpec() StageSpec {
	return StageSpec{
		Engine: EnginePostgreSQL, Action: ActionPostgreSQLRestore, Direction: DirectionRestore,
		DecodedBytes: 128, DecodedSHA256: testDecodedSHA,
		Baseline:      BaselineSpec{SchemaSHA256: testSchemaSHA, DataSHA256: testDataSHA, RecordCount: 7},
		SourceVersion: VersionIdentity{engine: EnginePostgreSQL, value: "160002"}, TargetVersionBefore: VersionIdentity{engine: EnginePostgreSQL, value: "160004"},
	}
}

func validDumpStageSpec() StageSpec {
	return StageSpec{
		Engine: EnginePostgreSQL, Action: ActionPostgreSQLDump, Direction: DirectionDump,
		Baseline:      BaselineSpec{SchemaSHA256: testSchemaSHA, DataSHA256: testDataSHA, RecordCount: 7},
		SourceVersion: VersionIdentity{engine: EnginePostgreSQL, value: "160002"},
	}
}

func Test_StageStore_atomically_writes_and_consumes_fixed_state(t *testing.T) {
	// Given
	now := time.Unix(1_800_000_000, 0).UTC()
	path := filepath.Join(newStageTestDirectory(t), StageFileName)
	store := newStageStore(path, func() time.Time { return now })
	stage, err := NewStage(validStageSpec())
	if err != nil {
		t.Fatal(err)
	}

	// When
	err = store.write(stage)
	consumed, consumeErr := store.consume(EnginePostgreSQL, ActionPostgreSQLRestore, DirectionRestore)

	// Then
	if err != nil || consumeErr != nil {
		t.Fatalf("write=%v consume=%v", err, consumeErr)
	}
	if consumed.DecodedSHA256() != testDecodedSHA || consumed.Baseline() != validStageSpec().Baseline {
		t.Fatalf("stage evidence changed")
	}
	if _, statErr := os.Lstat(path); !errors.Is(statErr, fs.ErrNotExist) {
		t.Fatalf("consumed state still exists: %v", statErr)
	}
}

func Test_StageStore_carries_preflight_baseline_from_verify_to_dump(t *testing.T) {
	// Given
	now := time.Unix(1_800_000_000, 0).UTC()
	path := filepath.Join(newStageTestDirectory(t), StageFileName)
	store := newStageStore(path, func() time.Time { return now })
	stage, err := NewStage(validDumpStageSpec())
	if err != nil || store.write(stage) != nil {
		t.Fatalf("setup error=%v", err)
	}

	// When
	consumed, err := store.consume(EnginePostgreSQL, ActionPostgreSQLDump, DirectionDump)

	// Then
	if err != nil || consumed.DecodedBytes() != 0 || consumed.DecodedSHA256() != "" || consumed.Baseline() != validDumpStageSpec().Baseline || consumed.SourceVersion() != validDumpStageSpec().SourceVersion {
		t.Fatalf("preflight stage=%+v error=%v", consumed, err)
	}
}

func Test_Stage_builds_final_receipt_specs_for_dump_and_restore(t *testing.T) {
	// Given
	verified := true
	verification := VerificationSpec{Version: true, Schema: true, DecodedArtifact: true, Sentinel: &verified}
	dump, _ := NewStage(validDumpStageSpec())
	restore, _ := NewStage(validStageSpec())
	targetVersion, _ := NewVersionIdentity(EnginePostgreSQL, "160004")

	// When
	dumpSpec, dumpErr := dump.DumpReceiptSpec(dump.SourceVersion(), DecodedSpec{Bytes: 128, SHA256: testDecodedSHA}, VerificationSpec{Version: true, Schema: true, DecodedArtifact: true})
	restoreSpec, restoreErr := restore.RestoreReceiptSpec(targetVersion, verification)

	// Then
	if dumpErr != nil || restoreErr != nil {
		t.Fatalf("dump=%v restore=%v", dumpErr, restoreErr)
	}
	if _, err := New(dumpSpec); err != nil {
		t.Fatalf("dump receipt spec invalid: %v", err)
	}
	if _, err := New(restoreSpec); err != nil {
		t.Fatalf("restore receipt spec invalid: %v", err)
	}
}

func Test_StageStore_rejects_and_deletes_stale_or_mismatched_state(t *testing.T) {
	tests := []struct {
		name    string
		advance time.Duration
		engine  Engine
		action  Action
	}{
		{name: "stale", advance: StageMaxAge + time.Second, engine: EnginePostgreSQL, action: ActionPostgreSQLRestore},
		{name: "wrong action", engine: EnginePostgreSQL, action: ActionPostgreSQLDump},
		{name: "wrong engine", engine: EngineMySQL, action: ActionPostgreSQLRestore},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Given
			writtenAt := time.Unix(1_800_000_000, 0).UTC()
			path := filepath.Join(newStageTestDirectory(t), StageFileName)
			writer := newStageStore(path, func() time.Time { return writtenAt })
			stage, err := NewStage(validStageSpec())
			if err != nil || writer.write(stage) != nil {
				t.Fatalf("setup error=%v", err)
			}
			reader := newStageStore(path, func() time.Time { return writtenAt.Add(test.advance) })

			// When
			_, err = reader.consume(test.engine, test.action, DirectionRestore)

			// Then
			if !errors.Is(err, ErrStage) {
				t.Fatalf("error=%v", err)
			}
			if _, statErr := os.Lstat(path); !errors.Is(statErr, fs.ErrNotExist) {
				t.Fatalf("rejected state was not deleted: %v", statErr)
			}
		})
	}
}

func Test_NewStage_rejects_fake_decoded_digest_in_dump_preflight(t *testing.T) {
	// Given
	spec := validDumpStageSpec()
	spec.DecodedBytes = 1
	spec.DecodedSHA256 = testDecodedSHA

	// When
	_, err := NewStage(spec)

	// Then
	if !errors.Is(err, ErrStage) {
		t.Fatalf("error=%v", err)
	}
}

func Test_StageStore_rejects_oversized_state(t *testing.T) {
	// Given
	path := filepath.Join(newStageTestDirectory(t), StageFileName)
	if err := os.WriteFile(path, []byte(strings.Repeat("x", MaxBytes+1)), 0o600); err != nil {
		t.Fatal(err)
	}
	store := newStageStore(path, time.Now)

	// When
	_, err := store.consume(EnginePostgreSQL, ActionPostgreSQLRestore, DirectionRestore)

	// Then
	if !errors.Is(err, ErrStage) {
		t.Fatalf("error=%v", err)
	}
}
