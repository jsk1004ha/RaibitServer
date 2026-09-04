package backup

import (
	"errors"
	"regexp"
)

const RecoveryArtifactFormatV1 uint8 = 1

var (
	ErrRecoveryRequest = errors.New("backup: invalid recovery request")
	ErrRecoveryJob     = errors.New("backup: invalid recovery job")
	ErrRecoveryStream  = errors.New("backup: invalid recovery stream")
	recoveryPart       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
	recoveryVersion    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	secretEnvName      = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
)

type Engine string

const (
	EnginePostgreSQL Engine = "postgresql"
	EngineMySQL      Engine = "mysql"
	EngineMariaDB    Engine = "mariadb"
	EngineMongoDB    Engine = "mongodb"
	EngineRedis      Engine = "redis"
	EngineValkey     Engine = "valkey"
	EngineSQLite     Engine = "sqlite"
)

func supportedEngine(engine Engine) bool {
	switch engine {
	case EnginePostgreSQL, EngineMySQL, EngineMariaDB, EngineMongoDB, EngineRedis, EngineValkey, EngineSQLite:
		return true
	}
	return false
}

type SecretRef struct{ namespace, name, key string }

func NewSecretRef(namespace, name, key string) (SecretRef, error) {
	ref := SecretRef{namespace: namespace, name: name, key: key}
	if !validSecretRef(ref) {
		return SecretRef{}, ErrRecoveryRequest
	}
	return ref, nil
}

func validSecretRef(ref SecretRef) bool {
	return recoveryPart.MatchString(ref.namespace) && recoveryPart.MatchString(ref.name) && secretEnvName.MatchString(ref.key)
}

func (r SecretRef) Namespace() string { return r.namespace }
func (r SecretRef) Name() string      { return r.name }
func (r SecretRef) Key() string       { return r.key }

type ConnectionSpec struct {
	OrganizationID, ProjectID, ResourceID string
	Engine                                Engine
	Version                               string
	Secret                                SecretRef
}

// Connection is server-owned metadata. Credentials remain in the referenced
// Kubernetes Secret and never become command arguments.
type Connection struct{ spec ConnectionSpec }

func NewConnection(spec ConnectionSpec) (Connection, error) {
	if !recoveryPart.MatchString(spec.OrganizationID) || !recoveryPart.MatchString(spec.ProjectID) || !recoveryPart.MatchString(spec.ResourceID) || !supportedEngine(spec.Engine) || !recoveryVersion.MatchString(spec.Version) || !validSecretRef(spec.Secret) {
		return Connection{}, ErrRecoveryRequest
	}
	return Connection{spec: spec}, nil
}

func (c Connection) Spec() ConnectionSpec { return c.spec }
func (c Connection) Engine() Engine       { return c.spec.Engine }
func (c Connection) Version() string      { return c.spec.Version }
func (c Connection) ResourceID() string   { return c.spec.ResourceID }

type ArtifactMetadataSpec struct {
	FormatVersion                   uint8
	Engine                          Engine
	EngineVersion, SourceResourceID string
	SourceGeneration, KeyVersion    string
	StoredBytes, PlaintextBytes     int64
	SHA256                          [32]byte
}

// ArtifactMetadata is private recovery persistence, not an API response. It
// describes a verified envelope without a boolean that merely claims encryption.
type ArtifactMetadata struct{ spec ArtifactMetadataSpec }

func NewArtifactMetadata(spec ArtifactMetadataSpec) (ArtifactMetadata, error) {
	if spec.FormatVersion != RecoveryArtifactFormatV1 || !supportedEngine(spec.Engine) || !recoveryVersion.MatchString(spec.EngineVersion) || !recoveryPart.MatchString(spec.SourceResourceID) || !recoveryPart.MatchString(spec.SourceGeneration) || !recoveryPart.MatchString(spec.KeyVersion) || spec.StoredBytes < 1 || spec.StoredBytes > MaxStoredBytes || spec.PlaintextBytes < 1 || spec.PlaintextBytes > MaxStoredBytes || spec.SHA256 == [32]byte{} {
		return ArtifactMetadata{}, ErrRecoveryRequest
	}
	return ArtifactMetadata{spec: spec}, nil
}

func (m ArtifactMetadata) Spec() ArtifactMetadataSpec { return m.spec }

type DumpRequest struct {
	source   Connection
	artifact ArtifactMetadata
}

func NewDumpRequest(source Connection, artifact ArtifactMetadata) (DumpRequest, error) {
	if source.spec.Secret.namespace == "" || artifact.spec.SourceResourceID != source.ResourceID() || artifact.spec.Engine != source.Engine() || artifact.spec.EngineVersion != source.Version() {
		return DumpRequest{}, ErrRecoveryRequest
	}
	return DumpRequest{source: source, artifact: artifact}, nil
}

func (r DumpRequest) Source() Connection         { return r.source }
func (r DumpRequest) Artifact() ArtifactMetadata { return r.artifact }

type RestoreRequest struct {
	source   Connection
	target   Connection
	artifact ArtifactMetadata
}

func NewRestoreRequest(source, target Connection, artifact ArtifactMetadata) (RestoreRequest, error) {
	if _, err := NewDumpRequest(source, artifact); err != nil || !validSecretRef(target.spec.Secret) || source.spec.OrganizationID != target.spec.OrganizationID || source.spec.ProjectID != target.spec.ProjectID || source.spec.Secret.namespace != target.spec.Secret.namespace || source.Engine() != target.Engine() || source.ResourceID() == target.ResourceID() || source.spec.Secret == target.spec.Secret {
		return RestoreRequest{}, ErrRecoveryRequest
	}
	return RestoreRequest{source: source, target: target, artifact: artifact}, nil
}

func (r RestoreRequest) Source() Connection         { return r.source }
func (r RestoreRequest) Target() Connection         { return r.target }
func (r RestoreRequest) Artifact() ArtifactMetadata { return r.artifact }

type VerificationReceipt struct {
	target      Connection
	artifact    ArtifactMetadata
	probeSHA256 [32]byte
}

func NewVerificationReceipt(target Connection, artifact ArtifactMetadata, probeSHA256 [32]byte) (VerificationReceipt, error) {
	if target.spec.Secret.namespace == "" || target.Engine() != artifact.spec.Engine || target.Version() != artifact.spec.EngineVersion || probeSHA256 == [32]byte{} {
		return VerificationReceipt{}, ErrRecoveryRequest
	}
	return VerificationReceipt{target: target, artifact: artifact, probeSHA256: probeSHA256}, nil
}

func (r VerificationReceipt) Target() Connection         { return r.target }
func (r VerificationReceipt) Artifact() ArtifactMetadata { return r.artifact }
func (r VerificationReceipt) ProbeSHA256() [32]byte      { return r.probeSHA256 }
