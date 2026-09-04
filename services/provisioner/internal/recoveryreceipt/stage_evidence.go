package recoveryreceipt

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

const evidenceBindingWireVersion = "raibit-recovery-evidence-binding/v1"

type EvidenceDescriptor struct {
	bytes  uint64
	sha256 string
}

func (d EvidenceDescriptor) Bytes() uint64  { return d.bytes }
func (d EvidenceDescriptor) SHA256() string { return d.sha256 }
func (d EvidenceDescriptor) valid() bool {
	return d.bytes > 0 && d.bytes <= StageEvidenceMaxBytes && validSHA256(d.sha256)
}

type EvidenceVerifier func(io.Reader) error

type stageEvidenceStore struct {
	path         string
	now          func() time.Time
	beforeOpen   func(*os.Root, string) error
	beforeRemove func(*os.Root, string) error
}

func newStageEvidenceStore(path string) stageEvidenceStore {
	return stageEvidenceStore{path: path, now: time.Now}
}

type restoreStageConsumer struct {
	stages   stageStore
	evidence stageEvidenceStore
}

func WriteStageEvidence(stage Stage, source io.Reader) (EvidenceDescriptor, error) {
	return newStageEvidenceStore(StageEvidencePath).write(stage, source)
}

// ConsumeRestoreStageIfPresent treats only complete protocol absence as source preflight.
// Any intent or orphan companion denotes target finalization and fails closed on mismatch.
func ConsumeRestoreStageIfPresent(engine Engine, action Action, verifier EvidenceVerifier) (Stage, bool, error) {
	consumer := restoreStageConsumer{stages: newStageStore(StagePath, time.Now), evidence: newStageEvidenceStore(StageEvidencePath)}
	return consumer.consumeIfPresent(engine, action, verifier)
}

func (c restoreStageConsumer) consumeIfPresent(engine Engine, action Action, verifier EvidenceVerifier) (Stage, bool, error) {
	if action.Engine() != engine || action.Direction() != DirectionRestore {
		return Stage{}, false, ErrStage
	}
	stage, present, err := c.stages.consumeIfPresent(engine, action, DirectionRestore)
	if err != nil {
		return Stage{}, present, ErrStage
	}
	if !present {
		companions, companionErr := c.evidence.companionsPresent()
		if companionErr != nil || companions {
			return Stage{}, true, ErrStage
		}
		return Stage{}, false, nil
	}
	if !stage.EvidenceRequired() {
		companions, companionErr := c.evidence.companionsPresent()
		if verifier != nil || companionErr != nil || companions {
			return Stage{}, true, ErrStage
		}
		return stage, true, nil
	}
	if verifier == nil || c.evidence.consume(stage, verifier) != nil {
		return Stage{}, true, ErrStage
	}
	stage.evidenceVerified = true
	return stage, true, nil
}

func (s stageEvidenceStore) write(stage Stage, source io.Reader) (result EvidenceDescriptor, resultErr error) {
	if source == nil || filepath.Base(s.path) != StageEvidenceFileName || stage.Direction() != DirectionRestore || !stage.EvidenceRequired() || s.now == nil {
		return EvidenceDescriptor{}, ErrStage
	}
	root, err := openStageRoot(s.path)
	if err != nil {
		return EvidenceDescriptor{}, ErrStage
	}
	defer func() {
		if root.close() != nil {
			result, resultErr = EvidenceDescriptor{}, ErrStage
		}
	}()
	observed, err := peekStage(root, stage, s.now())
	if err != nil || observed.spec != stage.spec {
		return EvidenceDescriptor{}, ErrStage
	}
	descriptor, err := publishScratch(root, StageEvidenceFileName, source, StageEvidenceMaxBytes)
	if err != nil {
		return EvidenceDescriptor{}, ErrStage
	}
	fingerprint, err := fingerprintStage(stage)
	if err != nil {
		return EvidenceDescriptor{}, ErrStage
	}
	binding, err := marshalEvidenceBinding(fingerprint, descriptor)
	if err != nil {
		return EvidenceDescriptor{}, ErrStage
	}
	if _, err := publishScratch(root, StageEvidenceBindingFileName, bytes.NewReader(binding), MaxBytes); err != nil {
		return EvidenceDescriptor{}, ErrStage
	}
	return descriptor, nil
}

func (s stageEvidenceStore) companionsPresent() (present bool, resultErr error) {
	root, err := openStageRoot(s.path)
	if err != nil {
		return false, ErrStage
	}
	defer func() {
		if root.close() != nil {
			present, resultErr = false, ErrStage
		}
	}()
	for _, name := range []string{StageEvidenceFileName, StageEvidenceBindingFileName} {
		if _, err := root.root.Lstat(name); err == nil {
			return true, nil
		} else if !errors.Is(err, fs.ErrNotExist) {
			return false, ErrStage
		}
	}
	return false, nil
}
