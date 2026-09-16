package recoverycache

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type restoreHooks struct {
	beforeMutation func(artifactMetadata, artifactTransfer, string) error
	afterCopy      func(cacheClient, [][]byte) error
}

func (h *helper) restore(ctx context.Context, engine engine, input io.Reader) error {
	return h.restoreWithHooks(ctx, engine, input, restoreHooks{})
}

func (h *helper) restoreWithHooks(ctx context.Context, engine engine, input io.Reader, hooks restoreHooks) (resultErr error) {
	credential, err := h.readPassword()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(h.config.scratchPath, 0o700); err != nil {
		return safeStep("prepare scratch", ErrOperation)
	}
	rdbPath := filepath.Join(h.config.scratchPath, restoreRDBName)
	if err := replaceScratchFile(h.config.scratchPath, rdbPath); err != nil {
		return err
	}
	file, err := os.OpenFile(rdbPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return safeStep("create restore scratch", ErrOperation)
	}
	defer func() {
		if removeErr := os.Remove(rdbPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			resultErr = errors.Join(resultErr, safeStep("clean restore scratch", ErrOperation))
		}
	}()
	metadata, transfer, decodeErr := h.codec.decode(ctx, engine, input, file, h.config.maxArtifactBytes)
	closeErr := file.Close()
	if decodeErr != nil || closeErr != nil {
		if errors.Is(decodeErr, ErrLimit) {
			return ErrLimit
		}
		return safeStep("decode artifact", ErrOperation)
	}
	if metadata.engine != engine || metadata.sourceVersion == "" {
		return safeStep("verify artifact metadata", ErrOperation)
	}
	if err := validateArtifactFile(rdbPath, h.config.maxArtifactBytes); err != nil {
		return err
	}
	request := processRequest{kind: processValidate, engine: engine, config: h.config, path: rdbPath}
	if err := h.processes.run(ctx, request); err != nil {
		return safeStep("validate", ErrOperation)
	}
	target, err := h.dialer.dialTarget(ctx, h.config, credential)
	if err != nil {
		return safeStep("connect target", ErrOperation)
	}
	defer func() {
		if closeErr := target.close(); closeErr != nil {
			resultErr = errors.Join(resultErr, safeStep("close target", ErrOperation))
		}
	}()
	size, err := target.dbSize(ctx)
	if err != nil || size != 0 {
		return safeStep("require empty target", ErrOperation)
	}
	indexes, err := target.databaseIndexes(ctx)
	if err != nil || len(indexes) != 0 {
		return safeStep("require globally empty target", ErrOperation)
	}
	targetVersion, err := target.version(ctx, engine)
	if err != nil || !compatibleMajor(metadata.sourceVersion, targetVersion) {
		return safeStep("read target version", ErrOperation)
	}
	source, process, err := h.startTemporary(ctx, engine, rdbPath)
	if err != nil {
		return err
	}
	defer func() {
		resultErr = errors.Join(resultErr, closeTemporary(source, process))
	}()
	usedMemory, err := source.usedMemory(ctx)
	if err != nil || usedMemory > MaxSourceMemoryBytes {
		return safeStep("check restored memory", ErrLimit)
	}
	keys, err := h.prepareRestoreDataset(ctx, engine, source, metadata)
	if err != nil {
		return err
	}
	if hooks.beforeMutation != nil {
		if err := hooks.beforeMutation(metadata, transfer, targetVersion); err != nil {
			return safeStep("write restore intent", ErrOperation)
		}
	}
	if err := h.copyRestoreDataset(ctx, source, target, credential, keys); err != nil {
		return err
	}
	if hooks.afterCopy != nil {
		if err := hooks.afterCopy(target, keys); err != nil {
			return safeStep("write restore evidence", ErrOperation)
		}
	}
	versionAfter, err := target.version(ctx, engine)
	if err != nil || versionAfter != targetVersion {
		return safeStep("recheck target version", ErrOperation)
	}
	if err := h.probeTargetSentinel(ctx, target); err != nil {
		return err
	}
	return nil
}

func (h *helper) prepareRestoreDataset(ctx context.Context, engine engine, source cacheClient, metadata artifactMetadata) ([][]byte, error) {
	if _, err := source.version(ctx, engine); err != nil {
		return nil, safeStep("verify source version", ErrOperation)
	}
	indexes, err := source.databaseIndexes(ctx)
	if err != nil {
		return nil, safeStep("inspect source databases", ErrOperation)
	}
	for _, index := range indexes {
		if index != h.config.index {
			return nil, safeStep("reject cross-database artifact", ErrOperation)
		}
	}
	keys, err := scanAll(ctx, source, h.config.batchSize)
	if err != nil {
		return nil, err
	}
	count, digest, err := datasetSummary(ctx, source, keys)
	if err != nil || count != metadata.keyCount || digest != metadata.datasetSHA256 {
		return nil, safeStep("verify dataset identity", ErrOperation)
	}
	return keys, nil
}

