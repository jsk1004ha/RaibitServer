package recoveryreceipt

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	StageFileName                = "recovery-stage-v1.json"
	StageEvidenceFileName        = "recovery-stage-evidence-v1.bin"
	StageEvidenceBindingFileName = "recovery-stage-evidence-binding-v1.json"
	StagePath                    = "/var/run/raibit-recovery/scratch/" + StageFileName
	StageEvidencePath            = "/var/run/raibit-recovery/scratch/" + StageEvidenceFileName
	StageEvidenceMaxBytes        = 64 << 20
	StageMaxAge                  = 15 * time.Minute
)

var ErrStage = errors.New("recovery receipt: invalid stage")

type StageSpec struct {
	Engine              Engine
	Action              Action
	Direction           Direction
	DecodedBytes        uint64
	DecodedSHA256       string
	Baseline            BaselineSpec
	SourceVersion       VersionIdentity
	TargetVersionBefore VersionIdentity
	EvidenceRequired    bool
}

type Stage struct {
	spec             StageSpec
	evidenceVerified bool
}

func NewStage(spec StageSpec) (Stage, error) {
	if spec.Action.Engine() == "" || spec.Action.Engine() != spec.Engine || spec.Action.Direction() != spec.Direction || !validSHA256(spec.Baseline.SchemaSHA256) || !validSHA256(spec.Baseline.DataSHA256) {
		return Stage{}, ErrStage
	}
	switch spec.Direction {
	case DirectionDump:
		if spec.DecodedBytes != 0 || spec.DecodedSHA256 != "" || !spec.SourceVersion.validFor(spec.Engine) || !spec.TargetVersionBefore.isZero() || spec.EvidenceRequired {
			return Stage{}, ErrStage
		}
	case DirectionRestore:
		if !validEvidence(evidenceSpec{
			engine: spec.Engine, action: spec.Action, direction: spec.Direction,
			decodedBytes: spec.DecodedBytes, decodedSHA256: spec.DecodedSHA256, baseline: spec.Baseline,
		}) {
			return Stage{}, ErrStage
		}
		if !spec.SourceVersion.validFor(spec.Engine) || !spec.TargetVersionBefore.validFor(spec.Engine) || spec.SourceVersion.major() != spec.TargetVersionBefore.major() {
			return Stage{}, ErrStage
		}
		cacheEvidence := spec.Engine == EngineRedis || spec.Engine == EngineValkey
		if spec.EvidenceRequired != cacheEvidence {
			return Stage{}, ErrStage
		}
	default:
		return Stage{}, ErrStage
	}
	return Stage{spec: spec}, nil
}

func (s Stage) Engine() Engine                       { return s.spec.Engine }
func (s Stage) Action() Action                       { return s.spec.Action }
func (s Stage) Direction() Direction                 { return s.spec.Direction }
func (s Stage) DecodedBytes() uint64                 { return s.spec.DecodedBytes }
func (s Stage) DecodedSHA256() string                { return s.spec.DecodedSHA256 }
func (s Stage) Baseline() BaselineSpec               { return s.spec.Baseline }
func (s Stage) SourceVersion() VersionIdentity       { return s.spec.SourceVersion }
func (s Stage) TargetVersionBefore() VersionIdentity { return s.spec.TargetVersionBefore }
func (s Stage) EvidenceRequired() bool               { return s.spec.EvidenceRequired }

// VersionIdentity is a bounded, sanitized server-version token bound to one recovery engine.
type VersionIdentity struct {
	engine Engine
	value  string
}

// NewVersionIdentity parses the normalized version token reported by a native recovery tool.
func NewVersionIdentity(engine Engine, value string) (VersionIdentity, error) {
	identity := VersionIdentity{engine: engine, value: value}
	if !identity.validFor(engine) {
		return VersionIdentity{}, ErrStage
	}
	return identity, nil
}

func (v VersionIdentity) String() string { return v.value }
func (v VersionIdentity) isZero() bool   { return v.value == "" }

func (v VersionIdentity) major() string {
	if v.engine == EnginePostgreSQL {
		numeric, err := strconv.Atoi(v.value)
		if err != nil {
			return ""
		}
		return strconv.Itoa(numeric / 10_000)
	}
	return strings.SplitN(v.value, ".", 2)[0]
}

func (v VersionIdentity) validFor(engine Engine) bool {
	if v.engine != engine || !supportedVersionEngine(engine) || len(v.value) == 0 || len(v.value) > 64 || v.value[0] < '0' || v.value[0] > '9' {
		return false
	}
	if engine == EnginePostgreSQL {
		numeric, err := strconv.Atoi(v.value)
		return err == nil && len(v.value) >= 5 && len(v.value) <= 6 && v.value[0] != '0' && numeric >= 80_000
	}
	if !strings.Contains(v.value, ".") {
		return false
	}
	for index, value := range []byte(v.value) {
		validAlpha := value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z'
		validDigit := value >= '0' && value <= '9'
		validSeparator := index > 0 && index < len(v.value)-1 && (value == '.' || value == '_' || value == '+' || value == '-')
		if !validAlpha && !validDigit && !validSeparator {
			return false
		}
		if validSeparator {
			previous := v.value[index-1]
			if previous == '.' || previous == '_' || previous == '+' || previous == '-' {
				return false
			}
		}
	}
	return true
}

func supportedVersionEngine(engine Engine) bool {
	switch engine {
	case EnginePostgreSQL, EngineMySQL, EngineMariaDB, EngineMongoDB, EngineRedis, EngineValkey:
		return true
	default:
		return false
	}
}

type DecodedSpec struct {
	Bytes  uint64
	SHA256 string
}

func (s Stage) DumpReceiptSpec(sourceVersionAfter VersionIdentity, decoded DecodedSpec, verification VerificationSpec) (Spec, error) {
	if s.Direction() != DirectionDump || sourceVersionAfter != s.SourceVersion() || !sourceVersionAfter.validFor(s.Engine()) || !validEvidence(evidenceSpec{
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

func (s Stage) RestoreReceiptSpec(targetVersionAfter VersionIdentity, verification VerificationSpec) (Spec, error) {
	if s.Direction() != DirectionRestore || s.EvidenceRequired() && !s.evidenceVerified || !targetVersionAfter.validFor(s.Engine()) || s.TargetVersionBefore() != targetVersionAfter || s.SourceVersion().major() != targetVersionAfter.major() {
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
	path         string
	now          func() time.Time
	beforeOpen   func(*os.Root, string) error
	beforeRemove func(*os.Root, string) error
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
