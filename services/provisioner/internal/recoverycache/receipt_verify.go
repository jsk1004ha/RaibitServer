package recoverycache

import (
	"context"
	"errors"
	"io"
)

func (h *helper) verifyReceipt(ctx context.Context, value engine) (resultErr error) {
	credential, err := h.readPassword()
	if err != nil {
		return err
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
	if err := target.ping(ctx); err != nil {
		return safeStep("ping target", ErrOperation)
	}
	var verifiedRecords []ttlRecord
	stage, present, err := h.receipts.consumeRestore(value, func(source io.Reader) error {
		records, decodeErr := decodeAuthenticatedTTLRecords(source)
		if decodeErr != nil {
			return decodeErr
		}
		if verifyErr := verifyTTLRecords(ctx, target, records, int64(len(records))); verifyErr != nil {
			return verifyErr
		}
		verifiedRecords = records
		return nil
	})
	if err != nil {
		return safeStep("consume restore evidence", ErrOperation)
	}
	if !present {
		metadata, inspectErr := h.inspectSource(ctx, value, target)
		if inspectErr != nil {
			return inspectErr
		}
		if err := h.receipts.writeDump(value, metadata); err != nil {
			return safeStep("write backup intent", ErrOperation)
		}
		return nil
	}
	if uint64(len(verifiedRecords)) != stage.stage.Baseline().RecordCount {
		return safeStep("verify restored record count", ErrOperation)
	}
	targetVersion, err := target.version(ctx, value)
	if err != nil {
		return safeStep("read final target version", ErrOperation)
	}
	if err := h.probeTargetSentinel(ctx, target); err != nil {
		return err
	}
	if err := h.receipts.finishRestore(stage, targetVersion); err != nil {
		return safeStep("write restore receipt", ErrOperation)
	}
	return nil
}

func (h *helper) inspectSource(ctx context.Context, value engine, source cacheClient) (artifactMetadata, error) {
	usedMemory, err := source.usedMemory(ctx)
	if err != nil || usedMemory > MaxSourceMemoryBytes {
		return artifactMetadata{}, safeStep("check source memory", ErrLimit)
	}
	version, err := source.version(ctx, value)
	if err != nil {
		return artifactMetadata{}, safeStep("read source version", ErrOperation)
	}
	indexes, err := source.databaseIndexes(ctx)
	if err != nil {
		return artifactMetadata{}, safeStep("inspect source databases", ErrOperation)
	}
	for _, index := range indexes {
		if index != h.config.index {
			return artifactMetadata{}, safeStep("reject cross-database source", ErrOperation)
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
	return artifactMetadata{engine: value, sourceVersion: version, keyCount: count, datasetSHA256: digest}, nil
}

func (h *helper) verify(ctx context.Context, value engine) (resultErr error) {
	credential, err := h.readPassword()
	if err != nil {
		return err
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
	if err := target.ping(ctx); err != nil {
		return safeStep("ping target", ErrOperation)
	}
	if _, err := target.version(ctx, value); err != nil {
		return safeStep("read target version", ErrOperation)
	}
	return nil
}
