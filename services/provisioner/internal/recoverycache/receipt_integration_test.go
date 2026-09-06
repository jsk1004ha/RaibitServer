package recoverycache

import (
	"bytes"
	"errors"
	"io"
	"slices"
	"testing"

	"github.com/raibitserver/provisioner/internal/recoveryreceipt"
)

type fakeReceiptController struct {
	index          uint16
	events         []string
	stage          receiptStage
	evidence       []byte
	restorePresent bool
	finishRestoreN int
}

func (f *fakeReceiptController) writeDump(value engine, metadata artifactMetadata) error {
	engineValue, action, _, _ := receiptIdentity(value)
	version, _ := recoveryreceipt.NewVersionIdentity(engineValue, metadata.sourceVersion)
	stage, err := recoveryreceipt.NewStage(recoveryreceipt.StageSpec{Engine: engineValue, Action: action, Direction: recoveryreceipt.DirectionDump, Baseline: receiptBaseline(value, f.index, metadata), SourceVersion: version})
	if err == nil {
		f.stage, f.events = receiptStage{stage: stage}, append(f.events, "dump-intent")
	}
	return err
}

func (f *fakeReceiptController) consumeDump(engine) (receiptStage, error) {
	f.events = append(f.events, "dump-consume")
	if f.stage.stage.Direction() != recoveryreceipt.DirectionDump {
		return receiptStage{}, recoveryreceipt.ErrStage
	}
	return f.stage, nil
}

func (f *fakeReceiptController) finishDump(_ receiptStage, _ engine, _ artifactMetadata, _ artifactTransfer) error {
	f.events = append(f.events, "dump-receipt")
	return nil
}

func (f *fakeReceiptController) writeRestore(value engine, metadata artifactMetadata, transfer artifactTransfer, targetVersion string) (receiptStage, error) {
	engineValue, _, action, _ := receiptIdentity(value)
	source, _ := recoveryreceipt.NewVersionIdentity(engineValue, metadata.sourceVersion)
	target, _ := recoveryreceipt.NewVersionIdentity(engineValue, targetVersion)
	stage, err := recoveryreceipt.NewStage(recoveryreceipt.StageSpec{
		Engine: engineValue, Action: action, Direction: recoveryreceipt.DirectionRestore,
		DecodedBytes: transfer.decodedBytes, DecodedSHA256: receiptDecoded(transfer).SHA256,
		Baseline: receiptBaseline(value, f.index, metadata), SourceVersion: source, TargetVersionBefore: target, EvidenceRequired: true,
	})
	if err == nil {
		f.stage, f.restorePresent, f.events = receiptStage{stage: stage}, true, append(f.events, "restore-intent")
	}
	return f.stage, err
}

func (f *fakeReceiptController) writeEvidence(_ receiptStage, source io.Reader) error {
	payload, err := io.ReadAll(source)
	if err == nil {
		f.evidence, f.events = payload, append(f.events, "restore-evidence")
	}
	return err
}

func (f *fakeReceiptController) consumeRestore(_ engine, verifier recoveryreceipt.EvidenceVerifier) (receiptStage, bool, error) {
	f.events = append(f.events, "restore-consume")
	if !f.restorePresent {
		return receiptStage{}, false, nil
	}
	if len(f.evidence) == 0 || verifier(bytes.NewReader(f.evidence)) != nil {
		return receiptStage{}, true, recoveryreceipt.ErrStage
	}
	return f.stage, true, nil
}

func (f *fakeReceiptController) finishRestore(stage receiptStage, targetVersion string) error {
	if stage.stage.TargetVersionBefore().String() != targetVersion {
		return recoveryreceipt.ErrStage
	}
	f.finishRestoreN++
	f.events = append(f.events, "restore-receipt")
	return nil
}

func Test_ReceiptRestore_orders_intent_before_mutation_and_evidence_after_copy(t *testing.T) {
	source := newFakeCache(map[string]keySnapshot{"alpha": {kind: "string", dump: []byte("a"), pttl: -1}})
	target := newFakeCache(nil)
	receipts := &fakeReceiptController{}
	source.onMigrate = func() { receipts.events = append(receipts.events, "migrate") }
	helper, input := receiptTestHelper(t, source, target, receipts)

	err := helper.runReceiptAction(t.Context(), Action{value: "redis-restore", engine: engineRedis, operation: operationRestore}, bytes.NewReader(input), io.Discard)

	if err != nil {
		t.Fatal(err)
	}
	want := []string{"restore-intent", "migrate", "restore-evidence"}
	if !slices.Equal(receipts.events, want) {
		t.Fatalf("events=%v want=%v", receipts.events, want)
	}
}

func Test_ReceiptRestore_bad_wire_has_no_intent_or_target_write(t *testing.T) {
	source, target := newFakeCache(nil), newFakeCache(nil)
	receipts := &fakeReceiptController{}
	helper, _ := receiptTestHelper(t, source, target, receipts)

	err := helper.runReceiptAction(t.Context(), Action{value: "redis-restore", engine: engineRedis, operation: operationRestore}, bytes.NewReader([]byte("bad")), io.Discard)

	if !errors.Is(err, ErrOperation) || len(receipts.events) != 0 || source.migrateCalls != 0 || target.setCalls != 0 {
		t.Fatalf("err=%v events=%v migrate=%d set=%d", err, receipts.events, source.migrateCalls, target.setCalls)
	}
}

