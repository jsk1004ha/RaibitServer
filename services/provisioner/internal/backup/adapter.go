package backup

import (
	"context"
	"io"
)

// RecoveryAdapter is engine-neutral. Implementations select only fixed commands
// and Secret refs, stream dumps/restores through JobRunner, and return a typed
// receipt only after their engine-specific verification succeeds.
type RecoveryAdapter interface {
	Engine() Engine
	Dump(context.Context, DumpRequest, io.WriteCloser, JobRunner) (JobReceipt, error)
	Restore(context.Context, RestoreRequest, io.ReadCloser, JobRunner) (VerificationReceipt, error)
}
