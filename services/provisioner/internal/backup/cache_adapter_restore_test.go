package backup

import (
	"context"
	"errors"
	"testing"
)

func Test_CacheAdapters_restore_rejects_corrupt_stream_and_incompatible_version(t *testing.T) {
	adapter := NewRedisRecoveryAdapter()
	source := cacheConnection(t, EngineRedis, "source", "cache.internal", "7.2.4")
	artifact, _ := cacheArtifact(t, adapter, source)
	majorMismatch := cacheConnection(t, EngineRedis, "major-mismatch", "major-cache.internal", "8.0.1")
	if _, err := NewRestoreRequest(source, majorMismatch, artifact, NewMajorVersionCompatibility(artifact.Format())); !errors.Is(err, ErrRecoveryRequest) {
		t.Fatalf("major version accepted: %v", err)
	}
	target := cacheConnection(t, EngineRedis, "target", "target-cache.internal", "7.2.8")
	restore, err := NewRestoreRequest(source, target, artifact, NewMajorVersionCompatibility(artifact.Format()))
	if err != nil {
		t.Fatal(err)
	}
	input := &corruptSQLInput{}
	handoff, err := NewRestoreHandoff(context.Background(), input, 32)
	if err != nil {
		t.Fatal(err)
	}

	// When: a partial RDB stream ends in an error before the helper can verify it.
	receipt, restoreErr := adapter.Restore(context.Background(), restore, handoff, &cacheRunner{})

	// Then: no receipt is minted after the handoff aborts the failed transfer.
	if restoreErr == nil || receipt.Target().ResourceID() != "" {
		t.Fatalf("receipt=%+v err=%v", receipt, restoreErr)
	}
}
