package recoverycache

import (
	"context"
	"crypto/sha256"
	"errors"
	"hash"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"
)

type backupResult struct {
	metadata artifactMetadata
	transfer artifactTransfer
}

func (h *helper) backup(ctx context.Context, engine engine, output io.Writer) error {
	_, err := h.backupArtifact(ctx, engine, output)
	return err
}

func (h *helper) backupArtifact(ctx context.Context, engine engine, output io.Writer) (result backupResult, resultErr error) {
	credential, err := h.readPassword()
	if err != nil {
		return backupResult{}, err
	}
	remote, err := h.dialer.dialTarget(ctx, h.config, credential)
	if err != nil {
		return backupResult{}, safeStep("connect", ErrOperation)
	}
	defer func() {
		if closeErr := remote.close(); closeErr != nil {
			resultErr = errors.Join(resultErr, safeStep("close", ErrOperation))
		}
	}()
	usedMemory, err := remote.usedMemory(ctx)
	if err != nil || usedMemory > MaxSourceMemoryBytes {
		return backupResult{}, safeStep("check source memory", ErrLimit)
	}
	sourceVersion, err := remote.version(ctx, engine)
	if err != nil {
		return backupResult{}, safeStep("read source version", ErrOperation)
	}
	before, err := remote.lastSave(ctx)
	if err != nil {
		return backupResult{}, safeStep("read persistence marker", ErrOperation)
	}
	if delay := time.Unix(before+1, 0).Sub(h.now()); delay > 0 {
		if err := h.waiter.wait(ctx, delay); err != nil {
			return backupResult{}, safeStep("wait for persistence epoch", ErrOperation)
		}
	}
	if err := remote.bgSave(ctx); err != nil {
		return backupResult{}, safeStep("request persistence", ErrOperation)
	}
	if err := h.awaitLastSave(ctx, remote, before); err != nil {
		return backupResult{}, err
	}
	if err := os.MkdirAll(h.config.scratchPath, 0o700); err != nil {
		return backupResult{}, safeStep("prepare scratch", ErrOperation)
	}
	rdbPath := filepath.Join(h.config.scratchPath, backupRDBName)
	if err := replaceScratchFile(h.config.scratchPath, rdbPath); err != nil {
		return backupResult{}, err
	}
	defer func() {
		if removeErr := os.Remove(rdbPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			resultErr = errors.Join(resultErr, safeStep("clean scratch", ErrOperation))
		}
	}()
	request := processRequest{kind: processCapture, engine: engine, config: h.config, path: rdbPath}
	if err := h.processes.run(ctx, request); err != nil {
		return backupResult{}, safeStep("capture", ErrOperation)
	}
	if err := validateArtifactFile(rdbPath, h.config.maxArtifactBytes); err != nil {
		return backupResult{}, err
	}
	request.kind = processValidate
	if err := h.processes.run(ctx, request); err != nil {
		return backupResult{}, safeStep("validate", ErrOperation)
	}
	metadata, err := h.metadataFromRDB(ctx, engine, sourceVersion, rdbPath)
	if err != nil {
		return backupResult{}, err
	}
	file, err := os.Open(rdbPath)
	if err != nil {
		return backupResult{}, safeStep("open artifact", ErrOperation)
	}
	defer func() {
		if closeErr := file.Close(); closeErr != nil {
			resultErr = errors.Join(resultErr, safeStep("close artifact", ErrOperation))
		}
	}()
	transfer, err := h.codec.encode(ctx, metadata, file, output, h.config.maxArtifactBytes)
	if err != nil {
		if errors.Is(err, ErrLimit) {
			return backupResult{}, ErrLimit
		}
		return backupResult{}, safeStep("encode artifact", ErrOperation)
	}
	return backupResult{metadata: metadata, transfer: transfer}, nil
}

func (h *helper) awaitLastSave(ctx context.Context, remote cacheClient, before int64) error {
	for {
		after, err := remote.lastSave(ctx)
		if err != nil {
			return safeStep("observe persistence", ErrOperation)
		}
		if after > before {
			return nil
		}
		if err := h.waiter.wait(ctx, h.config.pollInterval); err != nil {
			return safeStep("observe persistence", ErrOperation)
		}
	}
}

func (h *helper) metadataFromRDB(ctx context.Context, engine engine, sourceVersion, rdbPath string) (metadata artifactMetadata, resultErr error) {
	source, process, err := h.startTemporary(ctx, engine, rdbPath)
	if err != nil {
		return artifactMetadata{}, err
	}
	defer func() {
		resultErr = errors.Join(resultErr, closeTemporary(source, process))
	}()
	usedMemory, err := source.usedMemory(ctx)
	if err != nil || usedMemory > MaxSourceMemoryBytes {
		return artifactMetadata{}, safeStep("check captured memory", ErrLimit)
	}
	if _, err := source.version(ctx, engine); err != nil {
		return artifactMetadata{}, safeStep("read captured version", ErrOperation)
	}
	indexes, err := source.databaseIndexes(ctx)
	if err != nil {
		return artifactMetadata{}, safeStep("inspect captured databases", ErrOperation)
	}
	for _, index := range indexes {
		if index != h.config.index {
			return artifactMetadata{}, safeStep("reject cross-database artifact", ErrOperation)
		}
	}
	keys, err := scanAll(ctx, source, h.config.batchSize)
	if err != nil {
		return artifactMetadata{}, err
	}
	count, digest, err := datasetSummary(ctx, source, keys)
	if err != nil {
		return artifactMetadata{}, err
	}
	return artifactMetadata{engine: engine, sourceVersion: sourceVersion, keyCount: count, datasetSHA256: digest}, nil
}

func datasetSummary(ctx context.Context, client cacheClient, keys [][]byte) (int64, [32]byte, error) {
	sort.Slice(keys, func(left, right int) bool { return string(keys[left]) < string(keys[right]) })
	digest := sha256.New()
	for _, key := range keys {
		snapshot, err := client.snapshot(ctx, key)
		if err != nil {
			return 0, [32]byte{}, safeStep("summarize dataset", ErrOperation)
		}
		writeDatasetEntry(digest, key, snapshot)
	}
	var result [32]byte
	copy(result[:], digest.Sum(nil))
	return int64(len(keys)), result, nil
}

func writeDatasetEntry(digest hash.Hash, key []byte, snapshot keySnapshot) {
	keyDigest := sha256.Sum256(key)
	valueDigest := sha256.Sum256(snapshot.dump)
	digest.Write(keyDigest[:])
	digest.Write([]byte{0})
	digest.Write([]byte(snapshot.kind))
	digest.Write([]byte{0})
	digest.Write(valueDigest[:])
	if snapshot.pttl == -1 {
		digest.Write([]byte("P"))
	} else {
		digest.Write([]byte("E"))
	}
}

func validateArtifactFile(path string, max int64) error {
	info, err := os.Stat(path)
	if err != nil {
		return safeStep("inspect artifact", ErrOperation)
	}
	if !info.Mode().IsRegular() || info.Size() < 1 {
		return safeStep("inspect artifact", ErrOperation)
	}
	if info.Size() > max {
		return ErrLimit
	}
	return nil
}
