package recoveryreceipt

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func Test_StageStore_interrupted_claim_never_becomes_absent(t *testing.T) {
	// Given
	path := filepath.Join(newStageTestDirectory(t), StageFileName)
	store := newStageStore(path, time.Now)
	stage, err := NewStage(validStageSpec())
	if err != nil || store.write(stage) != nil {
		t.Fatalf("setup=%v", err)
	}
	store.beforeOpen = func(*os.Root, string) error { return errors.New("injected interruption") }

	// When
	_, firstPresent, firstErr := store.consumeIfPresent(EnginePostgreSQL, ActionPostgreSQLRestore, DirectionRestore)
	retry := newStageStore(path, time.Now)
	_, retryPresent, retryErr := retry.consumeIfPresent(EnginePostgreSQL, ActionPostgreSQLRestore, DirectionRestore)

	// Then
	if !firstPresent || !errors.Is(firstErr, ErrStage) || !retryPresent || !errors.Is(retryErr, ErrStage) {
		t.Fatalf("first=%t/%v retry=%t/%v", firstPresent, firstErr, retryPresent, retryErr)
	}
}

func Test_RestoreConsumer_interrupted_evidence_claim_never_becomes_source_preflight(t *testing.T) {
	// Given
	stage, consumer := newCacheEvidenceProtocol(t)
	if _, err := consumer.evidence.write(stage, bytes.NewReader(testEvidence)); err != nil {
		t.Fatal(err)
	}
	consumer.evidence.beforeOpen = func(*os.Root, string) error { return errors.New("injected interruption") }

	// When
	_, firstPresent, firstErr := consumer.consumeIfPresent(EngineRedis, ActionRedisRestore, func(io.Reader) error { return nil })
	retry := restoreStageConsumer{stages: consumer.stages, evidence: newStageEvidenceStore(consumer.evidence.path)}
	_, retryPresent, retryErr := retry.consumeIfPresent(EngineRedis, ActionRedisRestore, nil)

	// Then
	if !firstPresent || !errors.Is(firstErr, ErrStage) || !retryPresent || !errors.Is(retryErr, ErrStage) {
		t.Fatalf("first=%t/%v retry=%t/%v", firstPresent, firstErr, retryPresent, retryErr)
	}
}

func Test_RestoreConsumer_interrupted_binding_claim_never_becomes_source_preflight(t *testing.T) {
	// Given
	stage, consumer := newCacheEvidenceProtocol(t)
	if _, err := consumer.evidence.write(stage, bytes.NewReader(testEvidence)); err != nil {
		t.Fatal(err)
	}
	consumer.evidence.beforeBindingOpen = func(*os.Root, string) error { return errors.New("injected interruption") }

	// When
	_, firstPresent, firstErr := consumer.consumeIfPresent(EngineRedis, ActionRedisRestore, func(io.Reader) error { return nil })
	retry := restoreStageConsumer{stages: consumer.stages, evidence: newStageEvidenceStore(consumer.evidence.path)}
	_, retryPresent, retryErr := retry.consumeIfPresent(EngineRedis, ActionRedisRestore, nil)

	// Then
	if !firstPresent || !errors.Is(firstErr, ErrStage) || !retryPresent || !errors.Is(retryErr, ErrStage) {
		t.Fatalf("first=%t/%v retry=%t/%v", firstPresent, firstErr, retryPresent, retryErr)
	}
}

func Test_RestoreConsumer_rejects_malformed_stale_and_foreign_claims(t *testing.T) {
	for _, test := range []struct {
		name  string
		claim string
		setup func(*testing.T, string)
	}{
		{name: "malformed", claim: ".recovery-stage-claim-not-a-nonce", setup: writePrivateClaim},
		{name: "stale", claim: ".recovery-stage-claim-00000000000000000000000000000000", setup: writeStaleStageClaim},
		{name: "foreign reparse", claim: ".recovery-stage-claim-11111111111111111111111111111111", setup: createClaimReparse},
		{name: "foreign permissions", claim: ".recovery-stage-claim-22222222222222222222222222222222", setup: writeForeignClaim},
	} {
		t.Run(test.name, func(t *testing.T) {
			// Given
			directory := newStageTestDirectory(t)
			test.setup(t, filepath.Join(directory, test.claim))
			consumer := restoreStageConsumer{
				stages:   newStageStore(filepath.Join(directory, StageFileName), time.Now),
				evidence: newStageEvidenceStore(filepath.Join(directory, StageEvidenceFileName)),
			}

			// When
			_, present, err := consumer.consumeIfPresent(EngineRedis, ActionRedisRestore, nil)

			// Then
			if !present || !errors.Is(err, ErrStage) {
				t.Fatalf("present=%t error=%v", present, err)
			}
		})
	}
}

func writePrivateClaim(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("interrupted"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func createClaimReparse(t *testing.T, path string) {
	t.Helper()
	createStageReparse(t, filepath.Dir(path), path)
}

func writeStaleStageClaim(t *testing.T, path string) {
	t.Helper()
	stage, err := NewStage(validStageSpec())
	payload, marshalErr := marshalStage(stage, time.Now().Add(-StageMaxAge-time.Minute))
	if err != nil || marshalErr != nil || os.WriteFile(path, payload, 0o600) != nil {
		t.Fatalf("stage=%v marshal=%v", err, marshalErr)
	}
}

func writeForeignClaim(t *testing.T, path string) {
	t.Helper()
	writePrivateClaim(t, path)
	makeStageObjectUnsafe(t, path)
}
