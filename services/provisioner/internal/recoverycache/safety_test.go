package recoverycache

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func Test_Bounds_rejects_oversized_restore_and_removes_scratch(t *testing.T) {
	// Given
	config := testConfig(t.TempDir())
	config.maxArtifactBytes = 8
	helper := newHelper(config, dependencies{processes: &fakeProcessExecutor{}, dialer: &fakeDialer{target: newFakeCache(nil), source: newFakeCache(nil)}, codec: fakeArtifactCodec{}, waiter: immediateWaiter{}, random: bytes.NewReader(bytes.Repeat([]byte{0x2d}, 32))})

	// When
	err := helper.run(context.Background(), "redis-restore", bytes.NewBufferString("RAIBIT-TEST-WIRE:123456789"), io.Discard)

	// Then
	if !errors.Is(err, ErrLimit) {
		t.Fatalf("error = %v, want ErrLimit", err)
	}
	if _, statErr := os.Stat(filepath.Join(config.scratchPath, restoreRDBName)); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("oversized scratch remains: %v", statErr)
	}
}

func Test_Redaction_hides_endpoint_credential_and_raw_child_error(t *testing.T) {
	// Given
	config := testConfig(t.TempDir())
	config.host = "sensitive.internal"
	runtime := &fakeProcessExecutor{runErr: errors.New("sensitive.internal top-secret raw stderr")}
	helper := newHelper(config, dependencies{processes: runtime, dialer: &fakeDialer{target: newFakeCache(nil), source: newFakeCache(nil)}, codec: fakeArtifactCodec{}, waiter: immediateWaiter{}, random: bytes.NewReader(bytes.Repeat([]byte{0x2e}, 32))})

	// When
	err := helper.run(context.Background(), "redis-backup", bytes.NewReader(nil), io.Discard)

	// Then
	message := err.Error()
	for _, secret := range []string{"sensitive.internal", "top-secret", "raw stderr"} {
		if strings.Contains(message, secret) {
			t.Fatalf("error leaked %q: %q", secret, message)
		}
	}
}

func Test_Timeout_stops_and_waits_for_temporary_server(t *testing.T) {
	// Given
	process := &fakeManagedProcess{}
	runtime := &fakeProcessExecutor{process: process}
	dialer := &fakeDialer{target: newFakeCache(nil), sourceErr: context.DeadlineExceeded}
	helper := newHelper(testConfig(t.TempDir()), dependencies{processes: runtime, dialer: dialer, codec: fakeArtifactCodec{}, waiter: errorWaiter{err: context.DeadlineExceeded}, random: bytes.NewReader(bytes.Repeat([]byte{0x2f}, 32))})

	// When
	err := helper.run(context.Background(), "redis-restore", bytes.NewBufferString("RAIBIT-TEST-WIRE:REDIS0011payload"), io.Discard)

	// Then
	if !errors.Is(err, ErrOperation) {
		t.Fatalf("error = %v, want ErrOperation", err)
	}
	if process.stopCalls != 1 || process.waitCalls != 1 {
		t.Fatalf("process cleanup stop=%d wait=%d", process.stopCalls, process.waitCalls)
	}
}

func Test_Capability_rejects_Valkey_without_RDB_capture_support(t *testing.T) {
	// Given
	runtime := &fakeProcessExecutor{probeErr: ErrCapability}
	helper := newHelper(testConfig(t.TempDir()), dependencies{processes: runtime, dialer: &fakeDialer{target: newFakeCache(nil), source: newFakeCache(nil)}, codec: fakeArtifactCodec{}, waiter: immediateWaiter{}, random: bytes.NewReader(bytes.Repeat([]byte{0x30}, 32))})

	// When
	err := helper.run(context.Background(), "valkey-backup", bytes.NewReader(nil), io.Discard)

	// Then
	if !errors.Is(err, ErrCapability) {
		t.Fatalf("error = %v, want ErrCapability", err)
	}
}

func Test_Cleanup_closes_clients_after_success(t *testing.T) {
	// Given
	remote := newFakeCache(nil)
	remote.lastSaves = []int64{1, 2}
	helper := newHelper(testConfig(t.TempDir()), dependencies{processes: &fakeProcessExecutor{rdb: []byte("REDIS0011payload")}, dialer: &fakeDialer{target: remote, source: newFakeCache(nil)}, codec: fakeArtifactCodec{}, waiter: immediateWaiter{}, random: bytes.NewReader(bytes.Repeat([]byte{0x31}, 32))})

	// When
	err := helper.run(context.Background(), "redis-backup", bytes.NewReader(nil), io.Discard)

	// Then
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if remote.closeCalls != 1 {
		t.Fatalf("close calls = %d", remote.closeCalls)
	}
}

func Test_Capability_action_allowlist_rejects_extra_or_unknown_tokens(t *testing.T) {
	// Given
	for _, args := range [][]string{{}, {"redis-backup", "extra"}, {"shell"}, {"redis_backup"}} {
		// When
		_, err := parseAction(args)

		// Then
		if !errors.Is(err, ErrAction) {
			t.Fatalf("parseAction(%q) error = %v", args, err)
		}
	}
}

