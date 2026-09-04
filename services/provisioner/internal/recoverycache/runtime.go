package recoverycache

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
)

const (
	temporarySocketName = "source.sock"
	maxScannedKeys      = 1_000_000
	maxScanPages        = 65_536
)

func replaceScratchFile(scratchPath, filePath string) error {
	cleanScratch := filepath.Clean(scratchPath)
	cleanFile := filepath.Clean(filePath)
	if filepath.Dir(cleanFile) != cleanScratch || cleanFile == cleanScratch {
		return ErrConfig
	}
	if err := os.Remove(cleanFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		return safeStep("remove stale scratch", ErrOperation)
	}
	return nil
}

func (h *helper) startTemporary(ctx context.Context, engine engine, rdbPath string) (cacheClient, managedProcess, error) {
	socketPath := filepath.Join(h.config.scratchPath, temporarySocketName)
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, nil, safeStep("prepare isolated socket", ErrOperation)
	}
	request := processRequest{kind: processServer, engine: engine, config: h.config, path: rdbPath, socket: socketPath}
	process, err := h.processes.start(ctx, request)
	if err != nil {
		return nil, nil, safeStep("start isolated server", ErrOperation)
	}
	for {
		source, dialErr := h.dialer.dialSource(ctx, socketPath, h.config.index)
		if dialErr == nil {
			if pingErr := source.ping(ctx); pingErr == nil && source.ready(ctx) == nil {
				return source, process, nil
			}
			if closeErr := source.close(); closeErr != nil {
				return nil, nil, errors.Join(safeStep("close unready source", ErrOperation), closeTemporary(nil, process))
			}
		}
		if err := h.waiter.wait(ctx, h.config.pollInterval); err != nil {
			return nil, nil, errors.Join(safeStep("await isolated server", ErrOperation), closeTemporary(nil, process))
		}
	}
}

func closeTemporary(source cacheClient, process managedProcess) error {
	var result error
	if source != nil {
		if err := source.close(); err != nil {
			result = errors.Join(result, safeStep("close isolated source", ErrOperation))
		}
	}
	if process != nil {
		if err := process.stop(); err != nil {
			result = errors.Join(result, safeStep("stop isolated server", ErrOperation))
		}
		if err := process.wait(); err != nil {
			result = errors.Join(result, safeStep("wait isolated server", ErrOperation))
		}
	}
	return result
}

func scanAll(ctx context.Context, client cacheClient, batchSize int) ([][]byte, error) {
	cursor := "0"
	seen := make(map[string][]byte)
	for page := 0; page < maxScanPages; page++ {
		next, keys, err := client.scan(ctx, cursor, batchSize)
		if err != nil {
			return nil, safeStep("scan dataset", ErrOperation)
		}
		for _, key := range keys {
			if len(key) == 0 {
				return nil, ErrLimit
			}
			if _, exists := seen[string(key)]; !exists && len(seen) >= maxScannedKeys {
				return nil, ErrLimit
			}
			seen[string(key)] = append([]byte(nil), key...)
		}
		if next == "0" {
			result := make([][]byte, 0, len(seen))
			for _, key := range seen {
				result = append(result, key)
			}
			sort.Slice(result, func(left, right int) bool { return string(result[left]) < string(result[right]) })
			return result, nil
		}
		if next == cursor {
			return nil, safeStep("scan dataset", ErrOperation)
		}
		cursor = next
	}
	return nil, ErrLimit
}
