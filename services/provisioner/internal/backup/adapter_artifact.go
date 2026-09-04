package backup

import (
	"slices"
	"strconv"
	"strings"
)

const RecoveryArtifactFormatV1 uint8 = 1

type EngineFormatSpec struct {
	Engine  Engine
	Name    string
	Version uint16
}
type EngineFormat struct{ spec EngineFormatSpec }

func NewEngineFormat(spec EngineFormatSpec) (EngineFormat, error) {
	if !supportedEngine(spec.Engine) || !recoveryPart.MatchString(spec.Name) || spec.Version == 0 {
		return EngineFormat{}, ErrRecoveryRequest
	}
	return EngineFormat{spec: spec}, nil
}
func (f EngineFormat) Spec() EngineFormatSpec { return f.spec }

type VerificationField struct{ Name, Value string }
type VerificationMetadataSpec struct {
	Schema  string
	Version uint16
	Fields  []VerificationField
}
type VerificationMetadata struct{ spec VerificationMetadataSpec }

func NewVerificationMetadata(spec VerificationMetadataSpec) (VerificationMetadata, error) {
	if !recoveryPart.MatchString(spec.Schema) || spec.Version == 0 || len(spec.Fields) == 0 || len(spec.Fields) > 32 {
		return VerificationMetadata{}, ErrRecoveryRequest
	}
	seen := make(map[string]struct{}, len(spec.Fields))
	for _, field := range spec.Fields {
		if !recoveryPart.MatchString(field.Name) || len(field.Value) == 0 || len(field.Value) > 512 || strings.ContainsRune(field.Value, '\x00') {
			return VerificationMetadata{}, ErrRecoveryRequest
		}
		if _, exists := seen[field.Name]; exists {
			return VerificationMetadata{}, ErrRecoveryRequest
		}
		seen[field.Name] = struct{}{}
	}
	spec.Fields = slices.Clone(spec.Fields)
	return VerificationMetadata{spec: spec}, nil
}
func (m VerificationMetadata) Spec() VerificationMetadataSpec {
	m.spec.Fields = slices.Clone(m.spec.Fields)
	return m.spec
}

type DumpRequest struct{ source Connection }

func NewDumpRequest(source Connection, claimed SourceGeneration) (DumpRequest, error) {
	if source.spec.ResourceID == "" || source.Generation() != claimed {
		return DumpRequest{}, ErrRecoveryRequest
	}
	return DumpRequest{source: source}, nil
}
func (r DumpRequest) Source() Connection { return r.source }

type DumpResult struct {
	request  DumpRequest
	receipt  JobReceipt
	format   EngineFormat
	baseline VerificationMetadata
}

func newDumpResult(request DumpRequest, receipt JobReceipt, format EngineFormat, baseline VerificationMetadata) (DumpResult, error) {
	if request.source.spec.ResourceID == "" || receipt.name == "" || request.source.Engine() != format.spec.Engine || baseline.spec.Schema == "" {
		return DumpResult{}, ErrRecoveryRequest
	}
	return DumpResult{request: request, receipt: receipt, format: format, baseline: baseline}, nil
}
func (r DumpResult) Request() DumpRequest           { return r.request }
func (r DumpResult) Receipt() JobReceipt            { return r.receipt }
func (r DumpResult) Format() EngineFormat           { return r.format }
func (r DumpResult) Baseline() VerificationMetadata { return r.baseline }

// RecoveryArtifact joins immutable adapter metadata with Task23's durable upload record.
type RecoveryArtifact struct {
	dump   DumpResult
	record ArtifactRecord
}

func NewRecoveryArtifact(dump DumpResult, record ArtifactRecord) (RecoveryArtifact, error) {
	source := dump.request.source
	if source.spec.ResourceID == "" || record.Attempt.OrganizationID != source.spec.OrganizationID || record.Attempt.ResourceID != source.ResourceID() || record.PlaintextBytes != dump.receipt.Bytes() || record.StoredBytes < 1 || record.StoredBytes > MaxStoredBytes || record.PlaintextBytes < 1 || record.PlaintextBytes > MaxStoredBytes || record.SHA256 == [32]byte{} {
		return RecoveryArtifact{}, ErrRecoveryRequest
	}
	if _, err := NewAttempt(record.Attempt); err != nil {
		return RecoveryArtifact{}, ErrRecoveryRequest
	}
	return RecoveryArtifact{dump: dump, record: record}, nil
}
func (a RecoveryArtifact) Record() ArtifactRecord         { return a.record }
func (a RecoveryArtifact) Source() Connection             { return a.dump.request.source }
func (a RecoveryArtifact) Format() EngineFormat           { return a.dump.format }
func (a RecoveryArtifact) Baseline() VerificationMetadata { return a.dump.baseline }

