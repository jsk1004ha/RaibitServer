package recoverycache

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"slices"
	"time"
)

type fakeProcessExecutor struct {
	requests []processRequest
	rdb      []byte
	runErr   error
	probeErr error
	process  *fakeManagedProcess
}

func (f *fakeProcessExecutor) run(_ context.Context, request processRequest) error {
	f.requests = append(f.requests, request)
	if request.kind == processCapture && f.runErr == nil {
		return os.WriteFile(request.path, f.rdb, 0o600)
	}
	return f.runErr
}

func (f *fakeProcessExecutor) start(_ context.Context, request processRequest) (managedProcess, error) {
	f.requests = append(f.requests, request)
	if f.runErr != nil {
		return nil, f.runErr
	}
	if f.process == nil {
		f.process = &fakeManagedProcess{}
	}
	return f.process, nil
}

func (f *fakeProcessExecutor) probe(_ context.Context, engine engine) error {
	f.requests = append(f.requests, processRequest{kind: processProbe, engine: engine})
	return f.probeErr
}

func (f *fakeProcessExecutor) kinds() []string {
	result := make([]string, 0, len(f.requests))
	for _, request := range f.requests {
		result = append(result, request.kind.String())
	}
	return result
}

type fakeManagedProcess struct{ stopCalls, waitCalls int }

func (f *fakeManagedProcess) stop() error { f.stopCalls++; return nil }
func (f *fakeManagedProcess) wait() error { f.waitCalls++; return nil }

type fakeDialer struct {
	target    *fakeCache
	source    *fakeCache
	sourceErr error
}

func (f *fakeDialer) dialTarget(context.Context, config, []byte) (cacheClient, error) {
	return f.target, nil
}

func (f *fakeDialer) dialSource(context.Context, string, uint16) (cacheClient, error) {
	if f.sourceErr != nil {
		return nil, f.sourceErr
	}
	if f.source != nil && f.source.migrateTarget == nil {
		f.source.migrateTarget = f.target
	}
	return f.source, nil
}

type scanPage struct {
	next string
	keys [][]byte
}

type fakeCache struct {
	values                   map[string]keySnapshot
	lastSaves                []int64
	scanPages                []scanPage
	migrateTarget            *fakeCache
	migrateErr               error
	migrateWritesBeforeError bool
	bgSaveCalls              int
	lastSaveCalls            int
	migrateCalls             int
	setCalls                 int
	getCalls                 int
	deleteCalls              int
	closeCalls               int
	databaseIndexesValue     []uint16
	usedMemoryValue          int64
	readyErr                 error
	versionValue             string
}

func newFakeCache(values map[string]keySnapshot) *fakeCache {
	if values == nil {
		values = map[string]keySnapshot{}
	}
	return &fakeCache{values: values}
}

