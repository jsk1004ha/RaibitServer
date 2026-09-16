package recoveryreceipt

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func Test_StageEvidenceStore_rejects_truncated_wrong_count_and_digest(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(EvidenceDescriptor) EvidenceDescriptor
		alter  func(string) error
	}{
		{name: "truncated sidecar", mutate: func(value EvidenceDescriptor) EvidenceDescriptor { return value }, alter: func(path string) error { return os.WriteFile(path, testEvidence[:len(testEvidence)-1], 0o600) }},
		{name: "wrong byte count", mutate: func(value EvidenceDescriptor) EvidenceDescriptor { value.bytes++; return value }},
		{name: "wrong sha", mutate: func(value EvidenceDescriptor) EvidenceDescriptor { value.sha256 = testSchemaSHA; return value }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Given
			stage, consumer := newCacheEvidenceProtocol(t)
			descriptor, err := consumer.evidence.write(stage, bytes.NewReader(testEvidence))
			if err != nil {
				t.Fatal(err)
			}
			if test.alter != nil {
				if err := test.alter(consumer.evidence.path); err != nil {
					t.Fatal(err)
				}
			}
			binding, err := marshalEvidenceBinding(mustStageFingerprint(t, stage), test.mutate(descriptor))
			bindingPath := filepath.Join(filepath.Dir(consumer.evidence.path), StageEvidenceBindingFileName)
			if err != nil || os.WriteFile(bindingPath, binding, 0o600) != nil {
				t.Fatalf("binding setup=%v", err)
			}

			// When
			_, present, consumeErr := consumer.consumeIfPresent(EngineRedis, ActionRedisRestore, func(io.Reader) error {
				t.Fatal("unauthenticated evidence exposed")
				return nil
			})

			// Then
			if !present || !errors.Is(consumeErr, ErrStage) {
				t.Fatalf("present=%t error=%v", present, consumeErr)
			}
		})
	}
}

func Test_EvidenceBinding_rejects_unknown_duplicate_and_oversized_JSON(t *testing.T) {
	// Given
	stage, _ := NewStage(validCacheRestoreStageSpec())
	fingerprint := mustStageFingerprint(t, stage)
	valid, err := marshalEvidenceBinding(fingerprint, evidenceDescriptorForTest(testEvidence))
	if err != nil {
		t.Fatal(err)
	}
	unknown := bytes.Replace(valid, []byte(`"wire_version"`), []byte(`"secret":"value","wire_version"`), 1)
	duplicate := bytes.Replace(valid, []byte(`"bytes":`), []byte(`"bytes":1,"bytes":`), 1)
	oversized := append(bytes.Clone(valid), bytes.Repeat([]byte(" "), MaxBytes)...)

	// When / Then
	for name, payload := range map[string][]byte{"unknown": unknown, "duplicate": duplicate, "oversized": oversized} {
		if _, _, err := parseEvidenceBinding(payload); !errors.Is(err, ErrStage) {
			t.Fatalf("%s accepted: %v", name, err)
		}
	}
}

func Test_StageEvidenceStore_rejects_reparse_and_replacement_race(t *testing.T) {
	// Given
	stage, reparseConsumer := newCacheEvidenceProtocol(t)
	if _, err := reparseConsumer.evidence.write(stage, bytes.NewReader(testEvidence)); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(reparseConsumer.evidence.path); err != nil {
		t.Fatal(err)
	}
	createStageReparse(t, filepath.Dir(reparseConsumer.evidence.path), reparseConsumer.evidence.path)

	// When
	_, _, reparseErr := reparseConsumer.consumeIfPresent(EngineRedis, ActionRedisRestore, func(io.Reader) error { return nil })
	raceStage, raceConsumer := newCacheEvidenceProtocol(t)
	if _, err := raceConsumer.evidence.write(raceStage, bytes.NewReader(testEvidence)); err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(filepath.Dir(raceConsumer.evidence.path), "evidence-replacement")
	if err := os.WriteFile(replacement, testEvidence, 0o600); err != nil {
		t.Fatal(err)
	}
	raceConsumer.evidence.beforeOpen = func(root *os.Root, claimed string) error {
		if err := root.Remove(claimed); err != nil {
			return err
		}
		return root.Rename(filepath.Base(replacement), claimed)
	}
	_, _, raceErr := raceConsumer.consumeIfPresent(EngineRedis, ActionRedisRestore, func(io.Reader) error { return nil })

	// Then
	if !errors.Is(reparseErr, ErrStage) || !errors.Is(raceErr, ErrStage) {
		t.Fatalf("reparse=%v race=%v", reparseErr, raceErr)
	}
}

