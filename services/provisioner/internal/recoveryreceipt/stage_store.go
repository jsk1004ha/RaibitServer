package recoveryreceipt

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

type stageRoot struct {
	root      *os.Root
	directory *os.File
}

func openStageRoot(path string) (stageRoot, error) {
	directory := filepath.Dir(path)
	handle, err := openStageDirectory(directory)
	if err != nil {
		return stageRoot{}, ErrStage
	}
	actual, err := handle.Stat()
	if err != nil || !secureStageObject(handle, actual, true) {
		if closeErr := handle.Close(); closeErr != nil {
			return stageRoot{}, ErrStage
		}
		return stageRoot{}, ErrStage
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		if closeErr := handle.Close(); closeErr != nil {
			return stageRoot{}, ErrStage
		}
		return stageRoot{}, ErrStage
	}
	rootHandle, err := root.Open(".")
	if err != nil {
		if closeErr := handle.Close(); closeErr != nil {
			return stageRoot{}, ErrStage
		}
		if closeErr := root.Close(); closeErr != nil {
			return stageRoot{}, ErrStage
		}
		return stageRoot{}, ErrStage
	}
	rootInfo, err := rootHandle.Stat()
	if closeErr := rootHandle.Close(); closeErr != nil {
		err = closeErr
	}
	if err != nil || !os.SameFile(actual, rootInfo) {
		if closeErr := handle.Close(); closeErr != nil {
			return stageRoot{}, ErrStage
		}
		if closeErr := root.Close(); closeErr != nil {
			return stageRoot{}, ErrStage
		}
		return stageRoot{}, ErrStage
	}
	return stageRoot{root: root, directory: handle}, nil
}

func (r stageRoot) close() error {
	return errors.Join(r.directory.Close(), r.root.Close())
}

func (s stageStore) write(stage Stage) (resultErr error) {
	if _, err := NewStage(stage.spec); err != nil || s.now == nil || filepath.Base(s.path) != StageFileName {
		return ErrStage
	}
	payload, err := marshalStage(stage, s.now().UTC())
	if err != nil {
		return ErrStage
	}
	root, err := openStageRoot(s.path)
	if err != nil {
		return ErrStage
	}
	defer func() {
		if root.close() != nil {
			resultErr = ErrStage
		}
	}()
	nonce, err := stageNonce()
	if err != nil {
		return ErrStage
	}
	temporaryName := ".recovery-stage-write-" + nonce
	temporary, err := root.root.OpenFile(temporaryName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return ErrStage
	}
	cleanupNeeded := true
	defer func() {
		if cleanupNeeded {
			if removeErr := root.root.Remove(temporaryName); removeErr != nil && !errors.Is(removeErr, fs.ErrNotExist) {
				resultErr = ErrStage
			}
		}
	}()
	written, writeErr := temporary.Write(payload)
	syncErr := temporary.Sync()
	info, statErr := temporary.Stat()
	secure := statErr == nil && secureStageObject(temporary, info, false)
	closeErr := temporary.Close()
	if writeErr != nil || syncErr != nil || !secure || closeErr != nil || written != len(payload) {
		return ErrStage
	}
	if err := root.root.Link(temporaryName, StageFileName); err != nil {
		return ErrStage
	}
	if err := root.root.Remove(temporaryName); err != nil {
		return ErrStage
	}
	cleanupNeeded = false
	if err := syncStageDirectory(root.directory); err != nil {
		return ErrStage
	}
	return nil
}

func (s stageStore) consume(engine Engine, action Action, direction Direction) (Stage, error) {
	stage, present, err := s.consumeIfPresent(engine, action, direction)
	if err != nil || !present {
		return Stage{}, ErrStage
	}
	return stage, nil
}

func (s stageStore) consumeIfPresent(engine Engine, action Action, direction Direction) (result Stage, present bool, resultErr error) {
	if s.now == nil || filepath.Base(s.path) != StageFileName {
		return Stage{}, false, ErrStage
	}
	root, err := openStageRoot(s.path)
	if err != nil {
		return Stage{}, false, ErrStage
	}
	defer func() {
		if root.close() != nil {
			result, resultErr = Stage{}, ErrStage
		}
	}()
	if _, err := root.root.Lstat(StageFileName); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return Stage{}, false, nil
		}
		return Stage{}, true, ErrStage
	}
	claim, err := claimScratch(root, scratchClaimSpec{name: StageFileName, maxBytes: MaxBytes, beforeOpen: s.beforeOpen, beforeRemove: s.beforeRemove})
	if err != nil {
		return Stage{}, true, ErrStage
	}
	present = true
	pathInfo, err := claim.file.Stat()
	if err != nil {
		if closeErr := claim.close(); closeErr != nil {
			return Stage{}, true, ErrStage
		}
		return Stage{}, true, ErrStage
	}
	payload, readErr := readBoundedStage(claim.file, pathInfo)
	closeErr := claim.close()
	if readErr != nil || closeErr != nil {
		return Stage{}, true, ErrStage
	}
	stage, err := decodeStage(payload, s.now(), stageExpectation{engine: engine, action: action, direction: direction})
	if err != nil {
		return Stage{}, true, ErrStage
	}
	return stage, true, nil
}

type stageExpectation struct {
	engine    Engine
	action    Action
	direction Direction
}

func decodeStage(payload []byte, now time.Time, expected stageExpectation) (Stage, error) {
	wire, err := parseStage(payload)
	if err != nil || wire.EvidenceRequired == nil {
		return Stage{}, ErrStage
	}
	age := now.UTC().Sub(time.Unix(wire.IssuedUnix, 0).UTC())
	if age < -time.Minute || age > StageMaxAge || wire.Engine != expected.engine || wire.Action != expected.action || wire.Direction != expected.direction {
		return Stage{}, ErrStage
	}
	sourceVersion, sourceErr := parseOptionalVersion(wire.Engine, wire.SourceVersion)
	targetVersion, targetErr := parseOptionalVersion(wire.Engine, wire.TargetVersionBefore)
	if sourceErr != nil || targetErr != nil {
		return Stage{}, ErrStage
	}
	return NewStage(StageSpec{
		Engine: wire.Engine, Action: wire.Action, Direction: wire.Direction,
		DecodedBytes: wire.DecodedBytes, DecodedSHA256: wire.DecodedSHA256,
		Baseline:      BaselineSpec{SchemaSHA256: wire.Baseline.SchemaSHA256, DataSHA256: wire.Baseline.DataSHA256, RecordCount: wire.Baseline.RecordCount},
		SourceVersion: sourceVersion, TargetVersionBefore: targetVersion,
		EvidenceRequired: *wire.EvidenceRequired,
	})
}

func readBoundedStage(file *os.File, pathInfo fs.FileInfo) ([]byte, error) {
	actual, err := file.Stat()
	if err != nil || !os.SameFile(pathInfo, actual) || !secureStageObject(file, actual, false) || actual.Size() <= 0 || actual.Size() > MaxBytes {
		return nil, ErrStage
	}
	payload, err := io.ReadAll(io.LimitReader(file, MaxBytes+1))
	if err != nil || len(payload) == 0 || len(payload) > MaxBytes {
		return nil, ErrStage
	}
	return payload, nil
}

func parseOptionalVersion(engine Engine, value string) (VersionIdentity, error) {
	if value == "" {
		return VersionIdentity{}, nil
	}
	return NewVersionIdentity(engine, value)
}

func stageNonce() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", ErrStage
	}
	return hex.EncodeToString(value[:]), nil
}
