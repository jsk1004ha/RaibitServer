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
	"time"
)

func Test_Backup_streams_only_validated_RDB_without_secret_argv(t *testing.T) {
	// Given
	scratch := t.TempDir()
	remote := newFakeCache(map[string]keySnapshot{})
	remote.lastSaves = []int64{10, 11}
	remote.versionValue = "7.2.9"
	captured := newFakeCache(nil)
	config := testConfig(scratch)
	codec := newRecoveryWireCodec(config.index)
	runtime := &fakeProcessExecutor{rdb: []byte("REDIS0011payload")}
	helper := newHelper(config, dependencies{
		processes: runtime,
		dialer:    &fakeDialer{target: remote, source: captured},
		codec:     codec,
		waiter:    immediateWaiter{},
		random:    bytes.NewReader(bytes.Repeat([]byte{0x2a}, 32)),
	})
	var output bytes.Buffer

	// When
	err := helper.run(context.Background(), "redis-backup", bytes.NewReader(nil), &output)

	// Then
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if strings.Contains(output.String(), "REDIS0011payload") || !strings.HasPrefix(output.String(), "RAIBIT-RECOVERY/1 redis ") {
		t.Fatalf("backup is not a log-safe v1 envelope: %q", output.String())
	}
	var decoded bytes.Buffer
	decodedMetadata, _, err := codec.decode(t.Context(), engineRedis, bytes.NewReader(output.Bytes()), &decoded, config.maxArtifactBytes)
	if err != nil || decoded.String() != "REDIS0011payload" || decodedMetadata.sourceVersion != "7.2.9" {
		t.Fatalf("decode backup: payload=%q error=%v", decoded.String(), err)
	}
	if remote.bgSaveCalls != 1 || remote.lastSaveCalls < 2 {
		t.Fatalf("BGSAVE=%d LASTSAVE=%d", remote.bgSaveCalls, remote.lastSaveCalls)
	}
	if got := runtime.kinds(); strings.Join(got, ",") != "probe,capture,validate,server" {
		t.Fatalf("process sequence = %v", got)
	}
	name, args, env, err := buildCommand(runtime.requests[1], []byte("top-secret"))
	if err != nil {
		t.Fatalf("build capture command: %v", err)
	}
	joined := name + " " + strings.Join(args, " ")
	if strings.Contains(joined, "top-secret") {
		t.Fatalf("secret leaked in argv: %q", joined)
	}
	if !containsEnv(env, "REDISCLI_AUTH=top-secret") {
		t.Fatalf("credential missing from child env names: %v", envNames(env))
	}
	merged := mergeEnvironment([]string{"PATH=/bin", "REDISCLI_AUTH=stale"}, env)
	if containsEnv(merged, "REDISCLI_AUTH=stale") || !containsEnv(merged, "REDISCLI_AUTH=top-secret") {
		t.Fatalf("capture environment did not replace stale credential: %v", envNames(merged))
	}
}

