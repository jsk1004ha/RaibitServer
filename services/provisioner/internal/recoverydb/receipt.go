package recoverydb

import (
	"encoding/hex"

	"github.com/raibitserver/provisioner/internal/recoveryreceipt"
	"github.com/raibitserver/provisioner/internal/recoverywire"
)

type receiptCoordinator interface {
	WriteStage(recoveryreceipt.Stage) error
	ConsumeStage(recoveryreceipt.Engine, recoveryreceipt.Action, recoveryreceipt.Direction) (recoveryreceipt.Stage, error)
	ConsumeRestoreStageIfPresent(recoveryreceipt.Engine, recoveryreceipt.Action) (recoveryreceipt.Stage, bool, error)
	WriteReceipt(recoveryreceipt.Receipt) error
}

type productionReceipts struct{}

func (productionReceipts) WriteStage(stage recoveryreceipt.Stage) error {
	return recoveryreceipt.WriteStage(stage)
}

func (productionReceipts) ConsumeStage(engine recoveryreceipt.Engine, action recoveryreceipt.Action, direction recoveryreceipt.Direction) (recoveryreceipt.Stage, error) {
	return recoveryreceipt.ConsumeStage(engine, action, direction)
}

func (productionReceipts) ConsumeRestoreStageIfPresent(engine recoveryreceipt.Engine, action recoveryreceipt.Action) (recoveryreceipt.Stage, bool, error) {
	return recoveryreceipt.ConsumeRestoreStageIfPresent(engine, action, nil)
}

func (productionReceipts) WriteReceipt(receipt recoveryreceipt.Receipt) error {
	return recoveryreceipt.WriteTerminationLog(receipt)
}

func receiptIdentity(selected engine, direction recoveryreceipt.Direction) (recoveryreceipt.Engine, recoveryreceipt.Action, error) {
	switch selected {
	case enginePostgreSQL:
		if direction == recoveryreceipt.DirectionDump {
			return recoveryreceipt.EnginePostgreSQL, recoveryreceipt.ActionPostgreSQLDump, nil
		}
		return recoveryreceipt.EnginePostgreSQL, recoveryreceipt.ActionPostgreSQLRestore, nil
	case engineMySQL:
		if direction == recoveryreceipt.DirectionDump {
			return recoveryreceipt.EngineMySQL, recoveryreceipt.ActionMySQLDump, nil
		}
		return recoveryreceipt.EngineMySQL, recoveryreceipt.ActionMySQLRestore, nil
	case engineMariaDB:
		if direction == recoveryreceipt.DirectionDump {
			return recoveryreceipt.EngineMariaDB, recoveryreceipt.ActionMariaDBDump, nil
		}
		return recoveryreceipt.EngineMariaDB, recoveryreceipt.ActionMariaDBRestore, nil
	case engineMongoDB:
		if direction == recoveryreceipt.DirectionDump {
			return recoveryreceipt.EngineMongoDB, recoveryreceipt.ActionMongoDBDump, nil
		}
		return recoveryreceipt.EngineMongoDB, recoveryreceipt.ActionMongoDBRestore, nil
	default:
		return "", "", ErrInvalidInput
	}
}

func receiptBaseline(baseline engineBaseline) recoveryreceipt.BaselineSpec {
	return recoveryreceipt.BaselineSpec{
		SchemaSHA256: hex.EncodeToString(baseline.schemaSHA256[:]),
		DataSHA256:   hex.EncodeToString(baseline.dataSHA256[:]),
		RecordCount:  baseline.descriptorCount,
	}
}

func stageMatchesBaseline(stage recoveryreceipt.Stage, baseline engineBaseline) bool {
	return stage.Baseline() == receiptBaseline(baseline)
}

func stageMatchesStructure(stage recoveryreceipt.Stage, baseline engineBaseline) bool {
	observed := receiptBaseline(baseline)
	return stage.Baseline().SchemaSHA256 == observed.SchemaSHA256 && stage.Baseline().RecordCount == observed.RecordCount
}

func decodedBaseline(decoded recoverywire.Decoded) (recoveryreceipt.BaselineSpec, error) {
	baseline, ok := decoded.Metadata.Baseline()
	if !ok {
		return recoveryreceipt.BaselineSpec{}, ErrBaseline
	}
	schemaSHA := baseline.SchemaSHA256()
	dataSHA := baseline.DataSHA256()
	return recoveryreceipt.BaselineSpec{
		SchemaSHA256: hex.EncodeToString(schemaSHA[:]),
		DataSHA256:   hex.EncodeToString(dataSHA[:]),
		RecordCount:  baseline.RecordCount(),
	}, nil
}

func decodedSpec(receipt recoverywire.Receipt) recoveryreceipt.DecodedSpec {
	return recoveryreceipt.DecodedSpec{Bytes: receipt.PlaintextBytes, SHA256: hex.EncodeToString(receipt.SHA256[:])}
}

func verifiedReceipt(spec recoveryreceipt.Spec, coordinator receiptCoordinator) error {
	receipt, err := recoveryreceipt.New(spec)
	if err != nil || coordinator.WriteReceipt(receipt) != nil {
		return ErrReceipt
	}
	return nil
}
