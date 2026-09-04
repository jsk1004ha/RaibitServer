package backup

import (
	"context"
	"errors"
	"strconv"
	"time"
)

const (
	sqlRecoverySchema  = "sql-recovery"
	sqlRecoveryVersion = 1
)

type sqlCommandPlan struct {
	executable string
	args       []string
	binding    StreamBinding
}

type sqlAdapter struct {
	engine                  Engine
	formatName, passwordEnv string
	dumpPlan, restorePlan   func(Connection) ([]sqlCommandPlan, error)
}

func (a sqlAdapter) Engine() Engine { return a.engine }

func (a sqlAdapter) Dump(ctx context.Context, request DumpRequest, handoff *StreamHandoff, runner JobRunner) (DumpResult, error) {
	if ctx == nil || handoff == nil || runner == nil || request.Source().Engine() != a.engine {
		return DumpResult{}, ErrRecoveryRequest
	}
	defer func() { _ = handoff.Abort() }()
	format, metadata, err := sqlMetadata(request.Source(), a.formatName)
	if err != nil {
		return DumpResult{}, err
	}
	plans, err := a.dumpPlan(request.Source())
	if err != nil {
		return DumpResult{}, err
	}
	job, err := newSQLJob(request.Source(), a.passwordEnv, plans)
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

func (a sqlAdapter) Restore(ctx context.Context, request RestoreRequest, handoff *StreamHandoff, runner JobRunner) (VerificationReceipt, error) {
	if ctx == nil || handoff == nil || runner == nil || request.Source().Engine() != a.engine || request.Target().Engine() != a.engine {
		return VerificationReceipt{}, ErrRecoveryRequest
	}
	wantFormat := request.Artifact().Format().Spec()
	if wantFormat != (EngineFormatSpec{Engine: a.engine, Name: a.formatName, Version: uint16(RecoveryArtifactFormatV1)}) {
		return VerificationReceipt{}, ErrRecoveryRequest
	}
	defer func() { _ = handoff.Abort() }()
	plans, err := a.restorePlan(request.Target())
	if err != nil {
		return VerificationReceipt{}, err
	}
	job, err := newSQLJob(request.Target(), a.passwordEnv, plans)
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

func newSQLJob(connection Connection, passwordEnv string, plans []sqlCommandPlan) (IsolatedJob, error) {
	steps := make([]CommandStep, len(plans))
	for index, plan := range plans {
		command, err := newDirectCommand(plan.executable, plan.args...)
		if err != nil {
			return IsolatedJob{}, err
		}
		steps[index], err = newCommandStep(command, plan.binding)
		if err != nil {
			return IsolatedJob{}, err
		}
	}
	secret := connection.spec.Secret
	environment, err := NewSecretEnv(passwordEnv, secret)
	if err != nil {
		return IsolatedJob{}, err
	}
	secretFile, err := NewSecretFile("/var/run/raibit-recovery/sql/password", secret)
	if err != nil {
		return IsolatedJob{}, err
	}
	return NewIsolatedJob(IsolatedJobSpec{
		Namespace: connection.spec.Provenance.spec.Namespace, Image: connection.toolImage,
		OperationID: connection.operationID, Attempt: connection.attempt, Connection: connection,
		Steps: steps, Secrets: []SecretEnv{environment}, SecretFiles: []SecretFile{secretFile},
		RunAsUser: 65532, CPUMilli: 250, MemoryMiB: 256, EphemeralMiB: 512, Deadline: 15 * time.Minute,
	})
}

func sqlMetadata(connection Connection, formatName string) (EngineFormat, VerificationMetadata, error) {
	format, err := NewEngineFormat(EngineFormatSpec{Engine: connection.Engine(), Name: formatName, Version: uint16(RecoveryArtifactFormatV1)})
	if err != nil {
		return EngineFormat{}, VerificationMetadata{}, err
	}
	metadata, err := NewVerificationMetadata(VerificationMetadataSpec{
		Schema: sqlRecoverySchema, Version: sqlRecoveryVersion,
		Fields: []VerificationField{
			{Name: "engine", Value: string(connection.Engine())},
			{Name: "source_version", Value: connection.Version()},
			{Name: "format", Value: formatName},
			{Name: "schema_check", Value: "information-schema"},
			{Name: "sentinel_check", Value: "raibitserver-restore-sentinel"},
		},
	})
	if err != nil {
		return EngineFormat{}, VerificationMetadata{}, err
	}
	return format, metadata, nil
}

func sqlEndpoint(connection Connection) (NetworkEndpointSpec, error) {
	endpoint, ok := connection.Endpoint().(NetworkEndpoint)
	if !ok {
		return NetworkEndpointSpec{}, ErrRecoveryRequest
	}
	return endpoint.Spec(), nil
}

func sqlPort(port uint16) string { return strconv.Itoa(int(port)) }
