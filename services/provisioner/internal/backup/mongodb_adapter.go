package backup

import (
	"context"
	"errors"
	"time"
)

const (
	mongoDBRecoveryHelper = "raibit-recovery-db"
	mongoDBVerifyAction   = "mongodb-verify"
	mongoDBDumpAction     = "mongodb-dump"
	mongoDBRestoreAction  = "mongodb-restore"
	mongoDBCredentialPath = "/var/run/raibit-recovery/credential"
	mongoDBArchiveFormat  = "mongodb-archive-gzip"
	mongoDBRecoverySchema = "mongodb-recovery"
)

type MongoDBAdapter struct{}

func NewMongoDBRecoveryAdapter() MongoDBAdapter { return MongoDBAdapter{} }

func (MongoDBAdapter) Engine() Engine { return EngineMongoDB }

func (MongoDBAdapter) Dump(ctx context.Context, request DumpRequest, handoff *StreamHandoff, runner JobRunner) (DumpResult, error) {
	if ctx == nil || handoff == nil || runner == nil || request.Source().Engine() != EngineMongoDB {
		return DumpResult{}, ErrRecoveryRequest
	}
	defer func() { _ = handoff.Abort() }()
	format, baseline, err := mongoDBMetadata(request.Source())
	if err != nil {
		return DumpResult{}, err
	}
	job, err := newMongoDBJob(request.Source(), []mongoDBJobStep{
		{action: mongoDBVerifyAction, binding: StreamNone},
		{action: mongoDBDumpAction, binding: StreamStdout},
	})
	if err != nil {
		return DumpResult{}, err
	}
	receipt, err := handoff.Execute(ctx, job, runner)
	if err != nil {
		return DumpResult{}, err
	}
	result, err := newDumpResult(request, receipt, format, baseline)
	if err != nil {
		return DumpResult{}, errors.Join(ErrRecoveryRequest, err)
	}
	return result, nil
}

func (MongoDBAdapter) Restore(ctx context.Context, request RestoreRequest, handoff *StreamHandoff, runner JobRunner) (VerificationReceipt, error) {
	if ctx == nil || handoff == nil || runner == nil || request.Source().Engine() != EngineMongoDB || request.Target().Engine() != EngineMongoDB || request.Artifact().Format().Spec() != mongoDBFormatSpec() {
		return VerificationReceipt{}, ErrRecoveryRequest
	}
	defer func() { _ = handoff.Abort() }()
	job, err := newMongoDBJob(request.Target(), []mongoDBJobStep{
		{action: mongoDBRestoreAction, binding: StreamStdin},
		{action: mongoDBVerifyAction, binding: StreamNone},
	})
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

type mongoDBJobStep struct {
	action  string
	binding StreamBinding
}

func newMongoDBJob(connection Connection, plan []mongoDBJobStep) (IsolatedJob, error) {
	steps := make([]CommandStep, len(plan))
	for index, planned := range plan {
		command, err := mongoDBCommand(planned.action)
		if err != nil {
			return IsolatedJob{}, err
		}
		steps[index], err = newCommandStep(command, planned.binding)
		if err != nil {
			return IsolatedJob{}, err
		}
	}
	credential, err := NewSecretFile(mongoDBCredentialPath, connection.spec.Secret)
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

func mongoDBCommand(action string) (DirectCommand, error) {
	switch action {
	case mongoDBVerifyAction, mongoDBDumpAction, mongoDBRestoreAction:
		return newDirectCommand(mongoDBRecoveryHelper, action)
	default:
		return DirectCommand{}, ErrRecoveryRequest
	}
}

func mongoDBFormatSpec() EngineFormatSpec {
	return EngineFormatSpec{Engine: EngineMongoDB, Name: mongoDBArchiveFormat, Version: uint16(RecoveryArtifactFormatV1)}
}

func mongoDBMetadata(connection Connection) (EngineFormat, VerificationMetadata, error) {
	format, err := NewEngineFormat(mongoDBFormatSpec())
	if err != nil {
		return EngineFormat{}, VerificationMetadata{}, err
	}
	metadata, err := NewVerificationMetadata(VerificationMetadataSpec{
		Schema:  mongoDBRecoverySchema,
		Version: 1,
		Fields: []VerificationField{
			{Name: "engine", Value: string(connection.Engine())},
			{Name: "source_version", Value: connection.Version()},
			{Name: "format", Value: mongoDBArchiveFormat},
			{Name: "schema_check", Value: "document-schema"},
			{Name: "sentinel_check", Value: "raibitserver-restore-sentinel"},
		},
	})
	if err != nil {
		return EngineFormat{}, VerificationMetadata{}, err
	}
	return format, metadata, nil
}

var _ RecoveryAdapter = MongoDBAdapter{}
