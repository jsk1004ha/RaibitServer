package backup

import (
	"context"
	"errors"
	"time"
)

const (
	cacheHelperExecutable        = "raibit-recovery-cache"
	cacheRecoverySchema          = "cache-recovery"
	cacheRecoveryVersion  uint16 = 1
	cacheSentinelKey             = "raibitserver-restore-sentinel"
	cacheSentinelValue           = "raibitserver-recovery-sentinel"
	cacheSentinelTTL             = "positive-preserved"
)

type CacheAdapter struct{ engine Engine }

func NewRedisRecoveryAdapter() CacheAdapter  { return CacheAdapter{engine: EngineRedis} }
func NewValkeyRecoveryAdapter() CacheAdapter { return CacheAdapter{engine: EngineValkey} }

func (a CacheAdapter) Engine() Engine { return a.engine }

func (a CacheAdapter) Dump(ctx context.Context, request DumpRequest, handoff *StreamHandoff, runner JobRunner) (DumpResult, error) {
	if handoff == nil {
		return DumpResult{}, ErrRecoveryRequest
	}
	defer func() { _ = handoff.Abort() }()
	if ctx == nil || runner == nil || request.Source().Engine() != a.engine {
		return DumpResult{}, ErrRecoveryRequest
	}
	format, metadata, err := cacheMetadata(request.Source())
	if err != nil {
		return DumpResult{}, err
	}
	actions, err := cacheActions(a.engine)
	if err != nil {
		return DumpResult{}, err
	}
	job, err := newCacheJob(request.Source(), []cacheJobStep{{action: actions.verify, binding: StreamNone}, {action: actions.backup, binding: StreamStdout}})
	if err != nil {
		return DumpResult{}, err
	}
	receipt, err := handoff.Execute(ctx, job, runner)
	if err != nil {
		return DumpResult{}, err
	}
	result, err := newDumpResult(request, receipt, format, metadata)
	if err != nil {
		return DumpResult{}, errors.Join(ErrRecoveryRequest, err)
	}
	return result, nil
}

func (a CacheAdapter) Restore(ctx context.Context, request RestoreRequest, handoff *StreamHandoff, runner JobRunner) (VerificationReceipt, error) {
	if handoff == nil {
		return VerificationReceipt{}, ErrRecoveryRequest
	}
	defer func() { _ = handoff.Abort() }()
	if ctx == nil || runner == nil || request.Source().Engine() != a.engine || request.Target().Engine() != a.engine {
		return VerificationReceipt{}, ErrRecoveryRequest
	}
	format, _, err := cacheMetadata(request.Source())
	if err != nil || request.Artifact().Format().Spec() != format.Spec() {
		return VerificationReceipt{}, ErrRecoveryRequest
	}
	actions, err := cacheActions(a.engine)
	if err != nil {
		return VerificationReceipt{}, err
	}
	job, err := newCacheJob(request.Target(), []cacheJobStep{{action: actions.restore, binding: StreamStdin}, {action: actions.verify, binding: StreamNone}})
	if err != nil {
		return VerificationReceipt{}, err
	}
	receipt, err := handoff.Execute(ctx, job, runner)
	if err != nil {
		return VerificationReceipt{}, err
	}
	verified, err := NewVerificationReceipt(request, receipt, request.Artifact().Baseline())
	if err != nil {
		return VerificationReceipt{}, errors.Join(ErrRecoveryRequest, err)
	}
	return verified, nil
}

type cacheActionSet struct{ backup, restore, verify string }

func cacheActions(engine Engine) (cacheActionSet, error) {
	switch engine {
	case EngineRedis:
		return cacheActionSet{backup: "redis-backup", restore: "redis-restore", verify: "redis-verify"}, nil
	case EngineValkey:
		return cacheActionSet{backup: "valkey-backup", restore: "valkey-restore", verify: "valkey-verify"}, nil
	default:
		return cacheActionSet{}, ErrRecoveryRequest
	}
}

type cacheJobStep struct {
	action  string
	binding StreamBinding
}

func newCacheJob(connection Connection, plan []cacheJobStep) (IsolatedJob, error) {
	steps := make([]CommandStep, len(plan))
	for index, item := range plan {
		command, err := newDirectCommand(cacheHelperExecutable, item.action)
		if err != nil {
			return IsolatedJob{}, err
		}
		steps[index], err = newCommandStep(command, item.binding)
		if err != nil {
			return IsolatedJob{}, err
		}
	}
	credential, err := NewSecretFile("/var/run/raibit-recovery/credential", connection.spec.Secret)
	if err != nil {
		return IsolatedJob{}, err
	}
	return NewIsolatedJob(IsolatedJobSpec{
		Namespace: connection.spec.Provenance.spec.Namespace, Image: connection.toolImage,
		OperationID: connection.operationID, Attempt: connection.attempt, Connection: connection,
		Steps: steps, SecretFiles: []SecretFile{credential},
		RunAsUser: 65532, CPUMilli: 250, MemoryMiB: 256, EphemeralMiB: 512, Deadline: 15 * time.Minute,
	})
}

func cacheMetadata(connection Connection) (EngineFormat, VerificationMetadata, error) {
	actions, err := cacheActions(connection.Engine())
	if err != nil {
		return EngineFormat{}, VerificationMetadata{}, err
	}
	format, err := NewEngineFormat(EngineFormatSpec{Engine: connection.Engine(), Name: actions.backup, Version: uint16(RecoveryArtifactFormatV1)})
	if err != nil {
		return EngineFormat{}, VerificationMetadata{}, err
	}
	metadata, err := NewVerificationMetadata(VerificationMetadataSpec{
		Schema: cacheRecoverySchema, Version: cacheRecoveryVersion,
		Fields: []VerificationField{
			{Name: "engine", Value: string(connection.Engine())},
			{Name: "source_version", Value: connection.Version()},
			{Name: "format", Value: actions.backup},
			{Name: "sentinel_key", Value: cacheSentinelKey},
			{Name: "sentinel_value", Value: cacheSentinelValue},
			{Name: "sentinel_ttl", Value: cacheSentinelTTL},
		},
	})
	if err != nil {
		return EngineFormat{}, VerificationMetadata{}, err
	}
	return format, metadata, nil
}

var _ RecoveryAdapter = CacheAdapter{}
