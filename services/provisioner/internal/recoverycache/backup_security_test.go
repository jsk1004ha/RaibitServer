package recoverycache

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
)

func Test_Backup_rejects_RDB_containing_a_nonselected_database(t *testing.T) {
	// Given
	remote := newFakeCache(nil)
	remote.lastSaves = []int64{10, 11}
	captured := newFakeCache(nil)
	captured.databaseIndexesValue = []uint16{0, 1}
	helper := newHelper(testConfig(t.TempDir()), dependencies{
		processes: &fakeProcessExecutor{rdb: []byte("REDIS0011payload")},
		dialer:    &fakeDialer{target: remote, source: captured},
		codec:     fakeArtifactCodec{},
		waiter:    immediateWaiter{},
		random:    bytes.NewReader(bytes.Repeat([]byte{0x41}, 32)),
	})

	// When
	err := helper.run(context.Background(), "redis-backup", bytes.NewReader(nil), io.Discard)

	// Then
	if !errors.Is(err, ErrOperation) {
		t.Fatalf("error = %v, want ErrOperation", err)
	}
}
