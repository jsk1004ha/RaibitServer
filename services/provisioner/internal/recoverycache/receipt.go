package recoverycache

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"io"

	"github.com/raibitserver/provisioner/internal/recoveryreceipt"
)

type receiptStage struct {
	stage recoveryreceipt.Stage
}

type receiptController interface {
	writeDump(engine, artifactMetadata) error
	consumeDump(engine) (receiptStage, error)
	finishDump(receiptStage, engine, artifactMetadata, artifactTransfer) error
	writeRestore(engine, artifactMetadata, artifactTransfer, string) (receiptStage, error)
	writeEvidence(receiptStage, io.Reader) error
	consumeRestore(engine, recoveryreceipt.EvidenceVerifier) (receiptStage, bool, error)
	finishRestore(receiptStage, string) error
}

type osReceiptController struct{ index uint16 }

func (c osReceiptController) writeDump(value engine, metadata artifactMetadata) error {
	engineValue, backupAction, _, err := receiptIdentity(value)
	if err != nil {
		return err
	}
	version, err := recoveryreceipt.NewVersionIdentity(engineValue, metadata.sourceVersion)
	if err != nil {
		return err
	}
	stage, err := recoveryreceipt.NewStage(recoveryreceipt.StageSpec{Engine: engineValue, Action: backupAction, Direction: recoveryreceipt.DirectionDump, Baseline: receiptBaseline(value, c.index, metadata), SourceVersion: version})
	if err != nil {
		return err
	}
	return recoveryreceipt.WriteStage(stage)
}

func (osReceiptController) consumeDump(value engine) (receiptStage, error) {
	engineValue, backupAction, _, err := receiptIdentity(value)
	if err != nil {
		return receiptStage{}, err
	}
	stage, err := recoveryreceipt.ConsumeStage(engineValue, backupAction, recoveryreceipt.DirectionDump)
	return receiptStage{stage: stage}, err

}

func (c osReceiptController) finishDump(consumed receiptStage, value engine, metadata artifactMetadata, transfer artifactTransfer) error {
	stage := consumed.stage
	if stage.Baseline() != receiptBaseline(value, c.index, metadata) || stage.SourceVersion().String() != metadata.sourceVersion {
		return recoveryreceipt.ErrStage
	}
	version, err := recoveryreceipt.NewVersionIdentity(stage.Engine(), metadata.sourceVersion)
	if err != nil {
		return err
	}
	spec, err := stage.DumpReceiptSpec(version, receiptDecoded(transfer), receiptVerification(false))
	if err != nil {
		return err
	}
	return writeReceipt(spec)
}

func (c osReceiptController) writeRestore(value engine, metadata artifactMetadata, transfer artifactTransfer, targetVersion string) (receiptStage, error) {
	engineValue, _, restoreAction, err := receiptIdentity(value)
	if err != nil {
		return receiptStage{}, err
	}
	source, err := recoveryreceipt.NewVersionIdentity(engineValue, metadata.sourceVersion)
	if err != nil {
		return receiptStage{}, err
	}
	target, err := recoveryreceipt.NewVersionIdentity(engineValue, targetVersion)
	if err != nil {
		return receiptStage{}, err
	}
	stage, err := recoveryreceipt.NewStage(recoveryreceipt.StageSpec{
		Engine: engineValue, Action: restoreAction, Direction: recoveryreceipt.DirectionRestore,
		DecodedBytes: transfer.decodedBytes, DecodedSHA256: hex.EncodeToString(transfer.decodedSHA[:]),
		Baseline: receiptBaseline(value, c.index, metadata), SourceVersion: source, TargetVersionBefore: target, EvidenceRequired: true,
	})
	if err != nil {
		return receiptStage{}, err
	}
	if err := recoveryreceipt.WriteStage(stage); err != nil {
		return receiptStage{}, err
	}
	return receiptStage{stage: stage}, nil
}

func (osReceiptController) writeEvidence(stage receiptStage, source io.Reader) error {
	_, err := recoveryreceipt.WriteStageEvidence(stage.stage, source)
	return err
}

func (osReceiptController) consumeRestore(value engine, verifier recoveryreceipt.EvidenceVerifier) (receiptStage, bool, error) {
	engineValue, _, restoreAction, err := receiptIdentity(value)
	if err != nil {
		return receiptStage{}, false, err
	}
	stage, present, err := recoveryreceipt.ConsumeRestoreStageIfPresent(engineValue, restoreAction, verifier)
	return receiptStage{stage: stage}, present, err
}

