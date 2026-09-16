package recoveryreceipt

import (
	"bytes"
	"encoding/json"
	"io"
	"unicode/utf8"
)

type wireBaseline struct {
	SchemaSHA256 string `json:"schema_sha256"`
	DataSHA256   string `json:"data_sha256"`
	RecordCount  uint64 `json:"record_count"`
}

type wireVerification struct {
	Version         bool  `json:"version"`
	Schema          bool  `json:"schema"`
	DecodedArtifact bool  `json:"data"`
	Sentinel        *bool `json:"sentinel,omitempty"`
	TTL             *bool `json:"ttl,omitempty"`
}

type wireReceipt struct {
	WireVersion   string           `json:"wire_version"`
	Engine        Engine           `json:"engine"`
	Action        Action           `json:"action"`
	Direction     Direction        `json:"direction"`
	DecodedBytes  uint64           `json:"decoded_bytes"`
	DecodedSHA256 string           `json:"decoded_sha256"`
	Baseline      *wireBaseline    `json:"baseline"`
	Verification  wireVerification `json:"verification"`
}

func Parse(payload []byte) (Receipt, error) {
	if len(payload) == 0 || len(payload) > MaxBytes || !utf8.Valid(payload) || rejectDuplicateKeys(payload) != nil {
		return Receipt{}, ErrInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var wire wireReceipt
	if err := decoder.Decode(&wire); err != nil || wire.WireVersion != WireVersion {
		return Receipt{}, ErrInvalid
	}
	if err := requireJSONEnd(decoder); err != nil || wire.Baseline == nil {
		return Receipt{}, ErrInvalid
	}
	return New(Spec{
		Engine: wire.Engine, Action: wire.Action, Direction: wire.Direction,
		DecodedBytes: wire.DecodedBytes, DecodedSHA256: wire.DecodedSHA256,
		Baseline:     &BaselineSpec{SchemaSHA256: wire.Baseline.SchemaSHA256, DataSHA256: wire.Baseline.DataSHA256, RecordCount: wire.Baseline.RecordCount},
		Verification: VerificationSpec{Version: wire.Verification.Version, Schema: wire.Verification.Schema, DecodedArtifact: wire.Verification.DecodedArtifact, Sentinel: wire.Verification.Sentinel, TTL: wire.Verification.TTL},
	})
}

func requireJSONEnd(decoder *json.Decoder) error {
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		return ErrInvalid
	}
	return nil
}

func rejectDuplicateKeys(payload []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	if err := consumeJSONValue(decoder); err != nil {
		return ErrInvalid
	}
	return requireJSONEnd(decoder)
}

func consumeJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return ErrInvalid
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, keyErr := decoder.Token()
			key, keyOK := keyToken.(string)
			if keyErr != nil || !keyOK {
				return ErrInvalid
			}
			if _, exists := seen[key]; exists {
				return ErrInvalid
			}
			seen[key] = struct{}{}
			if err := consumeJSONValue(decoder); err != nil {
				return err
			}
		}
	case '[':
		for decoder.More() {
			if err := consumeJSONValue(decoder); err != nil {
				return err
			}
		}
	default:
		return ErrInvalid
	}
	closing, err := decoder.Token()
	if err != nil {
		return ErrInvalid
	}
	if (delimiter == '{' && closing != json.Delim('}')) || (delimiter == '[' && closing != json.Delim(']')) {
		return ErrInvalid
	}
	return nil
}

func toWire(receipt Receipt) wireReceipt {
	baseline := receipt.Baseline()
	verification := receipt.Verification()
	return wireReceipt{
		WireVersion: WireVersion, Engine: receipt.Engine(), Action: receipt.Action(), Direction: receipt.Direction(),
		DecodedBytes: receipt.DecodedBytes(), DecodedSHA256: receipt.DecodedSHA256(),
		Baseline:     &wireBaseline{SchemaSHA256: baseline.SchemaSHA256, DataSHA256: baseline.DataSHA256, RecordCount: baseline.RecordCount},
		Verification: wireVerification{Version: verification.Version, Schema: verification.Schema, DecodedArtifact: verification.DecodedArtifact, Sentinel: verification.Sentinel, TTL: verification.TTL},
	}
}
