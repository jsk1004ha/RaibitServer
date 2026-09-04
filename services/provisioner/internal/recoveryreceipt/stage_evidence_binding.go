package recoveryreceipt

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"time"
	"unicode/utf8"
)

type evidenceBinding struct {
	WireVersion      string `json:"wire_version"`
	StageFingerprint string `json:"stage_sha256"`
	Bytes            uint64 `json:"bytes"`
	SHA256           string `json:"sha256"`
}

func marshalEvidenceBinding(fingerprint string, descriptor EvidenceDescriptor) ([]byte, error) {
	if !validSHA256(fingerprint) || !descriptor.valid() {
		return nil, ErrStage
	}
	payload, err := json.Marshal(evidenceBinding{WireVersion: evidenceBindingWireVersion, StageFingerprint: fingerprint, Bytes: descriptor.bytes, SHA256: descriptor.sha256})
	payload = append(payload, '\n')
	if err != nil || len(payload) > MaxBytes {
		return nil, ErrStage
	}
	return payload, nil
}

func parseEvidenceBinding(payload []byte) (EvidenceDescriptor, string, error) {
	if len(payload) == 0 || len(payload) > MaxBytes || !utf8.Valid(payload) || rejectDuplicateKeys(payload) != nil {
		return EvidenceDescriptor{}, "", ErrStage
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var binding evidenceBinding
	if err := decoder.Decode(&binding); err != nil || requireJSONEnd(decoder) != nil || binding.WireVersion != evidenceBindingWireVersion || !validSHA256(binding.StageFingerprint) {
		return EvidenceDescriptor{}, "", ErrStage
	}
	descriptor := EvidenceDescriptor{bytes: binding.Bytes, sha256: binding.SHA256}
	if !descriptor.valid() {
		return EvidenceDescriptor{}, "", ErrStage
	}
	return descriptor, binding.StageFingerprint, nil
}

func fingerprintStage(stage Stage) (string, error) {
	if _, err := NewStage(stage.spec); err != nil {
		return "", ErrStage
	}
	payload, err := json.Marshal(struct {
		Engine              Engine       `json:"engine"`
		Action              Action       `json:"action"`
		Direction           Direction    `json:"direction"`
		DecodedBytes        uint64       `json:"decoded_bytes"`
		DecodedSHA256       string       `json:"decoded_sha256"`
		Baseline            BaselineSpec `json:"baseline"`
		SourceVersion       string       `json:"source_version"`
		TargetVersionBefore string       `json:"target_version_before"`
		EvidenceRequired    bool         `json:"evidence_required"`
	}{
		Engine: stage.Engine(), Action: stage.Action(), Direction: stage.Direction(),
		DecodedBytes: stage.DecodedBytes(), DecodedSHA256: stage.DecodedSHA256(), Baseline: stage.Baseline(),
		SourceVersion: stage.SourceVersion().String(), TargetVersionBefore: stage.TargetVersionBefore().String(), EvidenceRequired: stage.EvidenceRequired(),
	})
	if err != nil {
		return "", ErrStage
	}
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:]), nil
}

func peekStage(root stageRoot, expected Stage, now time.Time) (Stage, error) {
	pathInfo, err := root.root.Lstat(StageFileName)
	if err != nil || !pathInfo.Mode().IsRegular() {
		return Stage{}, ErrStage
	}
	file, err := openStageFile(root.root, root.directory, StageFileName)
	if err != nil {
		return Stage{}, ErrStage
	}
	payload, readErr := readBoundedStage(file, pathInfo)
	closeErr := file.Close()
	if readErr != nil || closeErr != nil {
		return Stage{}, ErrStage
	}
	return decodeStage(payload, now, stageExpectation{engine: expected.Engine(), action: expected.Action(), direction: expected.Direction()})
}

func (s stageEvidenceStore) consume(stage Stage, verifier EvidenceVerifier) (resultErr error) {
	root, err := openStageRoot(s.path)
	if err != nil {
		return ErrStage
	}
	defer func() {
		if root.close() != nil {
			resultErr = ErrStage
		}
	}()
	binding, err := claimScratch(root, scratchClaimSpec{name: StageEvidenceBindingFileName, maxBytes: MaxBytes})
	if err != nil {
		return ErrStage
	}
	defer func() {
		if binding.close() != nil {
			resultErr = ErrStage
		}
	}()
	payload, err := io.ReadAll(io.LimitReader(binding.file, MaxBytes+1))
	descriptor, fingerprint, parseErr := parseEvidenceBinding(payload)
	want, fingerprintErr := fingerprintStage(stage)
	if err != nil || parseErr != nil || fingerprintErr != nil || fingerprint != want {
		return ErrStage
	}
	evidence, err := claimScratch(root, scratchClaimSpec{
		name: StageEvidenceFileName, maxBytes: StageEvidenceMaxBytes,
		beforeOpen: s.beforeOpen, beforeRemove: s.beforeRemove,
	})
	if err != nil {
		return ErrStage
	}
	defer func() {
		if evidence.close() != nil {
			resultErr = ErrStage
		}
	}()
	if authenticateEvidence(evidence.file, descriptor) != nil {
		return ErrStage
	}
	if _, err := evidence.file.Seek(0, io.SeekStart); err != nil || verifier(evidence.file) != nil {
		return ErrStage
	}
	return nil
}