func Test_Restore_preserves_value_type_and_TTL_across_cursor_batches(t *testing.T) {
	// Given
	scratch := t.TempDir()
	source := newFakeCache(map[string]keySnapshot{
		"alpha": {kind: "string", dump: []byte("dump-a"), pttl: -1},
		"beta":  {kind: "list", dump: []byte("dump-b"), pttl: 80_000},
	})
	source.scanPages = []scanPage{
		{next: "9", keys: [][]byte{[]byte("alpha"), []byte("beta")}},
		{next: "0", keys: [][]byte{[]byte("beta")}},
	}
	target := newFakeCache(map[string]keySnapshot{})
	runtime := &fakeProcessExecutor{}
	process := &fakeManagedProcess{}
	runtime.process = process
	config := testConfig(scratch)
	codec := newRecoveryWireCodec(config.index)
	input := encodeTestWire(t, codec, testMetadata(source, engineRedis), "REDIS0011payload")
	helper := newHelper(config, dependencies{
		processes: runtime,
		dialer:    &fakeDialer{target: target, source: source},
		codec:     codec,
		waiter:    immediateWaiter{},
		random:    bytes.NewReader(bytes.Repeat([]byte{0x2b}, 32)),
	})

	// When
	var output bytes.Buffer
	err := helper.run(context.Background(), "redis-restore", bytes.NewReader(input), &output)

	// Then
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	for _, key := range []string{"alpha", "beta"} {
		if !source.values[key].equal(target.values[key], testConfig(scratch).ttlTolerance) {
			t.Fatalf("key %q source=%+v target=%+v", key, source.values[key], target.values[key])
		}
	}
	if source.migrateCalls != 1 {
		t.Fatalf("MIGRATE calls = %d, want 1 deduplicated batch", source.migrateCalls)
	}
	if target.hasSentinel() {
		t.Fatal("sentinel remained in target")
	}
	if target.setCalls != 1 || target.getCalls != 1 || target.deleteCalls != 1 {
		t.Fatalf("sentinel operations set=%d get=%d delete=%d", target.setCalls, target.getCalls, target.deleteCalls)
	}
	if output.Len() != 0 {
		t.Fatalf("restore wrote stdout noise: %q", output.String())
	}
	if process.stopCalls != 1 || process.waitCalls != 1 {
		t.Fatalf("process cleanup stop=%d wait=%d", process.stopCalls, process.waitCalls)
	}
	if _, err := os.Stat(filepath.Join(scratch, restoreRDBName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("restore scratch remains: %v", err)
	}
}

func Test_Restore_reconciles_ambiguous_MIGRATE_without_claiming_atomicity(t *testing.T) {
	// Given
	source := newFakeCache(map[string]keySnapshot{
		"alpha": {kind: "string", dump: []byte("dump-a"), pttl: -1},
	})
	source.scanPages = []scanPage{{next: "0", keys: [][]byte{[]byte("alpha")}}}
	source.migrateErr = errors.New("timeout after write")
	source.migrateWritesBeforeError = true
	target := newFakeCache(nil)
	source.migrateTarget = target
	scratch := t.TempDir()
	config := testConfig(scratch)
	codec := newRecoveryWireCodec(config.index)
	input := encodeTestWire(t, codec, testMetadata(source, engineRedis), "REDIS0011payload")
	helper := newHelper(config, dependencies{
		processes: &fakeProcessExecutor{process: &fakeManagedProcess{}},
		dialer:    &fakeDialer{target: target, source: source},
		codec:     codec,
		waiter:    immediateWaiter{},
		random:    bytes.NewReader(bytes.Repeat([]byte{0x2c}, 32)),
	})

	// When
	err := helper.run(context.Background(), "redis-restore", bytes.NewReader(input), io.Discard)

	// Then
	if err != nil {
		t.Fatalf("ambiguous migration should reconcile verified writes: %v", err)
	}
	if !source.values["alpha"].equal(target.values["alpha"], testConfig(scratch).ttlTolerance) {
		t.Fatal("reconciled target does not match source")
	}
}

func testConfig(scratch string) config {
	credentialPath := filepath.Join(scratch, "credential")
	if err := os.WriteFile(credentialPath, []byte("top-secret"), 0o600); err != nil {
		panic(err)
	}
	return config{
		host:             "cache.internal",
		port:             6379,
		username:         "default",
		index:            0,
		credentialPath:   credentialPath,
		scratchPath:      scratch,
		maxArtifactBytes: 1 << 20,
		batchSize:        64,
		migrationTimeout: 5 * time.Second,
		operationTimeout: time.Minute,
		pollInterval:     time.Millisecond,
		ttlTolerance:     5 * time.Second,
	}
}

func containsEnv(env []string, wanted string) bool {
	for _, value := range env {
		if value == wanted {
			return true
		}
	}
	return false
}

func envNames(env []string) []string {
	names := make([]string, 0, len(env))
	for _, value := range env {
		name, _, _ := strings.Cut(value, "=")
		names = append(names, name)
	}
	return names
}

func encodeTestWire(t *testing.T, codec artifactCodec, metadata artifactMetadata, payload string) []byte {
	t.Helper()
	var encoded bytes.Buffer
	if _, err := codec.encode(t.Context(), metadata, strings.NewReader(payload), &encoded, 1<<20); err != nil {
		t.Fatalf("encode test wire: %v", err)
	}
	return encoded.Bytes()
}
