package backup

import (
	"context"
)

// RecoveryAdapter is engine-neutral. Implementations select only fixed commands
// and Secret refs, stream dumps/restores through JobRunner, and return a typed
// receipt only after their engine-specific verification succeeds.
type RecoveryAdapter interface {
	Engine() Engine
	Dump(context.Context, DumpRequest, *StreamHandoff, JobRunner) (DumpResult, error)
	Restore(context.Context, RestoreRequest, *StreamHandoff, JobRunner) (VerificationReceipt, error)
}
