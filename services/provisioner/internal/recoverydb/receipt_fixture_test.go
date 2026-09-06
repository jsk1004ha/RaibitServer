package recoverydb

import (
	"testing"

	"github.com/raibitserver/provisioner/internal/recoveryreceipt"
)

type fakeReceiptCoordinator struct {
	stage    *recoveryreceipt.Stage
	receipts []recoveryreceipt.Receipt
}

func (f *fakeReceiptCoordinator) WriteStage(stage recoveryreceipt.Stage) error {
	if f.stage != nil {
		return recoveryreceipt.ErrStage
	}
	f.stage = &stage
	return nil
}

func (f *fakeReceiptCoordinator) ConsumeStage(engine recoveryreceipt.Engine, action recoveryreceipt.Action, direction recoveryreceipt.Direction) (recoveryreceipt.Stage, error) {
	if f.stage == nil && direction == recoveryreceipt.DirectionDump {
		baseline, err := parseBaseline([]byte(baselineOutput(versionForReceiptEngine(engine), "descriptor")))
		if err != nil {
			return recoveryreceipt.Stage{}, err
		}
		version, err := recoveryreceipt.NewVersionIdentity(engine, baseline.version)
		if err != nil {
			return recoveryreceipt.Stage{}, err
		}
		stage, err := recoveryreceipt.NewStage(recoveryreceipt.StageSpec{
			Engine: engine, Action: action, Direction: direction, Baseline: receiptBaseline(baseline), SourceVersion: version,
		})
		if err != nil {
			return recoveryreceipt.Stage{}, err
		}
		f.stage = &stage
	}
	if f.stage == nil || f.stage.Engine() != engine || f.stage.Action() != action || f.stage.Direction() != direction {
		return recoveryreceipt.Stage{}, recoveryreceipt.ErrStage
	}
	stage := *f.stage
	f.stage = nil
	return stage, nil
}

func (f *fakeReceiptCoordinator) ConsumeRestoreStageIfPresent(engine recoveryreceipt.Engine, action recoveryreceipt.Action) (recoveryreceipt.Stage, bool, error) {
	if f.stage == nil {
		return recoveryreceipt.Stage{}, false, nil
	}
	if f.stage.Engine() != engine || f.stage.Action() != action || f.stage.Direction() != recoveryreceipt.DirectionRestore {
		return recoveryreceipt.Stage{}, true, recoveryreceipt.ErrStage
	}
	stage := *f.stage
	f.stage = nil
	return stage, true, nil
}

func (f *fakeReceiptCoordinator) WriteReceipt(receipt recoveryreceipt.Receipt) error {
	f.receipts = append(f.receipts, receipt)
	return nil
}

func versionForReceiptEngine(engine recoveryreceipt.Engine) string {
	if engine == recoveryreceipt.EnginePostgreSQL {
		return "160004"
	}
	return "8.4.1"
}

func setDumpStage(t *testing.T, deps dependencies, selected engine, version, descriptor string) {
	t.Helper()
	coordinator, ok := deps.receipts.(*fakeReceiptCoordinator)
	if !ok {
		t.Fatal("test receipt coordinator unavailable")
	}
	receiptEngine, action, err := receiptIdentity(selected, recoveryreceipt.DirectionDump)
	if err != nil {
		t.Fatal(err)
	}
	baseline, err := parseBaseline([]byte(baselineOutput(version, descriptor)))
	if err != nil {
		t.Fatal(err)
	}
	identity, err := recoveryreceipt.NewVersionIdentity(receiptEngine, version)
	if err != nil {
		t.Fatal(err)
	}
	stage, err := recoveryreceipt.NewStage(recoveryreceipt.StageSpec{
		Engine: receiptEngine, Action: action, Direction: recoveryreceipt.DirectionDump,
		Baseline: receiptBaseline(baseline), SourceVersion: identity,
	})
	if err != nil {
		t.Fatal(err)
	}
	coordinator.stage = &stage
}
