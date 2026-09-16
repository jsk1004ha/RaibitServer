package recoveryreceipt

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func restoreStageVersions(t *testing.T) (VersionIdentity, VersionIdentity) {
	t.Helper()
	source, err := NewVersionIdentity(EnginePostgreSQL, "160002")
	if err != nil {
		t.Fatal(err)
	}
	target, err := NewVersionIdentity(EnginePostgreSQL, "160004")
	if err != nil {
		t.Fatal(err)
	}
	return source, target
}

func Test_NewStage_requires_sanitized_restore_version_evidence(t *testing.T) {
	// Given
	spec := validStageSpec()
	spec.SourceVersion = VersionIdentity{}
	spec.TargetVersionBefore = VersionIdentity{}

	// When
	_, missingErr := NewStage(spec)
	_, unsafeErr := NewVersionIdentity(EnginePostgreSQL, "160004 secret=password")
	_, secretErr := NewVersionIdentity(EnginePostgreSQL, "password")

	// Then
	if !errors.Is(missingErr, ErrStage) || !errors.Is(unsafeErr, ErrStage) || !errors.Is(secretErr, ErrStage) {
		t.Fatalf("missing=%v unsafe=%v secret=%v", missingErr, unsafeErr, secretErr)
	}
}

func Test_DumpStage_requires_and_rechecks_engine_bound_source_version(t *testing.T) {
	// Given
	missing := validDumpStageSpec()
	missing.SourceVersion = VersionIdentity{}
	stage, err := NewStage(validDumpStageSpec())
	if err != nil {
		t.Fatal(err)
	}
	drifted, err := NewVersionIdentity(EnginePostgreSQL, "160003")
	if err != nil {
		t.Fatal(err)
	}

	// When
	_, missingErr := NewStage(missing)
	_, driftErr := stage.DumpReceiptSpec(drifted, DecodedSpec{Bytes: 128, SHA256: testDecodedSHA}, VerificationSpec{Version: true, Schema: true, DecodedArtifact: true})

	// Then
	if !errors.Is(missingErr, ErrStage) || !errors.Is(driftErr, ErrStage) {
		t.Fatalf("missing=%v drift=%v", missingErr, driftErr)
	}
}

func Test_Stage_restore_receipt_rejects_target_version_drift(t *testing.T) {
	// Given
	source, targetBefore := restoreStageVersions(t)
	spec := validStageSpec()
	spec.SourceVersion = source
	spec.TargetVersionBefore = targetBefore
	stage, err := NewStage(spec)
	if err != nil {
		t.Fatal(err)
	}
	targetAfter, err := NewVersionIdentity(EnginePostgreSQL, "160005")
	if err != nil {
		t.Fatal(err)
	}
	verified := true

	// When
	_, err = stage.RestoreReceiptSpec(targetAfter, VerificationSpec{Version: true, Schema: true, DecodedArtifact: true, Sentinel: &verified})

	// Then
	if !errors.Is(err, ErrStage) {
		t.Fatalf("version drift accepted: %v", err)
	}
}

func Test_NewStage_rejects_cross_engine_or_major_incompatible_versions(t *testing.T) {
	// Given
	spec := validStageSpec()
	crossEngine, err := NewVersionIdentity(EngineMySQL, "16.2")
	if err != nil {
		t.Fatal(err)
	}
	spec.SourceVersion = crossEngine
	majorMismatch := validStageSpec()
	target, err := NewVersionIdentity(EnginePostgreSQL, "170000")
	if err != nil {
		t.Fatal(err)
	}
	majorMismatch.TargetVersionBefore = target

	// When
	_, crossEngineErr := NewStage(spec)
	_, majorErr := NewStage(majorMismatch)

	// Then
	if !errors.Is(crossEngineErr, ErrStage) || !errors.Is(majorErr, ErrStage) {
		t.Fatalf("cross-engine=%v major=%v", crossEngineErr, majorErr)
	}
}

func Test_PostgreSQLVersionIdentity_uses_server_version_num_major(t *testing.T) {
	// Given
	source, sourceErr := NewVersionIdentity(EnginePostgreSQL, "160004")
	patch, patchErr := NewVersionIdentity(EnginePostgreSQL, "160008")
	previous, previousErr := NewVersionIdentity(EnginePostgreSQL, "150012")

	// When
	patchCompatible := source.major() == patch.major()
	majorCompatible := previous.major() == patch.major()
	_, dottedErr := NewVersionIdentity(EnginePostgreSQL, "16.4")

	// Then
	if sourceErr != nil || patchErr != nil || previousErr != nil || !patchCompatible || majorCompatible || !errors.Is(dottedErr, ErrStage) {
		t.Fatalf("source=%v patch=%v previous=%v patch-compatible=%t major-compatible=%t dotted=%v", sourceErr, patchErr, previousErr, patchCompatible, majorCompatible, dottedErr)
	}
}

func Test_StageStore_accepts_restore_stage_with_compatible_versions(t *testing.T) {
	// Given
	source, targetBefore := restoreStageVersions(t)
	spec := validStageSpec()
	spec.SourceVersion = source
	spec.TargetVersionBefore = targetBefore
	stage, err := NewStage(spec)
	path := filepath.Join(newStageTestDirectory(t), StageFileName)
	store := newStageStore(path, time.Now)
	if err != nil || store.write(stage) != nil {
		t.Fatalf("setup error=%v", err)
	}

	// When
	consumed, present, err := store.consumeIfPresent(EnginePostgreSQL, ActionPostgreSQLRestore, DirectionRestore)

	// Then
	if err != nil || !present || consumed.SourceVersion() != source || consumed.TargetVersionBefore() != targetBefore {
		t.Fatalf("stage=%+v present=%t error=%v", consumed, present, err)
	}
}

func Test_StageStore_distinguishes_absent_from_present_invalid_restore_stage(t *testing.T) {
	// Given
	path := filepath.Join(newStageTestDirectory(t), StageFileName)
	store := newStageStore(path, time.Now)

	// When
	_, absent, absentErr := store.consumeIfPresent(EnginePostgreSQL, ActionPostgreSQLRestore, DirectionRestore)
	if err := os.WriteFile(path, []byte("not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, invalid, invalidErr := store.consumeIfPresent(EnginePostgreSQL, ActionPostgreSQLRestore, DirectionRestore)

	// Then
	if absent || absentErr != nil || !invalid || !errors.Is(invalidErr, ErrStage) {
		t.Fatalf("absent=%t/%v invalid=%t/%v", absent, absentErr, invalid, invalidErr)
	}
}
