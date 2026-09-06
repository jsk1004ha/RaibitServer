package backup

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"time"
)

const (
	MaxStoredBytes int64 = 10 << 30
	MaxDuration          = 30 * time.Minute
	SegmentBytes         = 1 << 20
	PartBytes            = 8 << 20
)

var (
	ErrConfig         = errors.New("backup: invalid operator configuration")
	ErrIdentity       = errors.New("backup: invalid artifact identity")
	ErrIntegrity      = errors.New("backup: artifact integrity failure")
	ErrLimit          = errors.New("backup: size limit exceeded")
	ErrBackend        = errors.New("backup: storage operation failed")
	ErrFence          = errors.New("backup: durable attempt fence rejected")
	ErrCleanupPending = errors.New("backup: cleanup remains pending")
	segmentID         = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
)

type AttemptSpec struct {
	OrganizationID string
	ResourceID     string
	BackupID       string
	KeyVersion     string
	Number         int
	FirstClaimAt   time.Time
}

// Attempt binds a single durable claim attempt; first-claim time MUST come from
// storage, never from the retry clock. Its zero value is rejected at I/O boundaries.
type Attempt struct{ spec AttemptSpec }

func NewAttempt(spec AttemptSpec) (Attempt, error) {
	for _, id := range []string{spec.OrganizationID, spec.ResourceID, spec.BackupID, spec.KeyVersion} {
		if !segmentID.MatchString(id) {
			return Attempt{}, ErrIdentity
		}
	}
	if spec.Number < 1 || spec.Number > 3 || spec.FirstClaimAt.IsZero() {
		return Attempt{}, ErrIdentity
	}
	return Attempt{spec: spec}, nil
}

func (a Attempt) Spec() AttemptSpec   { return a.spec }
func (a Attempt) Deadline() time.Time { return a.spec.FirstClaimAt.Add(MaxDuration) }
func (a Attempt) ObjectKey() string {
	return fmt.Sprintf("organizations/%s/resources/%s/backups/%s/attempts/%d/artifact.v1", a.spec.OrganizationID, a.spec.ResourceID, a.spec.BackupID, a.spec.Number)
}

type Upload struct {
	Attempt  Attempt
	UploadID string
}

// ArtifactRecord is private persistence data, never API/log output. SHA256 covers
// every stored envelope byte; it is not an S3 ETag or a plaintext checksum.
type ArtifactRecord struct {
	Attempt        AttemptSpec
	StoredBytes    int64
	PlaintextBytes int64
	SHA256         [32]byte
}

// Candidate is uploaded but NEVER publication authority. Verify is required.
type Candidate struct{ record ArtifactRecord }

func (c Candidate) Record() ArtifactRecord { return c.record }

func ParseCandidate(record ArtifactRecord) (Candidate, error) {
	if _, err := NewAttempt(record.Attempt); err != nil {
		return Candidate{}, err
	}
	if record.StoredBytes < 1 || record.StoredBytes > MaxStoredBytes || record.PlaintextBytes < 0 || record.PlaintextBytes > MaxStoredBytes || record.SHA256 == [32]byte{} {
		return Candidate{}, ErrIntegrity
	}
	return Candidate{record: record}, nil
}

// VerifiedArtifact can only be produced after full durable readback and final
// authentication. The store must still fence READY publication after receiving it.
type VerifiedArtifact struct{ record ArtifactRecord }

func (v VerifiedArtifact) Record() ArtifactRecord { return v.record }

// Journal is implemented by the durable store bridge. Every method MUST atomically
// check current worker, attempt, unexpired lease, absolute deadline and parents.
// RecordIntent must reject re-creation for an already recorded attempt. Preserve
// ALL unresolved intents across retry. RecordUpload precedes every part; the
// complete ciphertext descriptor is persisted before CompleteMultipartUpload.
// No callback may hold a DB transaction across this module's network operations.
type Journal interface {
	RecordIntent(context.Context, Attempt) error
	RecordUpload(context.Context, Upload) error
	RecordCandidate(context.Context, Candidate) error
	RecordRemoteCompletion(context.Context, RemoteCompletion) error
	Fence(context.Context, Attempt) error
}

type CleanupRequest struct {
	Attempt  Attempt
	UploadID string
	Remote   RemoteWriteState
}

// CleanupAuthorizer must fence publication and active restore pins before allowing
// cleanup, including cleanup of an old attempt. Unlike an upload lease this may
// authorize terminal-operation cleanup after the original deadline.
// Authorization must also exclude future worker requests; it does NOT prove
// remotely accepted requests finished. RecordRemoteCompletion durably compares
// the exact PREPARED descriptor and records COMPLETE under the cleanup fence,
// without publishing READY or releasing pins. Failure must preserve the witness.
type (
	CleanupAuthorizer interface {
		AuthorizeCleanup(context.Context, Attempt) error
		RecordRemoteCompletion(context.Context, RemoteCompletion) error
	}
	CleanupResult struct {
		MultipartAbsent bool
		ObjectAbsent    bool
	}
)
