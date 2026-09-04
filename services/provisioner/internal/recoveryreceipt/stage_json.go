package recoveryreceipt

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"time"
	"unicode/utf8"
)

const stageWireVersion = "raibit-recovery-stage/v1"

type wireStage struct {
	WireVersion   string       `json:"wire_version"`
	Engine        Engine       `json:"engine"`
	Action        Action       `json:"action"`
	Direction     Direction    `json:"direction"`
	DecodedBytes  uint64       `json:"decoded_bytes,omitempty"`
	DecodedSHA256 string       `json:"decoded_sha256,omitempty"`
	Baseline      wireBaseline `json:"baseline"`
	IssuedUnix    int64        `json:"issued_unix"`
}

func marshalStage(stage Stage, issued time.Time) ([]byte, error) {
	if issued.IsZero() {
		return nil, ErrStage
	}
	baseline := stage.Baseline()
	payload, err := json.Marshal(wireStage{
		WireVersion: stageWireVersion, Engine: stage.Engine(), Action: stage.Action(), Direction: stage.Direction(),
		DecodedBytes: stage.DecodedBytes(), DecodedSHA256: stage.DecodedSHA256(), IssuedUnix: issued.Unix(),
		Baseline: wireBaseline{SchemaSHA256: baseline.SchemaSHA256, DataSHA256: baseline.DataSHA256, RecordCount: baseline.RecordCount},
	})
	payload = append(payload, '\n')
	if err != nil || len(payload) > MaxBytes {
		return nil, ErrStage
	}
	return payload, nil
}

func (s stageStore) consume(engine Engine, action Action, direction Direction) (Stage, error) {
	info, err := os.Lstat(s.path)
	if err != nil || !validStageFile(info) || s.now == nil {
		return Stage{}, ErrStage
	}
	payload, readErr := readBoundedStage(s.path)
	removeErr := os.Remove(s.path)
	if readErr != nil || removeErr != nil {
		return Stage{}, ErrStage
	}
	wire, err := parseStage(payload)
	if err != nil {
		return Stage{}, ErrStage
	}
	age := s.now().UTC().Sub(time.Unix(wire.IssuedUnix, 0).UTC())
	if age < -time.Minute || age > StageMaxAge || wire.Engine != engine || wire.Action != action || wire.Direction != direction {
		return Stage{}, ErrStage
	}
	return NewStage(StageSpec{
		Engine: wire.Engine, Action: wire.Action, Direction: wire.Direction,
		DecodedBytes: wire.DecodedBytes, DecodedSHA256: wire.DecodedSHA256,
		Baseline: BaselineSpec{SchemaSHA256: wire.Baseline.SchemaSHA256, DataSHA256: wire.Baseline.DataSHA256, RecordCount: wire.Baseline.RecordCount},
	})
}

func readBoundedStage(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, ErrStage
	}
	payload, readErr := io.ReadAll(io.LimitReader(file, MaxBytes+1))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil || len(payload) == 0 || len(payload) > MaxBytes {
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