func Test_StageEvidenceStore_does_not_unlink_replacement_before_remove(t *testing.T) {
	// Given
	stage, consumer := newCacheEvidenceProtocol(t)
	if _, err := consumer.evidence.write(stage, bytes.NewReader(testEvidence)); err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(filepath.Dir(consumer.evidence.path), "late-replacement")
	if err := os.WriteFile(replacement, []byte("attacker-owned"), 0o600); err != nil {
		t.Fatal(err)
	}
	consumer.evidence.beforeRemove = func(root *os.Root, claimed string) error {
		if err := root.Remove(claimed); err != nil {
			return err
		}
		return root.Rename(filepath.Base(replacement), claimed)
	}

	// When
	_, present, consumeErr := consumer.consumeIfPresent(EngineRedis, ActionRedisRestore, func(io.Reader) error { return nil })

	// Then
	entries, readErr := os.ReadDir(filepath.Dir(consumer.evidence.path))
	replacementPreserved := false
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".recovery-stage-claim-") {
			replacementPreserved = true
		}
	}
	if !present || !errors.Is(consumeErr, ErrStage) || readErr != nil || !replacementPreserved {
		t.Fatalf("present=%t error=%v read=%v preserved=%t", present, consumeErr, readErr, replacementPreserved)
	}
}

func Test_StageEvidenceStore_rejects_wrong_file_permissions(t *testing.T) {
	// Given
	stage, consumer := newCacheEvidenceProtocol(t)
	if _, err := consumer.evidence.write(stage, bytes.NewReader(testEvidence)); err != nil {
		t.Fatal(err)
	}
	makeStageObjectUnsafe(t, consumer.evidence.path)

	// When
	_, present, consumeErr := consumer.consumeIfPresent(EngineRedis, ActionRedisRestore, func(io.Reader) error { return nil })

	// Then
	if !present || !errors.Is(consumeErr, ErrStage) {
		t.Fatalf("present=%t error=%v", present, consumeErr)
	}
}

func Test_DatabaseRestoreStage_rejects_cache_companions(t *testing.T) {
	// Given
	directory := newStageTestDirectory(t)
	stage, err := NewStage(validStageSpec())
	consumer := restoreStageConsumer{
		stages:   newStageStore(filepath.Join(directory, StageFileName), time.Now),
		evidence: newStageEvidenceStore(filepath.Join(directory, StageEvidenceFileName)),
	}
	if err != nil || consumer.stages.write(stage) != nil || os.WriteFile(consumer.evidence.path, testEvidence, 0o600) != nil {
		t.Fatalf("setup=%v", err)
	}

	// When
	_, present, consumeErr := consumer.consumeIfPresent(EnginePostgreSQL, ActionPostgreSQLRestore, nil)

	// Then
	if !present || !errors.Is(consumeErr, ErrStage) {
		t.Fatalf("present=%t error=%v", present, consumeErr)
	}
}

func mustStageFingerprint(t *testing.T, stage Stage) string {
	t.Helper()
	fingerprint, err := fingerprintStage(stage)
	if err != nil {
		t.Fatal(err)
	}
	return fingerprint
}

func evidenceDescriptorForTest(payload []byte) EvidenceDescriptor {
	digest := sha256.Sum256(payload)
	return EvidenceDescriptor{bytes: uint64(len(payload)), sha256: hex.EncodeToString(digest[:])}
}
