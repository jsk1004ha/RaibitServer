package recoverydb

import (
	"context"
	"encoding/hex"
	"errors"
	"os"

	"github.com/raibitserver/provisioner/internal/recoveryreceipt"
)

type dependencies struct {
	lookupEnv      func(string) (string, bool)
	credentialPath string
	scratchDir     string
	executor       processExecutor
	receipts       receiptCoordinator
}

type operationContext struct {
	selected action
	target   endpoint
	work     workspace
	streams  Streams
}

func Run(ctx context.Context, actionName string, streams Streams) error {
	return run(ctx, invocation{action: actionName, streams: streams}, dependencies{
		lookupEnv: os.LookupEnv, credentialPath: credentialPath,
		scratchDir: scratchDir, executor: nativeExecutor{}, receipts: productionReceipts{},
	})
}

func run(ctx context.Context, request invocation, deps dependencies) (err error) {
	if ctx == nil {
		return ErrInvalidInput
	}
	selected, err := parseAction(request.action)
	if err != nil {
		return err
	}
	if (selected.operation == operationDump && request.streams.Stdout == nil) || (selected.operation == operationRestore && request.streams.Stdin == nil) || deps.receipts == nil {
		return ErrInvalidInput
	}
	password, err := os.ReadFile(deps.credentialPath)
	if err != nil {
		return ErrInvalidInput
	}
	target, err := parseEndpoint(deps.lookupEnv, password)
	if err != nil {
		return err
	}
	work, err := newWorkspace(deps.scratchDir)
	if err != nil {
		return err
	}
	defer func() {
		if cleanupErr := work.close(); cleanupErr != nil {
			err = errors.Join(err, cleanupErr)
		}
	}()
	operation := operationContext{selected: selected, target: target, work: work, streams: request.streams}
	switch selected.operation {
	case operationDump:
		return executeDump(ctx, operation, deps)
	case operationRestore:
		return executeRestore(ctx, operation, deps)
	case operationVerify:
		return executeVerify(ctx, operation, deps)
	default:
		return ErrInvalidInput
	}
}

func executeDump(ctx context.Context, operation operationContext, deps dependencies) error {
	receiptEngine, receiptAction, err := receiptIdentity(operation.selected.engine, recoveryreceipt.DirectionDump)
	if err != nil {
		return err
	}
	stage, err := deps.receipts.ConsumeStage(receiptEngine, receiptAction, recoveryreceipt.DirectionDump)
	if err != nil {
		return ErrReceipt
	}
	before, err := collectBaseline(ctx, baselineRequest{engine: operation.selected.engine, endpoint: operation.target, work: operation.work}, deps.executor)
	if err != nil {
		return err
	}
	beforeVersion, err := recoveryreceipt.NewVersionIdentity(receiptEngine, before.version)
	if err != nil || stage.SourceVersion() != beforeVersion || !stageMatchesBaseline(stage, before) {
		return ErrBaseline
	}
	spec, err := buildPlan(operation.selected, operation.target, operation.work)
	if err != nil {
		return err
	}
	artifact, file, err := newStagedArtifact(operation.work, "dump.payload")
	if err != nil {
		return err
	}
	nativeErr := executeNative(ctx, nativeExecution{spec: spec, streams: Streams{Stdout: file}, reportStderr: operation.streams.Stderr, target: operation.target}, deps.executor)
	closeErr := syncClose(file)
	if nativeErr != nil || closeErr != nil {
		return errors.Join(nativeErr, closeErr)
	}
	after, err := collectBaseline(ctx, baselineRequest{engine: operation.selected.engine, endpoint: operation.target, work: operation.work}, deps.executor)
	if err != nil || before != after {
		return ErrBaseline
	}
	metadata, err := wireMetadata(operation.selected.engine, before)
	if err != nil {
		return err
	}
	wireReceipt, err := encodeArtifact(ctx, metadata, artifact, operation.streams.Stdout)
	if err != nil {
		return err
	}
	afterVersion, err := recoveryreceipt.NewVersionIdentity(receiptEngine, after.version)
	if err != nil {
		return ErrBaseline
	}
	receiptSpec, err := stage.DumpReceiptSpec(afterVersion, decodedSpec(wireReceipt), recoveryreceipt.VerificationSpec{Version: true, Schema: true, DecodedArtifact: true})
	if err != nil {
		return ErrReceipt
	}
	return verifiedReceipt(receiptSpec, deps.receipts)
}

