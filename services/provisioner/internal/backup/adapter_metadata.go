package backup

import (
	"errors"
	"path"
	"regexp"
	"strings"
)

var (
	ErrRecoveryRequest = errors.New("backup: invalid recovery request")
	ErrRecoveryJob     = errors.New("backup: invalid recovery job")
	ErrRecoveryStream  = errors.New("backup: invalid recovery stream")
	recoveryPart       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
	recoveryVersion    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	secretEnvName      = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
	generationPattern  = regexp.MustCompile(`^resource-incarnation/v1:sha256:[0-9a-f]{64}$`)
	digestImagePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9./_:-]{0,190}@sha256:[0-9a-f]{64}$`)
	dnsHostPattern     = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$`)
	dnsLabelPattern    = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	providerUIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	credentialPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
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
func (r SecretRef) sameObject(other SecretRef) bool {
	return r.namespace == other.namespace && r.name == other.name
}
func (r SecretRef) sameRef(other SecretRef) bool {
	return r.sameObject(other) && r.key == other.key
}

type SourceGeneration struct{ value string }

func NewSourceGeneration(value string) (SourceGeneration, error) {
	if !generationPattern.MatchString(value) {
		return SourceGeneration{}, ErrRecoveryRequest
	}
	return SourceGeneration{value: value}, nil
}

func (g SourceGeneration) String() string { return g.value }

type ProviderProvenanceSpec struct {
	Namespace, Name, UID, CredentialUID, CredentialGeneration string
	Generation                                                int64
	Image                                                     string
}

type ProviderProvenance struct{ spec ProviderProvenanceSpec }

func NewProviderProvenance(spec ProviderProvenanceSpec) (ProviderProvenance, error) {
	if !dnsLabelPattern.MatchString(spec.Namespace) || !dnsLabelPattern.MatchString(spec.Name) || len(spec.Name) > 52 || !providerUIDPattern.MatchString(spec.UID) || !providerUIDPattern.MatchString(spec.CredentialUID) || !credentialPattern.MatchString(spec.CredentialGeneration) || spec.Generation < 1 || spec.Generation > 9007199254740991 || !digestImagePattern.MatchString(spec.Image) {
		return ProviderProvenance{}, ErrRecoveryRequest
	}
	return ProviderProvenance{spec: spec}, nil
}

func (p ProviderProvenance) Spec() ProviderProvenanceSpec { return p.spec }

type Endpoint interface{ recoveryEndpoint() }

type NetworkEndpointSpec struct {
	Host, Database, User string
	Port                 uint16
	Index                *uint16
}

type NetworkEndpoint struct{ spec NetworkEndpointSpec }

func NewNetworkEndpoint(spec NetworkEndpointSpec) (NetworkEndpoint, error) {
	if !dnsHostPattern.MatchString(spec.Host) || spec.Port == 0 || len(spec.Database) > 128 || len(spec.User) == 0 || len(spec.User) > 128 || (spec.Database == "") == (spec.Index == nil) || spec.Index != nil && *spec.Index > 1024 || strings.ContainsAny(spec.Database+spec.User, "\x00\r\n") {
		return NetworkEndpoint{}, ErrRecoveryRequest
	}
	return NetworkEndpoint{spec: spec}, nil
}

func (NetworkEndpoint) recoveryEndpoint()           {}
func (e NetworkEndpoint) Spec() NetworkEndpointSpec { return e.spec }

type SQLiteEndpointSpec struct{ Volume, Root, RelativePath string }
type SQLiteEndpoint struct{ spec SQLiteEndpointSpec }

func NewSQLiteEndpoint(spec SQLiteEndpointSpec) (SQLiteEndpoint, error) {
	clean := path.Clean(spec.RelativePath)
	if !recoveryPart.MatchString(spec.Volume) || !recoveryPart.MatchString(spec.Root) || clean != spec.RelativePath || clean == "." || strings.HasPrefix(clean, "../") || path.IsAbs(clean) || !strings.HasSuffix(clean, ".sqlite") {
		return SQLiteEndpoint{}, ErrRecoveryRequest
	}
	return SQLiteEndpoint{spec: spec}, nil
}

func (SQLiteEndpoint) recoveryEndpoint()          {}
func (e SQLiteEndpoint) Spec() SQLiteEndpointSpec { return e.spec }

type EngineVersion struct {
	Engine  Engine
	Version string
}

type ConnectionSpec struct {
	OrganizationID, ProjectID, ResourceID string
	Engine                                EngineVersion
	Generation                            SourceGeneration
	Provenance                            ProviderProvenance
	Endpoint                              Endpoint
	Secret                                SecretRef
}

type Connection struct {
	spec                   ConnectionSpec
	toolImage, operationID string
	attempt                int
}

func newConnection(spec ConnectionSpec, toolImage, operationID string, attempt int) (Connection, error) {
	if !recoveryPart.MatchString(spec.OrganizationID) || !recoveryPart.MatchString(spec.ProjectID) || !recoveryPart.MatchString(spec.ResourceID) || !supportedEngine(spec.Engine.Engine) || !recoveryVersion.MatchString(spec.Engine.Version) || spec.Generation.value == "" || spec.Provenance.spec.Name == "" || !digestImagePattern.MatchString(toolImage) || !recoveryPart.MatchString(operationID) || attempt < 1 {
		return Connection{}, ErrRecoveryRequest
	}
	switch endpoint := spec.Endpoint.(type) {
	case NetworkEndpoint:
		indexed := spec.Engine.Engine == EngineRedis || spec.Engine.Engine == EngineValkey
		if spec.Engine.Engine == EngineSQLite || !validSecretRef(spec.Secret) || endpoint.spec.Host == "" || (endpoint.spec.Index != nil) != indexed {
			return Connection{}, ErrRecoveryRequest
		}
	case SQLiteEndpoint:
		if spec.Engine.Engine != EngineSQLite || validSecretRef(spec.Secret) || endpoint.spec.RelativePath == "" {
			return Connection{}, ErrRecoveryRequest
		}
	default:
		return Connection{}, ErrRecoveryRequest
	}
	return Connection{spec: spec, toolImage: toolImage, operationID: operationID, attempt: attempt}, nil
}

func (c Connection) Spec() ConnectionSpec         { return c.spec }
func (c Connection) Engine() Engine               { return c.spec.Engine.Engine }
func (c Connection) Version() string              { return c.spec.Engine.Version }
func (c Connection) ResourceID() string           { return c.spec.ResourceID }
func (c Connection) Endpoint() Endpoint           { return c.spec.Endpoint }
func (c Connection) Generation() SourceGeneration { return c.spec.Generation }
