package recoverywire

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
)

const (
	PayloadChunkSize                   = 3072
	MaxLineLength                      = 8192
	DefaultFramedTransportLimit uint64 = 10 * 1024 * 1024 * 1024
	FullFrameWireBytes          uint64 = 4110
	maxSequenceFrames           uint64 = 9_999_999_999
	framedFixedOverhead         uint64 = 2 * MaxLineLength
	defaultMaxFrames            uint64 = (DefaultFramedTransportLimit - framedFixedOverhead) / FullFrameWireBytes
	defaultMaxBytes             uint64 = defaultMaxFrames * PayloadChunkSize
)

var (
	ErrInvalidMetadata = errors.New("recovery wire: invalid metadata")
	ErrInvalidEnvelope = errors.New("recovery wire: invalid envelope")
	ErrLimitExceeded   = errors.New("recovery wire: limit exceeded")
	ErrIO              = errors.New("recovery wire: I/O failure")
	versionPattern     = regexp.MustCompile(`\A[A-Za-z0-9][A-Za-z0-9._-]{0,31}\z`)
)

type Engine string

const (
	EnginePostgreSQL Engine = "postgresql"
	EngineMySQL      Engine = "mysql"
	EngineMariaDB    Engine = "mariadb"
	EngineMongoDB    Engine = "mongodb"
	EngineRedis      Engine = "redis"
	EngineValkey     Engine = "valkey"
)

type Format string

const (
	FormatPGCustom         Format = "pg-custom"
	FormatSQL              Format = "sql"
	FormatMongoArchiveGzip Format = "mongo-archive-gzip"
	FormatRDB              Format = "rdb"
)

type Metadata struct {
	engine      Engine
	version     string
	format      Format
	baseline    Baseline
	hasBaseline bool
}

func NewMetadata(engine Engine, version string, format Format) (Metadata, error) {
	if !versionPattern.MatchString(version) || !supports(engine, format) {
		return Metadata{}, ErrInvalidMetadata
	}
	return Metadata{engine: engine, version: version, format: format}, nil
}

func (m Metadata) Engine() Engine  { return m.engine }
func (m Metadata) Version() string { return m.version }
func (m Metadata) Format() Format  { return m.format }
func (m Metadata) Baseline() (Baseline, bool) {
	return m.baseline, m.hasBaseline
}
func (m Metadata) WithBaseline(baseline Baseline) (Metadata, error) {
	if !baseline.valid() {
		return Metadata{}, ErrInvalidMetadata
	}
	m.baseline = baseline
	m.hasBaseline = true
	return m, nil
}
func (m Metadata) valid() bool {
	_, err := NewMetadata(m.engine, m.version, m.format)
	return err == nil && (!m.hasBaseline || m.baseline.valid())
}
func supports(e Engine, f Format) bool {
	switch e {
	case EnginePostgreSQL:
		return f == FormatPGCustom
	case EngineMySQL, EngineMariaDB:
		return f == FormatSQL
	case EngineMongoDB:
		return f == FormatMongoArchiveGzip
	case EngineRedis, EngineValkey:
		return f == FormatRDB
	default:
		return false
	}
}

type Baseline struct {
	schemaSHA256 [sha256.Size]byte
	dataSHA256   [sha256.Size]byte
	recordCount  uint64
}

func NewBaseline(schemaSHA256, dataSHA256 [sha256.Size]byte, recordCount uint64) (Baseline, error) {
	baseline := Baseline{schemaSHA256: schemaSHA256, dataSHA256: dataSHA256, recordCount: recordCount}
	if !baseline.valid() {
		return Baseline{}, ErrInvalidMetadata
	}
	return baseline, nil
}

func (b Baseline) SchemaSHA256() [sha256.Size]byte { return b.schemaSHA256 }
func (b Baseline) DataSHA256() [sha256.Size]byte   { return b.dataSHA256 }
func (b Baseline) RecordCount() uint64             { return b.recordCount }
func (b Baseline) valid() bool {
	return b.schemaSHA256 != [sha256.Size]byte{} && b.dataSHA256 != [sha256.Size]byte{}
}

type Envelope struct {
	Metadata Metadata
	Payload  io.Reader
}

type Receipt struct {
	Frames         uint64
	PlaintextBytes uint64
	SHA256         [sha256.Size]byte
}

type Decoded struct {
	Metadata Metadata
	Receipt  Receipt
}

type Limits struct {
	maxBytes  uint64
	maxFrames uint64
}

func NewLimits(maxBytes, maxFrames uint64) (Limits, error) {
	if maxBytes == 0 || maxFrames == 0 || maxFrames > maxSequenceFrames {
		return Limits{}, ErrLimitExceeded
	}
	return Limits{maxBytes: maxBytes, maxFrames: maxFrames}, nil
}

func LimitsForFramedTransport(maxWireBytes uint64) (Limits, error) {
	if maxWireBytes <= framedFixedOverhead {
		return Limits{}, ErrLimitExceeded
	}
	maxFrames := (maxWireBytes - framedFixedOverhead) / FullFrameWireBytes
	if maxFrames == 0 || maxFrames > maxSequenceFrames || maxFrames > math.MaxUint64/PayloadChunkSize {
		return Limits{}, ErrLimitExceeded
	}
	return NewLimits(maxFrames*PayloadChunkSize, maxFrames)
}

func (l Limits) MaxBytes() uint64  { return l.maxBytes }
func (l Limits) MaxFrames() uint64 { return l.maxFrames }

func DefaultLimits() Limits {
	return Limits{maxBytes: defaultMaxBytes, maxFrames: defaultMaxFrames}
}

type safeIOError struct {
	stage string
}

func (e *safeIOError) Error() string { return "recovery wire: " + e.stage }
func (e *safeIOError) Is(target error) bool {
	return target == ErrIO
}

func ioError(stage string) error {
	return &safeIOError{stage: stage}
}

func invalid(stage string) error {
	return fmt.Errorf("recovery wire: invalid %s: %w", stage, ErrInvalidEnvelope)
}

func cancellation(ctx context.Context, stage string) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("recovery wire: %s canceled: %w", stage, err)
	}
	return nil
}
