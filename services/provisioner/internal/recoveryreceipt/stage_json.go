package recoveryreceipt

import (
	"bytes"
	"encoding/json"
	"time"
	"unicode/utf8"
)

const stageWireVersion = "raibit-recovery-stage/v1"

type wireStage struct {
	WireVersion         string       `json:"wire_version"`
	Engine              Engine       `json:"engine"`
	Action              Action       `json:"action"`
	Direction           Direction    `json:"direction"`
	DecodedBytes        uint64       `json:"decoded_bytes,omitempty"`
	DecodedSHA256       string       `json:"decoded_sha256,omitempty"`
	Baseline            wireBaseline `json:"baseline"`
	SourceVersion       string       `json:"source_version,omitempty"`
	TargetVersionBefore string       `json:"target_version_before,omitempty"`
	EvidenceRequired    *bool        `json:"evidence_required"`
	IssuedUnix          int64        `json:"issued_unix"`
}

func marshalStage(stage Stage, issued time.Time) ([]byte, error) {
	if issued.IsZero() {
		return nil, ErrStage
	}
	baseline := stage.Baseline()
	evidenceRequired := stage.EvidenceRequired()
	payload, err := json.Marshal(wireStage{
		WireVersion: stageWireVersion, Engine: stage.Engine(), Action: stage.Action(), Direction: stage.Direction(),
		DecodedBytes: stage.DecodedBytes(), DecodedSHA256: stage.DecodedSHA256(), IssuedUnix: issued.Unix(),
		Baseline:      wireBaseline{SchemaSHA256: baseline.SchemaSHA256, DataSHA256: baseline.DataSHA256, RecordCount: baseline.RecordCount},
		SourceVersion: stage.SourceVersion().String(), TargetVersionBefore: stage.TargetVersionBefore().String(),
		EvidenceRequired: &evidenceRequired,
	})
	payload = append(payload, '\n')
	if err != nil || len(payload) > MaxBytes {
		return nil, ErrStage
	}
	return payload, nil
}

func parseStage(payload []byte) (wireStage, error) {
	if len(payload) == 0 || len(payload) > MaxBytes || !utf8.Valid(payload) || rejectDuplicateKeys(payload) != nil {
		return wireStage{}, ErrStage
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var wire wireStage
	if err := decoder.Decode(&wire); err != nil || requireJSONEnd(decoder) != nil || wire.WireVersion != stageWireVersion {
		return wireStage{}, ErrStage
	}
	return wire, nil
}
