package backup

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
)

func Test_StreamHandoff_when_dump_exceeds_ceiling_during_Run(t *testing.T) {
	// Given: a four-byte dump ceiling and a runner producing five bytes.
	output := &countingWriteCloser{}
	handoff, err := NewDumpHandoff(context.Background(), output, 4)
	if err != nil {
		t.Fatal(err)
	}
	job, err := NewIsolatedJob(testJobSpec(t, testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4"), StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	// When: the runner crosses the ceiling while writing.
	_, err = handoff.Execute(context.Background(), job, writeRunner{payload: "12345"})
	// Then: Run fails at the write boundary and only four bytes reach storage.
	if !errors.Is(err, ErrLimit) || output.String() != "1234" || output.closes.Load() != 1 {
		t.Fatalf("err=%v output=%q closes=%d", err, output.String(), output.closes.Load())
	}
}

func Test_StreamHandoff_when_restore_exceeds_ceiling_during_Run(t *testing.T) {
	// Given: five source bytes and a four-byte restore ceiling.
	input := &countingReadCloser{Reader: bytes.NewReader([]byte("12345"))}
	handoff, err := NewRestoreHandoff(context.Background(), input, 4)
	if err != nil {
		t.Fatal(err)
	}
	job, err := NewIsolatedJob(testJobSpec(t, testNetworkConnection(t, "target", "target.db.internal", "target-secret", "DATABASE_URL", "16.4"), StreamStdin))
	if err != nil {
		t.Fatal(err)
	}
	// When: a concrete runner consumes the restore stream.
	_, err = handoff.Execute(context.Background(), job, readRunner{})
	// Then: the fifth byte is detected during the read and the source closes once.
	if !errors.Is(err, ErrLimit) || input.closes.Load() != 1 {
		t.Fatalf("err=%v closes=%d", err, input.closes.Load())
	}
}

func Test_StreamHandoff_when_aborted_before_Run_or_closed_twice(t *testing.T) {
	// Given: a stream whose adapter fails before handing off a job.
	output := &countingWriteCloser{}
	handoff, err := NewDumpHandoff(context.Background(), output, 4)
	if err != nil {
		t.Fatal(err)
	}
	// When: the owner aborts twice.
	first, second := handoff.Abort(), handoff.Abort()
	// Then: underlying ownership is released exactly once.
	if first != nil || second != nil || output.closes.Load() != 1 {
		t.Fatalf("errs=%v/%v closes=%d", first, second, output.closes.Load())
	}
}

func Test_StreamHandoff_when_cancelled_concurrently(t *testing.T) {
	// Given: a runner blocked reading and multiple concurrent cancellation/close paths.
	ctx, cancel := context.WithCancel(context.Background())
	input := newBlockingReadCloser()
	handoff, err := NewRestoreHandoff(ctx, input, 8)
	if err != nil {
		t.Fatal(err)
	}
	job, err := NewIsolatedJob(testJobSpec(t, testNetworkConnection(t, "target", "target.db.internal", "target-secret", "DATABASE_URL", "16.4"), StreamStdin))
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { _, runErr := handoff.Execute(ctx, job, readRunner{}); finished <- runErr }()
	<-input.started
	// When: cancellation races with redundant aborts.
	cancel()
	var group sync.WaitGroup
	for range 4 {
		group.Add(1)
		go func() { defer group.Done(); _ = handoff.Abort() }()
	}
	group.Wait()
	runErr := <-finished
	// Then: cancellation unblocks Run and closes the source exactly once.
	if !errors.Is(runErr, context.Canceled) && !errors.Is(runErr, io.ErrClosedPipe) {
		t.Fatalf("err=%v", runErr)
	}
	if input.closes.Load() != 1 {
		t.Fatalf("closes=%d", input.closes.Load())
	}
}

func Test_StreamHandoff_when_cancelled_unblocks_dump_writer(t *testing.T) {
	// Given: a dump runner blocked in the destination writer.
	ctx, cancel := context.WithCancel(context.Background())
	output := newBlockingWriteCloser()
	handoff, err := NewDumpHandoff(ctx, output, 8)
	if err != nil {
		t.Fatal(err)
	}
	job, err := NewIsolatedJob(testJobSpec(t, testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4"), StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { _, runErr := handoff.Execute(ctx, job, writeRunner{payload: "data"}); finished <- runErr }()
	<-output.started
	// When: the job context is cancelled.
	cancel()
	runErr := <-finished
	// Then: closing the owned destination releases the blocked write exactly once.
	if !errors.Is(runErr, context.Canceled) || output.closes.Load() != 1 {
		t.Fatalf("err=%v closes=%d", runErr, output.closes.Load())
	}
}

type readRunner struct{}

func (readRunner) Run(_ context.Context, _ IsolatedJob, stream JobStream) (JobExecution, error) {
	_, err := io.Copy(io.Discard, stream.Input())
	if err != nil {
		return JobExecution{}, err
	}
	return NewJobExecution("job-1")
}

type countingWriteCloser struct {
	bytes.Buffer
	closes atomic.Int32
}

func (w *countingWriteCloser) Close() error { w.closes.Add(1); return nil }

type countingReadCloser struct {
	*bytes.Reader
	closes atomic.Int32
}

func (r *countingReadCloser) Close() error { r.closes.Add(1); return nil }

type blockingReadCloser struct {
	started chan struct{}
	closed  chan struct{}
	once    sync.Once
	closes  atomic.Int32
}

type blockingWriteCloser struct {
	started chan struct{}
	closed  chan struct{}
	once    sync.Once
	closes  atomic.Int32
}

func newBlockingWriteCloser() *blockingWriteCloser {
	return &blockingWriteCloser{started: make(chan struct{}), closed: make(chan struct{})}
}

func (w *blockingWriteCloser) Write([]byte) (int, error) {
	w.once.Do(func() { close(w.started) })
	<-w.closed
	return 0, context.Canceled
}

func (w *blockingWriteCloser) Close() error {
	if w.closes.Add(1) == 1 {
		close(w.closed)
	}
	return nil
}

func newBlockingReadCloser() *blockingReadCloser {
	return &blockingReadCloser{started: make(chan struct{}), closed: make(chan struct{})}
}

func (r *blockingReadCloser) Read([]byte) (int, error) {
	r.once.Do(func() { close(r.started) })
	<-r.closed
	return 0, context.Canceled
}

func (r *blockingReadCloser) Close() error {
	if r.closes.Add(1) == 1 {
		close(r.closed)
	}
	return nil
}
