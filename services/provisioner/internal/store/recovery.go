package store

import (
	"context"
	"crypto/sha256"
	"fmt"
	"regexp"
	"time"
)

const (
	RecoveryLease       = 60 * time.Second
	RecoveryRenewal     = 20 * time.Second
	RecoveryDeadline    = 30 * time.Minute
	RecoveryMaxAttempts = 3
)

type RecoveryKind string

const (
	RecoveryBackup  RecoveryKind = "resource.backup"
	RecoveryRestore RecoveryKind = "resource.restore"
)

type RecoveryClaim struct {
	kind                                                                         RecoveryKind
	operationID, backupID, organizationID, projectID, sourceID, targetID, worker string
	attempt                                                                      int
	startedAt, deadlineAt                                                        time.Time
}

type RecoveryIdentity struct {
	Kind                                                                 RecoveryKind
	OperationID, BackupID, OrganizationID, ProjectID, SourceID, TargetID string
	Attempt                                                              int
	FirstClaimAt, DeadlineAt                                             time.Time
}

func (c RecoveryClaim) Identity() RecoveryIdentity {
	return RecoveryIdentity{c.kind, c.operationID, c.backupID, c.organizationID, c.projectID, c.sourceID, c.targetID, c.attempt, c.startedAt, c.deadlineAt}
}

type RecoveryArtifact struct {
	OrganizationID, ResourceID, BackupID, KeyVersion string
	Attempt                                          int
	FirstClaimAt                                     time.Time
	StoredBytes, PlaintextBytes                      int64
	SHA256                                           [32]byte
}

type RecoveryAttempt struct {
	Artifact                   RecoveryArtifact
	ObjectKey, UploadID, State string
	CleanupPending             bool
}

type RecoveryCleanupClaim struct {
	kind                       RecoveryKind
	operationID, worker, token string
}

// RecoveryStore is private control-plane persistence, not a tenant API or an engine runner.
// Every method completes its transaction before returning; no lock spans network I/O.
type RecoveryStore interface {
	ClaimNextRecovery(context.Context, string) (*RecoveryClaim, error)
	RenewRecovery(context.Context, RecoveryClaim) error
	FenceRecovery(context.Context, RecoveryClaim) error
	RecordRecoveryIntent(context.Context, RecoveryClaim, string) (RecoveryAttempt, error)
	RecordRecoveryUpload(context.Context, RecoveryClaim, string) error
	RecordRecoveryCandidate(context.Context, RecoveryClaim, RecoveryArtifact) error
	RecordRecoveryComplete(context.Context, RecoveryClaim) error
	RecordRecoveryVerified(context.Context, RecoveryClaim) error
	StartRestoreVerification(context.Context, RecoveryClaim) error
	FinishRecovery(context.Context, RecoveryClaim) error
	FailRecovery(context.Context, RecoveryClaim) error
	CancelRestore(context.Context, RecoveryClaim) error
	RetryRecovery(context.Context, RecoveryClaim) error
	ReadRecoveryAttempts(context.Context, RecoveryClaim) ([]RecoveryAttempt, error)
	ReadRecoveryExecution(context.Context, RecoveryClaim) (RecoveryExecution, error)
	ClaimRecoveryCleanup(context.Context, RecoveryIdentity, string) (RecoveryCleanupClaim, error)
	FenceRecoveryCleanup(context.Context, RecoveryCleanupClaim) error
	ReadRecoveryCleanup(context.Context, RecoveryCleanupClaim) ([]RecoveryAttempt, error)
	MarkRecoveryAttemptCleaned(context.Context, RecoveryCleanupClaim, int) error
	FinishRecoveryCleanup(context.Context, RecoveryCleanupClaim) error
}

var (
	recoveryIDPattern         = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
	recoveryKeyVersionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
)

func recoveryJobID(kind RecoveryKind, id string) string {
	return fmt.Sprintf("job_%x", sha256.Sum256([]byte(string(kind)+"\x00"+id)))
}

func recoveryTable(kind RecoveryKind) (string, error) {
	switch kind {
	case RecoveryBackup:
		return `"ResourceBackup"`, nil
	case RecoveryRestore:
		return `"ResourceRestore"`, nil
	default:
		return "", ErrRecoveryInput
	}
}

func recoveryObjectKey(c RecoveryClaim) string {
	return fmt.Sprintf("organizations/%s/resources/%s/backups/%s/attempts/%d/artifact.v1", c.organizationID, c.sourceID, c.backupID, c.attempt)
}