func Test_ReceiptVerify_complete_absence_is_read_only_dump_preflight(t *testing.T) {
	target := newFakeCache(map[string]keySnapshot{"alpha": {kind: "string", dump: []byte("a"), pttl: -1}})
	receipts := &fakeReceiptController{}
	helper, _ := receiptTestHelper(t, newFakeCache(nil), target, receipts)

	err := helper.runReceiptAction(t.Context(), Action{value: "redis-verify", engine: engineRedis, operation: operationVerify}, bytes.NewReader(nil), io.Discard)

	if err != nil || !slices.Equal(receipts.events, []string{"restore-consume", "dump-intent"}) || target.setCalls != 0 || receipts.finishRestoreN != 0 {
		t.Fatalf("err=%v events=%v set=%d receipts=%d", err, receipts.events, target.setCalls, receipts.finishRestoreN)
	}
}

func Test_ReceiptVerify_missing_evidence_fails_without_source_preflight(t *testing.T) {
	target := newFakeCache(map[string]keySnapshot{"alpha": {kind: "string", dump: []byte("a"), pttl: -1}})
	receipts := &fakeReceiptController{restorePresent: true}
	helper, _ := receiptTestHelper(t, newFakeCache(nil), target, receipts)

	err := helper.runReceiptAction(t.Context(), Action{value: "redis-verify", engine: engineRedis, operation: operationVerify}, bytes.NewReader(nil), io.Discard)

	if !errors.Is(err, ErrOperation) || !slices.Equal(receipts.events, []string{"restore-consume"}) || target.setCalls != 0 {
		t.Fatalf("err=%v events=%v set=%d", err, receipts.events, target.setCalls)
	}
}

func Test_ReceiptBackup_consumes_preflight_before_capture_and_writes_receipt(t *testing.T) {
	remote, captured := newFakeCache(nil), newFakeCache(nil)
	remote.lastSaves = []int64{10, 11}
	receipts := &fakeReceiptController{}
	config := testConfig(t.TempDir())
	runtime := &fakeProcessExecutor{rdb: []byte("REDIS0011payload"), process: &fakeManagedProcess{}}
	runtime.onRun = func(request processRequest) {
		if request.kind == processCapture {
			receipts.events = append(receipts.events, "capture")
		}
	}
	helper := newHelper(config, dependencies{processes: runtime, dialer: &fakeDialer{target: remote, source: captured}, codec: fakeArtifactCodec{}, waiter: immediateWaiter{}, random: bytes.NewReader(bytes.Repeat([]byte{1}, 64))})
	receipts.index, helper.receipts = config.index, receipts

	if err := helper.runReceiptAction(t.Context(), Action{value: "redis-verify", engine: engineRedis, operation: operationVerify}, bytes.NewReader(nil), io.Discard); err != nil {
		t.Fatal(err)
	}
	if err := helper.runReceiptAction(t.Context(), Action{value: "redis-backup", engine: engineRedis, operation: operationBackup}, bytes.NewReader(nil), io.Discard); err != nil {
		t.Fatal(err)
	}
	want := []string{"restore-consume", "dump-intent", "dump-consume", "capture", "dump-receipt"}
	if !slices.Equal(receipts.events, want) {
		t.Fatalf("events=%v want=%v", receipts.events, want)
	}
}

func Test_ReceiptVerify_rejects_value_count_TTL_and_target_version_drift(t *testing.T) {
	base := keySnapshot{kind: "string", dump: []byte("a"), pttl: -1}
	tests := []struct {
		name    string
		mutate  func(*fakeCache)
		version string
	}{
		{name: "value", mutate: func(c *fakeCache) { c.values["alpha"] = keySnapshot{kind: "string", dump: []byte("changed"), pttl: -1} }},
		{name: "count", mutate: func(c *fakeCache) { c.values["extra"] = base }},
		{name: "ttl", mutate: func(c *fakeCache) {
			c.values["alpha"] = keySnapshot{kind: "string", dump: []byte("a"), pttl: 10_000}
			c.expiryTimes = map[string]int64{"alpha": 1_800_000_010_000}
		}},
		{name: "target version", version: "7.4.2"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			target := newFakeCache(map[string]keySnapshot{"alpha": base})
			receipts := &fakeReceiptController{}
			helper, input := receiptTestHelper(t, newFakeCache(map[string]keySnapshot{"alpha": base}), newFakeCache(nil), receipts)
			if err := helper.runReceiptAction(t.Context(), Action{value: "redis-restore", engine: engineRedis, operation: operationRestore}, bytes.NewReader(input), io.Discard); err != nil {
				t.Fatal(err)
			}
			target = helper.dialer.(*fakeDialer).target
			if test.mutate != nil {
				test.mutate(target)
			}
			if test.version != "" {
				target.versionValue = test.version
			}
			err := helper.runReceiptAction(t.Context(), Action{value: "redis-verify", engine: engineRedis, operation: operationVerify}, bytes.NewReader(nil), io.Discard)
			if !errors.Is(err, ErrOperation) || receipts.finishRestoreN != 0 {
				t.Fatalf("err=%v receipts=%d events=%v", err, receipts.finishRestoreN, receipts.events)
			}
		})
	}
}

func receiptTestHelper(t *testing.T, source, target *fakeCache, receipts *fakeReceiptController) (*helper, []byte) {
	t.Helper()
	config := testConfig(t.TempDir())
	metadata := testMetadata(source, engineRedis)
	codec := fakeArtifactCodec{metadata: metadata}
	input := append([]byte("RAIBIT-TEST-WIRE:"), []byte("REDIS0011payload")...)
	result := newHelper(config, dependencies{processes: &fakeProcessExecutor{process: &fakeManagedProcess{}}, dialer: &fakeDialer{target: target, source: source}, codec: codec, waiter: immediateWaiter{}, random: bytes.NewReader(bytes.Repeat([]byte{1}, 256))})
	receipts.index = config.index
	result.receipts = receipts
	return result, input
}