func (h *helper) copyRestoreDataset(ctx context.Context, source, target cacheClient, credential []byte, keys [][]byte) error {
	for offset := 0; offset < len(keys); offset += h.config.batchSize {
		end := min(offset+h.config.batchSize, len(keys))
		batch := keys[offset:end]
		before, err := snapshots(ctx, source, batch)
		if err != nil {
			return err
		}
		migrateErr := source.migrate(ctx, h.config, credential, batch, h.config.migrationTimeout)
		if err := reconcileBatch(ctx, target, batch, before, h.config.ttlTolerance); err != nil {
			return err
		}
		if migrateErr != nil {
			// MIGRATE timeout is ambiguous. Verified target state is the only
			// authority; this branch deliberately makes no atomicity claim.
			continue
		}
	}
	return verifyDatasets(ctx, source, target, keys, h.config.ttlTolerance)
}

func compatibleMajor(source, target string) bool {
	sourceMajor, _, sourceOK := strings.Cut(source, ".")
	targetMajor, _, targetOK := strings.Cut(target, ".")
	return sourceOK && targetOK && sourceMajor != "" && sourceMajor == targetMajor
}

func snapshots(ctx context.Context, client cacheClient, keys [][]byte) ([]keySnapshot, error) {
	result := make([]keySnapshot, len(keys))
	for index, key := range keys {
		value, err := client.snapshot(ctx, key)
		if err != nil {
			return nil, safeStep("read source key", ErrOperation)
		}
		result[index] = value
	}
	return result, nil
}

func reconcileBatch(ctx context.Context, target cacheClient, keys [][]byte, before []keySnapshot, tolerance time.Duration) error {
	for index, key := range keys {
		after, err := target.snapshot(ctx, key)
		if err != nil || !before[index].equal(after, tolerance) {
			return safeStep("reconcile migrated batch", ErrOperation)
		}
	}
	return nil
}

func verifyDatasets(ctx context.Context, source, target cacheClient, keys [][]byte, tolerance time.Duration) error {
	targetKeys, err := scanAll(ctx, target, 64)
	if err != nil || len(targetKeys) != len(keys) {
		return safeStep("verify target key count", ErrOperation)
	}
	for index := range keys {
		if !bytes.Equal(keys[index], targetKeys[index]) {
			return safeStep("verify target keys", ErrOperation)
		}
		sourceValue, err := source.snapshot(ctx, keys[index])
		if err != nil {
			return safeStep("verify source key", ErrOperation)
		}
		targetValue, err := target.snapshot(ctx, keys[index])
		if err != nil || !sourceValue.equal(targetValue, tolerance) {
			return safeStep("verify target value", ErrOperation)
		}
	}
	return nil
}

func (h *helper) probeTargetSentinel(ctx context.Context, target cacheClient) (resultErr error) {
	random := make([]byte, 32)
	if _, err := io.ReadFull(h.random, random); err != nil {
		return safeStep("create sentinel", ErrOperation)
	}
	keyDigest := sha256.Sum256(append([]byte("key:"), random...))
	valueDigest := sha256.Sum256(append([]byte("value:"), random...))
	key := []byte(sentinelPrefix + hex.EncodeToString(keyDigest[:]))
	value := []byte(hex.EncodeToString(valueDigest[:]))
	ttl := time.Minute
	if err := target.set(ctx, key, value, ttl, true); err != nil {
		return safeStep("write sentinel", ErrOperation)
	}
	deleted := false
	defer func() {
		if !deleted {
			if err := target.delete(ctx, key); err != nil {
				resultErr = errors.Join(resultErr, safeStep("clean sentinel", ErrOperation))
			}
		}
	}()
	readback, err := target.get(ctx, key)
	if err != nil || !bytes.Equal(readback, value) {
		return safeStep("read sentinel", ErrOperation)
	}
	snapshot, err := target.snapshot(ctx, key)
	if err != nil || snapshot.pttl <= 0 || snapshot.pttl > ttl.Milliseconds() {
		return safeStep("verify sentinel TTL", ErrOperation)
	}
	if err := target.delete(ctx, key); err != nil {
		return safeStep("delete sentinel", ErrOperation)
	}
	deleted = true
	return nil
}