func executeRestore(ctx context.Context, operation operationContext, deps dependencies) error {
	decoded, artifact, err := decodeToStage(ctx, operation.work, operation.streams.Stdin)
	if err != nil {
		return err
	}
	before, err := collectBaseline(ctx, baselineRequest{engine: operation.selected.engine, endpoint: operation.target, work: operation.work}, deps.executor)
	if err != nil {
		return err
	}
	if err := verifyDecodedIdentity(operation.selected.engine, decoded, before.version); err != nil {
		return err
	}
	receiptEngine, receiptAction, err := receiptIdentity(operation.selected.engine, recoveryreceipt.DirectionRestore)
	if err != nil {
		return err
	}
	sourceVersion, err := recoveryreceipt.NewVersionIdentity(receiptEngine, decoded.Metadata.Version())
	if err != nil {
		return ErrBaseline
	}
	targetVersion, err := recoveryreceipt.NewVersionIdentity(receiptEngine, before.version)
	if err != nil {
		return ErrBaseline
	}
	baseline, err := decodedBaseline(decoded)
	if err != nil {
		return err
	}
	stage, err := recoveryreceipt.NewStage(recoveryreceipt.StageSpec{
		Engine: receiptEngine, Action: receiptAction, Direction: recoveryreceipt.DirectionRestore,
		DecodedBytes: decoded.Receipt.PlaintextBytes, DecodedSHA256: hex.EncodeToString(decoded.Receipt.SHA256[:]),
		Baseline: baseline, SourceVersion: sourceVersion, TargetVersionBefore: targetVersion,
	})
	if err != nil || deps.receipts.WriteStage(stage) != nil {
		return ErrReceipt
	}
	restoreSpec, err := buildPlan(operation.selected, operation.target, operation.work)
	if err != nil {
		return err
	}
	file, err := artifact.open()
	if err != nil {
		return err
	}
	nativeErr := executeNative(ctx, nativeExecution{spec: restoreSpec, streams: Streams{Stdin: file}, reportStderr: operation.streams.Stderr, target: operation.target}, deps.executor)
	closeErr := file.Close()
	if nativeErr != nil || closeErr != nil {
		if closeErr != nil {
			return errors.Join(nativeErr, ErrWorkspace)
		}
		return nativeErr
	}
	return nil
}

func executeVerify(ctx context.Context, operation operationContext, deps dependencies) error {
	receiptEngine, restoreAction, err := receiptIdentity(operation.selected.engine, recoveryreceipt.DirectionRestore)
	if err != nil {
		return err
	}
	stage, present, err := deps.receipts.ConsumeRestoreStageIfPresent(receiptEngine, restoreAction)
	if err != nil {
		return ErrReceipt
	}
	observed, err := collectBaseline(ctx, baselineRequest{engine: operation.selected.engine, endpoint: operation.target, work: operation.work}, deps.executor)
	if err != nil {
		return err
	}
	observedVersion, err := recoveryreceipt.NewVersionIdentity(receiptEngine, observed.version)
	if err != nil {
		return ErrBaseline
	}
	if !present {
		_, dumpAction, identityErr := receiptIdentity(operation.selected.engine, recoveryreceipt.DirectionDump)
		if identityErr != nil {
			return identityErr
		}
		preflight, stageErr := recoveryreceipt.NewStage(recoveryreceipt.StageSpec{
			Engine: receiptEngine, Action: dumpAction, Direction: recoveryreceipt.DirectionDump,
			Baseline: receiptBaseline(observed), SourceVersion: observedVersion,
		})
		if stageErr != nil || deps.receipts.WriteStage(preflight) != nil {
			return ErrReceipt
		}
		return nil
	}
	if stage.TargetVersionBefore() != observedVersion || !stageMatchesStructure(stage, observed) {
		return ErrBaseline
	}
	verifySpec, err := buildPlan(action{engine: operation.selected.engine, operation: operationVerify}, operation.target, operation.work)
	if err != nil {
		return err
	}
	if err := verifyTarget(ctx, nativeExecution{spec: verifySpec, reportStderr: operation.streams.Stderr, target: operation.target}, deps.executor); err != nil {
		return err
	}
	verified := true
	receiptSpec, err := stage.RestoreReceiptSpec(observedVersion, recoveryreceipt.VerificationSpec{
		Version: true, Schema: true, DecodedArtifact: true, Sentinel: &verified,
	})
	if err != nil {
		return ErrReceipt
	}
	return verifiedReceipt(receiptSpec, deps.receipts)
}
