package recoveryreceipt

import (
	"encoding/hex"
	"errors"

	"github.com/raibitserver/provisioner/internal/recoverywire"
)

var ErrInvalid = errors.New("recovery receipt: invalid")

func New(spec Spec) (Receipt, error) {
	if err := validateSpec(spec); err != nil {
		return Receipt{}, err
	}
	baseline := *spec.Baseline
	spec.Baseline = &baseline
	spec.Verification = cloneVerification(spec.Verification)
	return Receipt{spec: spec}, nil
}

func (r Receipt) ValidateFor(engine Engine, action Action, direction Direction) error {
	if err := validateSpec(r.spec); err != nil || r.spec.Engine != engine || r.spec.Action != action || r.spec.Direction != direction {
		return ErrInvalid
	}
	return nil
}

func validateSpec(spec Spec) error {
	if spec.Baseline == nil || !validEvidence(evidenceSpec{
		engine: spec.Engine, action: spec.Action, direction: spec.Direction,
		decodedBytes: spec.DecodedBytes, decodedSHA256: spec.DecodedSHA256, baseline: *spec.Baseline,
	}) {
		return ErrInvalid
	}
	verification := spec.Verification
	if !verification.Version || !verification.Schema || !verification.DecodedArtifact {
		return ErrInvalid
	}
	switch spec.Direction {
	case DirectionDump:
		if verification.Sentinel != nil || verification.TTL != nil {
			return ErrInvalid
		}
	case DirectionRestore:
		if verification.Sentinel == nil || !*verification.Sentinel {
			return ErrInvalid
		}
		if spec.Engine == EngineRedis || spec.Engine == EngineValkey {
			if verification.TTL == nil || !*verification.TTL {
				return ErrInvalid
			}
		} else if verification.TTL != nil {
			return ErrInvalid
		}
	default:
		return ErrInvalid
	}
	return nil
}

type evidenceSpec struct {
	engine        Engine
	action        Action
	direction     Direction
	decodedBytes  uint64
	decodedSHA256 string
	baseline      BaselineSpec
}

func validEvidence(spec evidenceSpec) bool {
	return spec.action.Engine() != "" && spec.action.Engine() == spec.engine && spec.action.Direction() == spec.direction && spec.decodedBytes > 0 && spec.decodedBytes <= recoverywire.DefaultLimits().MaxBytes() && validSHA256(spec.decodedSHA256) && validSHA256(spec.baseline.SchemaSHA256) && validSHA256(spec.baseline.DataSHA256)
}

func validSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || hex.EncodeToString(decoded) != value {
		return false
	}
	for _, value := range decoded {
		if value != 0 {
			return true
		}
	}
	return false
}
