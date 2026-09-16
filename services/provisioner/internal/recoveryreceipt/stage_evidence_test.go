package recoveryreceipt

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var testEvidence = []byte("key-digest\nvalue-digest\nttl-duration-digest\n")

func validCacheRestoreStageSpec() StageSpec {
	return StageSpec{
		Engine: EngineRedis, Action: ActionRedisRestore, Direction: DirectionRestore,
		DecodedBytes: 128, DecodedSHA256: testDecodedSHA,
		Baseline:            BaselineSpec{SchemaSHA256: testSchemaSHA, DataSHA256: testDataSHA, RecordCount: 7},
		SourceVersion:       VersionIdentity{engine: EngineRedis, value: "7.2.4"},
		TargetVersionBefore: VersionIdentity{engine: EngineRedis, value: "7.2.8"},
		EvidenceRequired:    true,
	}
}

func newCacheEvidenceProtocol(t *testing.T) (Stage, restoreStageConsumer) {
	t.Helper()
	directory := newStageTestDirectory(t)
	stage, err := NewStage(validCacheRestoreStageSpec())
	consumer := restoreStageConsumer{
		stages:   newStageStore(filepath.Join(directory, StageFileName), time.Now),
		evidence: newStageEvidenceStore(filepath.Join(directory, StageEvidenceFileName)),
	}
	if err != nil || consumer.stages.write(stage) != nil {
		t.Fatalf("setup error=%v", err)
	}
	return stage, consumer
}

func Test_NewStage_requires_evidence_protocol_only_for_cache_restore(t *testing.T) {
	// Given
	cacheMissing := validCacheRestoreStageSpec()
	cacheMissing.EvidenceRequired = false
	databaseUnexpected := validStageSpec()
	databaseUnexpected.EvidenceRequired = true
	dumpUnexpected := validDumpStageSpec()
	dumpUnexpected.EvidenceRequired = true

	// When
	_, cacheErr := NewStage(cacheMissing)
	_, databaseErr := NewStage(databaseUnexpected)
	_, dumpErr := NewStage(dumpUnexpected)

	// Then
	if !errors.Is(cacheErr, ErrStage) || !errors.Is(databaseErr, ErrStage) || !errors.Is(dumpErr, ErrStage) {
		t.Fatalf("cache=%v database=%v dump=%v", cacheErr, databaseErr, dumpErr)
	}
}

func Test_RestoreStageConsumer_authenticates_cache_evidence_exactly_once(t *testing.T) {
	// Given
	stage, consumer := newCacheEvidenceProtocol(t)
	descriptor, err := consumer.evidence.write(stage, bytes.NewReader(testEvidence))
	if err != nil {
		t.Fatal(err)
	}
	var observed []byte

	// When
	consumed, present, consumeErr := consumer.consumeIfPresent(EngineRedis, ActionRedisRestore, func(reader io.Reader) error {
		observed, err = io.ReadAll(reader)
		return err
	})
	_, secondPresent, secondErr := consumer.consumeIfPresent(EngineRedis, ActionRedisRestore, func(io.Reader) error { return nil })

	// Then
	after, _ := NewVersionIdentity(EngineRedis, "7.2.8")
	_, receiptErr := consumed.RestoreReceiptSpec(after, VerificationSpec{Version: true, Schema: true, DecodedArtifact: true})
	if consumeErr != nil || !present || descriptor.Bytes() != uint64(len(testEvidence)) || !bytes.Equal(observed, testEvidence) || receiptErr != nil || secondPresent || secondErr != nil {
		t.Fatalf("consume=%v present=%t descriptor=%+v receipt=%v second=%t/%v", consumeErr, present, descriptor, receiptErr, secondPresent, secondErr)
	}
}

func Test_CacheRestoreStage_cannot_build_receipt_before_evidence_authentication(t *testing.T) {
	// Given
	stage, err := NewStage(validCacheRestoreStageSpec())
	after, versionErr := NewVersionIdentity(EngineRedis, "7.2.8")

	// When
	_, receiptErr := stage.RestoreReceiptSpec(after, VerificationSpec{Version: true, Schema: true, DecodedArtifact: true})

	// Then
	if err != nil || versionErr != nil || !errors.Is(receiptErr, ErrStage) {
		t.Fatalf("stage=%v version=%v receipt=%v", err, versionErr, receiptErr)
	}
}

