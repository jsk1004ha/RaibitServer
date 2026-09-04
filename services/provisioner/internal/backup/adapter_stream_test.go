package backup

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"
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

func Test_StreamHandoff_when_second_Execute_loses_active_ownership(t *testing.T) {
	// Given: the first runner owns a restore stream and is blocked in its read.
	constructorCtx, stopConstructor := context.WithCancel(context.Background())
	defer stopConstructor()
	executeCtx, stopExecute := context.WithCancel(context.Background())
	input := newBlockingReadCloser()
	handoff, err := NewRestoreHandoff(constructorCtx, input, 8)
	if err != nil {
		t.Fatal(err)
	}
	job, err := NewIsolatedJob(testJobSpec(t, testNetworkConnection(t, "target", "target.db.internal", "target-secret", "DATABASE_URL", "16.4"), StreamStdin))
	if err != nil {
		t.Fatal(err)
	}
	firstDone := make(chan error, 1)
	go func() { _, runErr := handoff.Execute(executeCtx, job, readRunner{}); firstDone <- runErr }()
	<-input.started
	// When: a second Execute loses the already-transferred ownership race.
	_, secondErr := handoff.Execute(context.Background(), job, readRunner{})
	// Then: the loser fails without closing or completing the active runner.
	if !errors.Is(secondErr, ErrRecoveryStream) || input.closes.Load() != 0 {
		t.Fatalf("secondErr=%v closes=%d", secondErr, input.closes.Load())
	}
	select {
	case firstErr := <-firstDone:
		t.Fatalf("first runner was interrupted: %v", firstErr)
	default:
	}
	stopExecute()
	if firstErr := <-firstDone; !errors.Is(firstErr, context.Canceled) {
		t.Fatalf("firstErr=%v", firstErr)
	}
	if input.closes.Load() != 1 {
		t.Fatalf("closes=%d", input.closes.Load())
	}
}

func Test_StreamHandoff_when_only_Execute_context_is_cancelled(t *testing.T) {
	// Given: a live constructor context and a distinct execution context blocked on read.
	constructorCtx, stopConstructor := context.WithCancel(context.Background())
	defer stopConstructor()
	executeCtx, stopExecute := context.WithCancel(context.Background())
	input := newBlockingReadCloser()
	handoff, err := NewRestoreHandoff(constructorCtx, input, 8)
	if err != nil {
		t.Fatal(err)
	}
	job, err := NewIsolatedJob(testJobSpec(t, testNetworkConnection(t, "target", "target.db.internal", "target-secret", "DATABASE_URL", "16.4"), StreamStdin))
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { _, runErr := handoff.Execute(executeCtx, job, readRunner{}); finished <- runErr }()
	<-input.started
	// When: only the Execute context is cancelled.
	stopExecute()
	// Then: execution cancellation closes the stream and unblocks the runner exactly once.
	select {
	case runErr := <-finished:
		if !errors.Is(runErr, context.Canceled) || input.closes.Load() != 1 {
			t.Fatalf("err=%v closes=%d", runErr, input.closes.Load())
		}
	case <-time.After(time.Second):
		stopConstructor()
		<-finished
		t.Fatal("Execute context cancellation did not unblock the reader")
	}
}

func Test_JobStream_when_endpoint_is_acquired_concurrently(t *testing.T) {
	// Given: one restore stream exposed to two simultaneous endpoint requests.
	input := &countingReadCloser{Reader: bytes.NewReader([]byte("data"))}
	handoff, err := NewRestoreHandoff(context.Background(), input, 4)
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan io.ReadCloser, 2)
	for range 2 {
		go func() {
			<-start
			results <- handoff.stream.Input()
		}()
	}
	// When: both callers race to acquire the input capability.
	close(start)
	first, second := <-results, <-results
	// Then: exactly one caller receives the single-consumer endpoint.
	acquired := 0
	for _, reader := range []io.ReadCloser{first, second} {
		if reader != nil {
			acquired++
		}
	}
	if acquired != 1 {
		t.Fatalf("acquired=%d", acquired)
	}
	if err := handoff.Abort(); err != nil {
		t.Fatal(err)
	}
}

func Test_JobStream_when_shared_output_writes_concurrently(t *testing.T) {
	// Given: one acquired output shared by two writers against a four-byte ceiling.
	output := &countingWriteCloser{}
	handoff, err := NewDumpHandoff(context.Background(), output, 4)
	if err != nil {
		t.Fatal(err)
	}
	writer := handoff.stream.Output()
	start := make(chan struct{})
	results := make(chan int, 2)
	for _, value := range []string{"aaaa", "bbbb"} {
		go func() {
			<-start
			n, _ := writer.Write([]byte(value))
			results <- n
		}()
	}
	// When: both writes start concurrently.
	close(start)
	total := <-results + <-results
	// Then: reservations and underlying output remain bounded to four bytes.
	if total != 4 || output.Len() != 4 || handoff.stream.Bytes() != 4 {
		t.Fatalf("total=%d output=%d measured=%d", total, output.Len(), handoff.stream.Bytes())
	}
	_ = handoff.Abort()
}

func Test_JobStream_when_shared_input_reads_concurrently(t *testing.T) {
	// Given: one acquired input shared by two readers at its exact four-byte ceiling.
	input := &countingReadCloser{Reader: bytes.NewReader([]byte("data"))}
	handoff, err := NewRestoreHandoff(context.Background(), input, 4)
	if err != nil {
		t.Fatal(err)
	}
	reader := handoff.stream.Input()
	start := make(chan struct{})
	results := make(chan int, 2)
	for range 2 {
		go func() {
			<-start
			buffer := make([]byte, 4)
			n, _ := reader.Read(buffer)
			results <- n
		}()
	}
	// When: both reads start concurrently.
	close(start)
	total := <-results + <-results
	// Then: the shared reader consumes exactly the ceiling without racing past it.
	if total != 4 || handoff.stream.Bytes() != 4 {
		t.Fatalf("total=%d measured=%d", total, handoff.stream.Bytes())
	}
	_ = handoff.Abort()
}

type readRunner struct{}

func (readRunner) Run(_ context.Context, job IsolatedJob, stream JobStream) (completedJobObservation, error) {
	_, err := io.Copy(io.Discard, stream.Input())
	if err != nil {
		return completedJobObservation{}, err
	}
	return testCompletedJob(job, "job-1"), nil
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