func (f *fakeCache) ping(context.Context) error { return nil }
func (f *fakeCache) close() error               { f.closeCalls++; return nil }
func (f *fakeCache) bgSave(context.Context) error {
	f.bgSaveCalls++
	return nil
}
func (f *fakeCache) lastSave(context.Context) (int64, error) {
	f.lastSaveCalls++
	if len(f.lastSaves) == 0 {
		return int64(f.lastSaveCalls), nil
	}
	index := min(f.lastSaveCalls-1, len(f.lastSaves)-1)
	return f.lastSaves[index], nil
}
func (f *fakeCache) dbSize(context.Context) (int64, error) { return int64(len(f.values)), nil }
func (f *fakeCache) usedMemory(context.Context) (int64, error) {
	return f.usedMemoryValue, nil
}
func (f *fakeCache) ready(context.Context) error { return f.readyErr }
func (f *fakeCache) databaseIndexes(context.Context) ([]uint16, error) {
	if f.databaseIndexesValue != nil {
		return slices.Clone(f.databaseIndexesValue), nil
	}
	if len(f.values) == 0 {
		return nil, nil
	}
	return []uint16{0}, nil
}
func (f *fakeCache) version(context.Context, engine) (string, error) {
	if f.versionValue != "" {
		return f.versionValue, nil
	}
	return "7.4.1", nil
}
func (f *fakeCache) set(_ context.Context, key, value []byte, ttl time.Duration, nx bool) error {
	f.setCalls++
	if nx {
		if _, exists := f.values[string(key)]; exists {
			return errors.New("exists")
		}
	}
	f.values[string(key)] = keySnapshot{kind: "string", dump: slices.Clone(value), pttl: ttl.Milliseconds()}
	return nil
}
func (f *fakeCache) get(_ context.Context, key []byte) ([]byte, error) {
	f.getCalls++
	value, exists := f.values[string(key)]
	if !exists {
		return nil, ErrMissingKey
	}
	return slices.Clone(value.dump), nil
}
func (f *fakeCache) scan(_ context.Context, cursor string, _ int) (string, [][]byte, error) {
	if len(f.scanPages) == 0 {
		keys := make([][]byte, 0, len(f.values))
		for key := range f.values {
			keys = append(keys, []byte(key))
		}
		return "0", keys, nil
	}
	page := f.scanPages[0]
	f.scanPages = f.scanPages[1:]
	return page.next, page.keys, nil
}
func (f *fakeCache) migrate(_ context.Context, _ config, _ []byte, keys [][]byte, _ time.Duration) error {
	f.migrateCalls++
	if f.migrateErr == nil || f.migrateWritesBeforeError {
		for _, key := range keys {
			f.migrateTarget.values[string(key)] = f.values[string(key)]
		}
	}
	return f.migrateErr
}
func (f *fakeCache) snapshot(_ context.Context, key []byte) (keySnapshot, error) {
	value, exists := f.values[string(key)]
	if !exists {
		return keySnapshot{pttl: -2}, ErrMissingKey
	}
	return value, nil
}
func (f *fakeCache) delete(_ context.Context, key []byte) error {
	f.deleteCalls++
	delete(f.values, string(key))
	return nil
}
func (f *fakeCache) hasSentinel() bool {
	for key := range f.values {
		if len(key) >= len(sentinelPrefix) && key[:len(sentinelPrefix)] == sentinelPrefix {
			return true
		}
	}
	return false
}

type immediateWaiter struct{}

func (immediateWaiter) wait(context.Context, time.Duration) error { return nil }

type errorWaiter struct{ err error }

func (w errorWaiter) wait(context.Context, time.Duration) error { return w.err }

type fakeArtifactCodec struct{ metadata artifactMetadata }

func (fakeArtifactCodec) encode(_ context.Context, _ artifactMetadata, input io.Reader, output io.Writer, max int64) (artifactTransfer, error) {
	if _, err := output.Write([]byte("RAIBIT-TEST-WIRE:")); err != nil {
		return artifactTransfer{}, err
	}
	payload, err := io.ReadAll(io.LimitReader(input, max+1))
	if err != nil {
		return artifactTransfer{}, err
	}
	if int64(len(payload)) > max {
		return artifactTransfer{}, ErrLimit
	}
	if _, err := output.Write(payload); err != nil {
		return artifactTransfer{}, err
	}
	return artifactTransfer{decodedBytes: uint64(len(payload)), decodedSHA: sha256.Sum256(payload)}, nil
}

func (f fakeArtifactCodec) decode(_ context.Context, engine engine, input io.Reader, output io.Writer, max int64) (artifactMetadata, artifactTransfer, error) {
	value, err := io.ReadAll(io.LimitReader(input, max+64))
	if err != nil || !bytes.HasPrefix(value, []byte("RAIBIT-TEST-WIRE:")) {
		return artifactMetadata{}, artifactTransfer{}, ErrOperation
	}
	payload := bytes.TrimPrefix(value, []byte("RAIBIT-TEST-WIRE:"))
	if int64(len(payload)) > max {
		return artifactMetadata{}, artifactTransfer{}, ErrLimit
	}
	if _, err := output.Write(payload); err != nil {
		return artifactMetadata{}, artifactTransfer{}, err
	}
	metadata := f.metadata
	metadata.engine = engine
	if metadata.sourceVersion == "" {
		metadata.sourceVersion = "7.4.1"
	}
	return metadata, artifactTransfer{decodedBytes: uint64(len(payload)), decodedSHA: sha256.Sum256(payload)}, nil
}

func testCodec(source *fakeCache, engine engine) fakeArtifactCodec {
	return fakeArtifactCodec{metadata: testMetadata(source, engine)}
}

func testMetadata(source *fakeCache, engine engine) artifactMetadata {
	keys := make([][]byte, 0, len(source.values))
	for key := range source.values {
		keys = append(keys, []byte(key))
	}
	count, digest, err := datasetSummary(context.Background(), source, keys)
	if err != nil {
		panic(err)
	}
	return artifactMetadata{engine: engine, sourceVersion: "7.4.1", keyCount: count, datasetSHA256: digest}
}