func Test_RestoreStageConsumer_distinguishes_absence_from_orphan_companions(t *testing.T) {
	for _, orphanName := range []string{StageEvidenceFileName, StageEvidenceBindingFileName} {
		t.Run(orphanName, func(t *testing.T) {
			// Given
			directory := newStageTestDirectory(t)
			consumer := restoreStageConsumer{
				stages:   newStageStore(filepath.Join(directory, StageFileName), time.Now),
				evidence: newStageEvidenceStore(filepath.Join(directory, StageEvidenceFileName)),
			}

			// When
			_, absent, absentErr := consumer.consumeIfPresent(EngineRedis, ActionRedisRestore, nil)
			if err := os.WriteFile(filepath.Join(directory, orphanName), []byte("orphan"), 0o600); err != nil {
				t.Fatal(err)
			}
			_, orphan, orphanErr := consumer.consumeIfPresent(EngineRedis, ActionRedisRestore, nil)

			// Then
			if absent || absentErr != nil || !orphan || !errors.Is(orphanErr, ErrStage) {
				t.Fatalf("absent=%t/%v orphan=%t/%v", absent, absentErr, orphan, orphanErr)
			}
		})
	}
}

func Test_StageEvidenceStore_rejects_oversized_and_preexisting_state(t *testing.T) {
	// Given
	stage, consumer := newCacheEvidenceProtocol(t)
	oversized := strings.NewReader(strings.Repeat("x", StageEvidenceMaxBytes+1))

	// When
	_, oversizedErr := consumer.evidence.write(stage, oversized)
	if err := os.WriteFile(consumer.evidence.path, []byte("invalid"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, existingErr := consumer.evidence.write(stage, bytes.NewReader(testEvidence))

	// Then
	contents, readErr := os.ReadFile(consumer.evidence.path)
	if !errors.Is(oversizedErr, ErrStage) || !errors.Is(existingErr, ErrStage) || readErr != nil || string(contents) != "invalid" {
		t.Fatalf("oversized=%v existing=%v read=%v contents=%q", oversizedErr, existingErr, readErr, contents)
	}
}

func Test_StageEvidenceStore_never_replaces_existing_binding(t *testing.T) {
	// Given
	stage, consumer := newCacheEvidenceProtocol(t)
	bindingPath := filepath.Join(filepath.Dir(consumer.evidence.path), StageEvidenceBindingFileName)
	if err := os.WriteFile(bindingPath, []byte("invalid"), 0o600); err != nil {
		t.Fatal(err)
	}

	// When
	_, err := consumer.evidence.write(stage, bytes.NewReader(testEvidence))

	// Then
	contents, readErr := os.ReadFile(bindingPath)
	if !errors.Is(err, ErrStage) || readErr != nil || string(contents) != "invalid" {
		t.Fatalf("error=%v read=%v contents=%q", err, readErr, contents)
	}
}

func Test_StageEvidenceStore_concurrent_publish_has_exactly_one_winner(t *testing.T) {
	// Given
	stage, consumer := newCacheEvidenceProtocol(t)
	start := make(chan struct{})
	results := make(chan error, 2)
	var writers sync.WaitGroup
	for range 2 {
		writers.Add(1)
		go func() {
			defer writers.Done()
			<-start
			_, err := consumer.evidence.write(stage, bytes.NewReader(testEvidence))
			results <- err
		}()
	}

	// When
	close(start)
	writers.Wait()
	close(results)

	// Then
	winners, rejected := 0, 0
	for err := range results {
		if err == nil {
			winners++
		} else if errors.Is(err, ErrStage) {
			rejected++
		}
	}
	if winners != 1 || rejected != 1 {
		t.Fatalf("winners=%d rejected=%d", winners, rejected)
	}
}
