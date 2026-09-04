package recoveryreceipt

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

const (
	StageFileName = "recovery-stage-v1.json"
	StagePath     = "/var/run/raibit-recovery/scratch/" + StageFileName
	StageMaxAge   = 15 * time.Minute
)

var ErrStage = errors.New("recovery receipt: invalid stage")

type StageSpec struct {
	Engine        Engine
	Action        Action
	Direction     Direction
	DecodedBytes  uint64
	DecodedSHA256 string
	Baseline      BaselineSpec
}

type Stage struct{ spec StageSpec }

func NewStage(spec StageSpec) (Stage, error) {
	if spec.Action.Engine() == "" || spec.Action.Engine() != spec.Engine || spec.Action.Direction() != spec.Direction || !validSHA256(spec.Baseline.SchemaSHA256) || !validSHA256(spec.Baseline.DataSHA256) {
		return Stage{}, ErrStage
	}
	switch spec.Direction {
	case DirectionDump:
		if spec.DecodedBytes != 0 || spec.DecodedSHA256 != "" {
			return Stage{}, ErrStage
		}
	case DirectionRestore:
		if !validEvidence(evidenceSpec{
			engine: spec.Engine, action: spec.Action, direction: spec.Direction,
			decodedBytes: spec.DecodedBytes, decodedSHA256: spec.DecodedSHA256, baseline: spec.Baseline,
		}) {
			return Stage{}, ErrStage
		}
	default:
		return Stage{}, ErrStage
	}
	return Stage{spec: spec}, nil
}

func (s Stage) Engine() Engine         { return s.spec.Engine }
func (s Stage) Action() Action         { return s.spec.Action }
func (s Stage) Direction() Direction   { return s.spec.Direction }
func (s Stage) DecodedBytes() uint64   { return s.spec.DecodedBytes }
func (s Stage) DecodedSHA256() string  { return s.spec.DecodedSHA256 }
func (s Stage) Baseline() BaselineSpec { return s.spec.Baseline }

type DecodedSpec struct {
	Bytes  uint64
	SHA256 string
}

func (s Stage) DumpReceiptSpec(decoded DecodedSpec, verification VerificationSpec) (Spec, error) {
	if s.Direction() != DirectionDump || !validEvidence(evidenceSpec{
		engine: s.Engine(), action: s.Action(), direction: s.Direction(),
		decodedBytes: decoded.Bytes, decodedSHA256: decoded.SHA256, baseline: s.Baseline(),
	}) {
		return Spec{}, ErrStage
	}
	baseline := s.Baseline()
	return Spec{
		Engine: s.Engine(), Action: s.Action(), Direction: s.Direction(),
		DecodedBytes: decoded.Bytes, DecodedSHA256: decoded.SHA256,
		Baseline: &baseline, Verification: cloneVerification(verification),
	}, nil
}

func (s Stage) RestoreReceiptSpec(verification VerificationSpec) (Spec, error) {
	if s.Direction() != DirectionRestore {
		return Spec{}, ErrStage
	}
	baseline := s.Baseline()
	return Spec{
		Engine: s.Engine(), Action: s.Action(), Direction: s.Direction(),
		DecodedBytes: s.DecodedBytes(), DecodedSHA256: s.DecodedSHA256(),
		Baseline: &baseline, Verification: cloneVerification(verification),
	}, nil
}

type stageStore struct {
	path string
	now  func() time.Time
}

func newStageStore(path string, now func() time.Time) stageStore {
	return stageStore{path: path, now: now}
}

func WriteStage(stage Stage) error {
	return newStageStore(StagePath, time.Now).write(stage)
}

func ConsumeStage(engine Engine, action Action, direction Direction) (Stage, error) {
	return newStageStore(StagePath, time.Now).consume(engine, action, direction)
}

func validStageFile(info fs.FileInfo) bool {
	private := runtime.GOOS == "windows" || info.Mode().Perm()&0o077 == 0
	return info.Mode().IsRegular() && info.Mode()&fs.ModeSymlink == 0 && private && info.Size() > 0 && info.Size() <= MaxBytes
}

func validStageDirectory(info fs.FileInfo) bool {
	return info.IsDir() && info.Mode()&fs.ModeSymlink == 0
}

func (s stageStore) write(stage Stage) (resultErr error) {
	if _, err := NewStage(stage.spec); err != nil || s.now == nil || filepath.Base(s.path) != StageFileName {
		return ErrStage
	}
	directory := filepath.Dir(s.path)
	info, err := os.Lstat(directory)
	if err != nil || !validStageDirectory(info) {
		return ErrStage
	}
	payload, err := marshalStage(stage, s.now().UTC())
	if err != nil {
		return ErrStage
	}
	temporary, err := os.CreateTemp(directory, ".recovery-stage-")
	if err != nil {
		return ErrStage
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		if !committed {
			if removeErr := os.Remove(temporaryPath); removeErr != nil && !errors.Is(removeErr, fs.ErrNotExist) {
				resultErr = ErrStage
			}
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		if closeErr := temporary.Close(); closeErr != nil {
			return ErrStage
		}
		return ErrStage
	}
	written, writeErr := temporary.Write(payload)
	syncErr := temporary.Sync()
	closeErr := temporary.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil || written != len(payload) {
		return ErrStage
	}
	if existing, statErr := os.Lstat(s.path); statErr == nil && !validStageFile(existing) {
		return ErrStage
	} else if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
		return ErrStage
	}
	if err := os.Rename(temporaryPath, s.path); err != nil {
		return ErrStage
	}
	committed = true
	return nil
}