type VersionCompatibility interface {
	compatible(sourceVersion, targetVersion string, format EngineFormat) bool
	recoveryCompatibility()
}
type MajorVersionCompatibility struct {
	engine        Engine
	formatName    string
	formatVersion uint16
}

func NewMajorVersionCompatibility(format EngineFormat) MajorVersionCompatibility {
	return MajorVersionCompatibility{engine: format.spec.Engine, formatName: format.spec.Name, formatVersion: format.spec.Version}
}
func (MajorVersionCompatibility) recoveryCompatibility() {}
func (p MajorVersionCompatibility) compatible(sourceVersion, targetVersion string, format EngineFormat) bool {
	if format.spec.Engine != p.engine || format.spec.Name != p.formatName || format.spec.Version != p.formatVersion {
		return false
	}
	sourceMajor, sourceErr := strconv.Atoi(strings.SplitN(sourceVersion, ".", 2)[0])
	targetMajor, targetErr := strconv.Atoi(strings.SplitN(targetVersion, ".", 2)[0])
	return sourceErr == nil && targetErr == nil && sourceMajor == targetMajor
}

type RestoreRequest struct {
	source, target Connection
	artifact       RecoveryArtifact
}

func NewRestoreRequest(source, target Connection, artifact RecoveryArtifact, policy VersionCompatibility) (RestoreRequest, error) {
	if source.spec.ResourceID == "" || target.spec.ResourceID == "" || policy == nil || artifact.Source().ResourceID() != source.ResourceID() || artifact.Source().Generation() != source.Generation() || source.spec.OrganizationID != target.spec.OrganizationID || source.spec.ProjectID != target.spec.ProjectID || source.Engine() != target.Engine() || source.ResourceID() == target.ResourceID() || source.spec.Provenance.spec.UID == target.spec.Provenance.spec.UID || !policy.compatible(source.Version(), target.Version(), artifact.Format()) || endpointsOverlap(source.Endpoint(), target.Endpoint()) {
		return RestoreRequest{}, ErrRecoveryRequest
	}
	if source.Engine() != EngineSQLite && source.spec.Secret.sameObject(target.spec.Secret) {
		return RestoreRequest{}, ErrRecoveryRequest
	}
	return RestoreRequest{source: source, target: target, artifact: artifact}, nil
}

func endpointsOverlap(source, target Endpoint) bool {
	switch left := source.(type) {
	case NetworkEndpoint:
		right, ok := target.(NetworkEndpoint)
		return !ok || left.spec.Host == right.spec.Host && left.spec.Port == right.spec.Port && left.spec.Database == right.spec.Database && left.spec.User == right.spec.User && equalIndex(left.spec.Index, right.spec.Index)
	case SQLiteEndpoint:
		right, ok := target.(SQLiteEndpoint)
		return !ok || left.spec.Volume == right.spec.Volume && left.spec.Root == right.spec.Root && left.spec.RelativePath == right.spec.RelativePath
	default:
		return true
	}
}

func equalIndex(left, right *uint16) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func (r RestoreRequest) Source() Connection         { return r.source }
func (r RestoreRequest) Target() Connection         { return r.target }
func (r RestoreRequest) Artifact() RecoveryArtifact { return r.artifact }

type VerificationReceipt struct {
	target   Connection
	artifact RecoveryArtifact
	observed VerificationMetadata
}

func NewVerificationReceipt(request RestoreRequest, observed VerificationMetadata) (VerificationReceipt, error) {
	want := request.artifact.dump.baseline
	if observed.spec.Schema == "" || observed.spec.Schema != want.spec.Schema || observed.spec.Version != want.spec.Version || !slices.Equal(observed.spec.Fields, want.spec.Fields) {
		return VerificationReceipt{}, ErrRecoveryRequest
	}
	return VerificationReceipt{target: request.target, artifact: request.artifact, observed: observed}, nil
}
func (r VerificationReceipt) Target() Connection             { return r.target }
func (r VerificationReceipt) Artifact() RecoveryArtifact     { return r.artifact }
func (r VerificationReceipt) Observed() VerificationMetadata { return r.observed }
