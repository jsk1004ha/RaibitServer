package recoverycache

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func Test_Restore_rejects_target_with_data_in_another_database(t *testing.T) {
	// Given
	target := newFakeCache(nil)
	target.databaseIndexesValue = []uint16{1}
	runtime := &fakeProcessExecutor{}
	helper := newHelper(testConfig(t.TempDir()), dependencies{
		processes: runtime,
		dialer:    &fakeDialer{target: target, source: newFakeCache(nil)},
		codec:     fakeArtifactCodec{},
		waiter:    immediateWaiter{},
		random:    bytes.NewReader(bytes.Repeat([]byte{0x42}, 32)),
	})

	// When
	err := helper.run(context.Background(), "redis-restore", bytes.NewBufferString("RAIBIT-TEST-WIRE:REDIS0011payload"), io.Discard)

	// Then
	if !errors.Is(err, ErrOperation) {
		t.Fatalf("error = %v, want ErrOperation", err)
	}
	for _, kind := range runtime.kinds() {
		if kind == "server" {
			t.Fatal("temporary restore server started before whole-target emptiness proof")
		}
	}
}

func Test_Cleanup_restore_replaces_stale_bounded_scratch(t *testing.T) {
	// Given
	scratch := t.TempDir()
	config := testConfig(scratch)
	if err := os.WriteFile(filepath.Join(scratch, restoreRDBName), []byte("stale"), 0o600); err != nil {
		t.Fatalf("seed stale scratch: %v", err)
	}
	source := newFakeCache(nil)
	target := newFakeCache(nil)
	codec := newRecoveryWireCodec(config.index)
	input := encodeTestWire(t, codec, testMetadata(source, engineRedis), "REDIS0011payload")
	helper := newHelper(config, dependencies{
		processes: &fakeProcessExecutor{process: &fakeManagedProcess{}},
		dialer:    &fakeDialer{target: target, source: source},
		codec:     codec,
		waiter:    immediateWaiter{},
		random:    bytes.NewReader(bytes.Repeat([]byte{0x43}, 32)),
	})

	// When
	err := helper.run(context.Background(), "redis-restore", bytes.NewReader(input), io.Discard)

	// Then
	if err != nil {
		t.Fatalf("restore with stale scratch: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(scratch, restoreRDBName)); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("restore scratch remains: %v", statErr)
	}
}

func Test_Restore_rejects_target_with_incompatible_source_major_version(t *testing.T) {
	// Given
	source := newFakeCache(nil)
	target := newFakeCache(nil)
	target.versionValue = "8.0.1"
	config := testConfig(t.TempDir())
	codec := newRecoveryWireCodec(config.index)
	input := encodeTestWire(t, codec, testMetadata(source, engineRedis), "REDIS0011payload")
	runtime := &fakeProcessExecutor{process: &fakeManagedProcess{}}
	helper := newHelper(config, dependencies{processes: runtime, dialer: &fakeDialer{target: target, source: source}, codec: codec, waiter: immediateWaiter{}, random: bytes.NewReader(bytes.Repeat([]byte{0x44}, 32))})

	// When
	err := helper.run(context.Background(), "redis-restore", bytes.NewReader(input), io.Discard)

	// Then
	if !errors.Is(err, ErrOperation) {
		t.Fatalf("error = %v, want ErrOperation", err)
	}
	for _, kind := range runtime.kinds() {
		if kind == "server" {
			t.Fatal("temporary server started after incompatible target version")
		}
	}
}