func Test_Bounds_backup_rejects_large_source_before_capture(t *testing.T) {
	// Given
	remote := newFakeCache(nil)
	remote.usedMemoryValue = MaxSourceMemoryBytes + 1
	runtime := &fakeProcessExecutor{rdb: []byte("REDIS0011payload")}
	helper := newHelper(testConfig(t.TempDir()), dependencies{processes: runtime, dialer: &fakeDialer{target: remote, source: newFakeCache(nil)}, codec: fakeArtifactCodec{}, waiter: immediateWaiter{}, random: bytes.NewReader(bytes.Repeat([]byte{0x32}, 32))})

	// When
	err := helper.run(context.Background(), "redis-backup", bytes.NewReader(nil), io.Discard)

	// Then
	if !errors.Is(err, ErrLimit) {
		t.Fatalf("error = %v, want ErrLimit", err)
	}
	if len(runtime.requests) != 1 || runtime.requests[0].kind != processProbe {
		t.Fatalf("capture started before source memory check: %v", runtime.kinds())
	}
}

func Test_Bounds_restore_rejects_large_loaded_RDB_before_target_copy(t *testing.T) {
	// Given
	source := newFakeCache(nil)
	source.usedMemoryValue = MaxSourceMemoryBytes + 1
	target := newFakeCache(nil)
	helper := newHelper(testConfig(t.TempDir()), dependencies{processes: &fakeProcessExecutor{process: &fakeManagedProcess{}}, dialer: &fakeDialer{target: target, source: source}, codec: fakeArtifactCodec{}, waiter: immediateWaiter{}, random: bytes.NewReader(bytes.Repeat([]byte{0x33}, 32))})

	// When
	err := helper.run(context.Background(), "redis-restore", bytes.NewBufferString("RAIBIT-TEST-WIRE:REDIS0011payload"), io.Discard)

	// Then
	if !errors.Is(err, ErrLimit) {
		t.Fatalf("error = %v, want ErrLimit", err)
	}
	if source.migrateCalls != 0 || len(target.values) != 0 {
		t.Fatalf("target changed after oversized restore: migrate=%d values=%d", source.migrateCalls, len(target.values))
	}
}

func Test_Capability_temporary_server_waits_for_complete_RDB_load(t *testing.T) {
	// Given
	source := newFakeCache(nil)
	source.readyErr = ErrOperation
	process := &fakeManagedProcess{}
	helper := newHelper(testConfig(t.TempDir()), dependencies{processes: &fakeProcessExecutor{process: process}, dialer: &fakeDialer{target: newFakeCache(nil), source: source}, codec: fakeArtifactCodec{}, waiter: errorWaiter{err: context.DeadlineExceeded}, random: bytes.NewReader(bytes.Repeat([]byte{0x34}, 32))})

	// When
	err := helper.run(context.Background(), "redis-restore", bytes.NewBufferString("RAIBIT-TEST-WIRE:REDIS0011payload"), io.Discard)

	// Then
	if !errors.Is(err, ErrOperation) || process.stopCalls != 1 || process.waitCalls != 1 {
		t.Fatalf("error=%v cleanup stop=%d wait=%d", err, process.stopCalls, process.waitCalls)
	}
}

func Test_Capability_temporary_server_is_unix_only_no_save_no_eviction(t *testing.T) {
	// Given
	config := testConfig(t.TempDir())
	request := processRequest{kind: processServer, engine: engineRedis, config: config, path: filepath.Join(config.scratchPath, restoreRDBName), socket: filepath.Join(config.scratchPath, temporarySocketName)}

	// When
	name, args, env, err := buildCommand(request, nil)

	// Then
	joined := strings.Join(args, " ")
	for _, required := range []string{"--port 0", "--unixsocket ", "--unixsocketperm 600", "--save ", "--appendonly no", "--maxmemory-policy noeviction"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("server command missing %q: %s", required, joined)
		}
	}
	if err != nil || name != "redis-server" || len(env) != 0 {
		t.Fatalf("name=%q env=%v error=%v", name, env, err)
	}
}

func Test_Redaction_prebackup_verify_never_mutates_source(t *testing.T) {
	// Given
	target := newFakeCache(map[string]keySnapshot{"existing": {kind: "string", dump: []byte("value"), pttl: -1}})
	helper := newHelper(testConfig(t.TempDir()), dependencies{processes: &fakeProcessExecutor{}, dialer: &fakeDialer{target: target}, codec: fakeArtifactCodec{}, waiter: immediateWaiter{}, random: bytes.NewReader(bytes.Repeat([]byte{0x35}, 32))})

	// When
	err := helper.run(context.Background(), "redis-verify", bytes.NewReader(nil), io.Discard)

	// Then
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if target.setCalls != 0 || target.getCalls != 0 || target.deleteCalls != 0 || len(target.values) != 1 {
		t.Fatalf("source was mutated: set=%d get=%d delete=%d values=%d", target.setCalls, target.getCalls, target.deleteCalls, len(target.values))
	}
}