func (osReceiptController) finishRestore(stage receiptStage, targetVersion string) error {
	version, err := recoveryreceipt.NewVersionIdentity(stage.stage.Engine(), targetVersion)
	if err != nil {
		return err
	}
	spec, err := stage.stage.RestoreReceiptSpec(version, receiptVerification(true))
	if err != nil {
		return err
	}
	return writeReceipt(spec)
}

func writeReceipt(spec recoveryreceipt.Spec) error {
	receipt, err := recoveryreceipt.New(spec)
	if err != nil {
		return err
	}
	return recoveryreceipt.WriteTerminationLog(receipt)
}

func receiptIdentity(value engine) (recoveryreceipt.Engine, recoveryreceipt.Action, recoveryreceipt.Action, error) {
	switch value {
	case engineRedis:
		return recoveryreceipt.EngineRedis, recoveryreceipt.ActionRedisBackup, recoveryreceipt.ActionRedisRestore, nil
	case engineValkey:
		return recoveryreceipt.EngineValkey, recoveryreceipt.ActionValkeyBackup, recoveryreceipt.ActionValkeyRestore, nil
	default:
		return "", "", "", ErrCapability
	}
}

func receiptBaseline(value engine, index uint16, metadata artifactMetadata) recoveryreceipt.BaselineSpec {
	schema := cacheSchemaDigest(value, metadata.sourceVersion, index)
	return recoveryreceipt.BaselineSpec{SchemaSHA256: hex.EncodeToString(schema[:]), DataSHA256: hex.EncodeToString(metadata.datasetSHA256[:]), RecordCount: uint64(metadata.keyCount)}
}

func receiptDecoded(transfer artifactTransfer) recoveryreceipt.DecodedSpec {
	return recoveryreceipt.DecodedSpec{Bytes: transfer.decodedBytes, SHA256: hex.EncodeToString(transfer.decodedSHA[:])}
}

func receiptVerification(restore bool) recoveryreceipt.VerificationSpec {
	result := recoveryreceipt.VerificationSpec{Version: true, Schema: true, DecodedArtifact: true}
	if restore {
		verified := true
		result.Sentinel, result.TTL = &verified, &verified
	}
	return result
}

func (h *helper) runReceiptAction(ctx context.Context, action Action, stdin io.Reader, stdout io.Writer) error {
	if ctx == nil || stdin == nil || stdout == nil || h.receipts == nil || action.value == "" || h.processes == nil || h.dialer == nil || h.codec == nil || h.waiter == nil || h.random == nil {
		return ErrConfig
	}
	if err := h.config.validate(); err != nil {
		return err
	}
	operationContext, cancel := context.WithTimeout(ctx, h.config.operationTimeout)
	defer cancel()
	if err := h.processes.probe(operationContext, action.engine); err != nil {
		if errors.Is(err, ErrCapability) {
			return ErrCapability
		}
		return safeStep("capability probe", ErrCapability)
	}
	switch action.operation {
	case operationBackup:
		stage, err := h.receipts.consumeDump(action.engine)
		if err != nil {
			return safeStep("consume backup intent", ErrOperation)
		}
		result, err := h.backupArtifact(operationContext, action.engine, stdout)
		if err != nil {
			return err
		}
		if err := h.receipts.finishDump(stage, action.engine, result.metadata, result.transfer); err != nil {
			return safeStep("write backup receipt", ErrOperation)
		}
		return nil
	case operationRestore:
		var stage receiptStage
		hooks := restoreHooks{
			beforeMutation: func(metadata artifactMetadata, transfer artifactTransfer, version string) error {
				var err error
				stage, err = h.receipts.writeRestore(action.engine, metadata, transfer, version)
				return err
			},
			afterCopy: func(target cacheClient, keys [][]byte) error {
				records, err := captureTTLRecords(operationContext, target, keys)
				if err != nil {
					return err
				}
				payload, _, err := encodeTTLRecords(records)
				if err != nil {
					return err
				}
				return h.receipts.writeEvidence(stage, bytes.NewReader(payload))
			},
		}
		return h.restoreWithHooks(operationContext, action.engine, stdin, hooks)
	case operationVerify:
		return h.verifyReceipt(operationContext, action.engine)
	default:
		return ErrAction
	}
}
