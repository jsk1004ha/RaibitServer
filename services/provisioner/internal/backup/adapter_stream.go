package backup

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"

	"github.com/raibitserver/provisioner/internal/recoveryreceipt"
)

type streamDirection uint8

const (
	dumpDirection streamDirection = iota + 1
	restoreDirection
)

type streamState struct {
	input     io.ReadCloser
	output    io.WriteCloser
	max       int64
	bytes     atomic.Int64
	ioMu      sync.Mutex
	endpoint  sync.Once
	closeOnce sync.Once
	closeErr  error
}

func (s *streamState) close() error {
	s.closeOnce.Do(func() {
		var errs []error
		if s.input != nil {
			errs = append(errs, s.input.Close())
		}
		if s.output != nil {
			errs = append(errs, s.output.Close())
		}
		s.closeErr = errors.Join(errs...)
	})
	return s.closeErr
}

type boundedInput struct{ state *streamState }

func (r boundedInput) Read(buffer []byte) (int, error) {
	r.state.ioMu.Lock()
	defer r.state.ioMu.Unlock()
	used := r.state.bytes.Load()
	if used >= r.state.max {
		var probe [1]byte
		n, err := r.state.input.Read(probe[:])
		if n > 0 {
			return 0, ErrLimit
		}
		return 0, err
	}
	remaining := r.state.max - used
	if int64(len(buffer)) > remaining {
		buffer = buffer[:remaining]
	}
	n, err := r.state.input.Read(buffer)
	r.state.bytes.Add(int64(n))
	return n, err
}

func (r boundedInput) Close() error { return r.state.close() }

type boundedOutput struct{ state *streamState }

func (w boundedOutput) Write(buffer []byte) (int, error) {
	w.state.ioMu.Lock()
	defer w.state.ioMu.Unlock()
	used := w.state.bytes.Load()
	remaining := w.state.max - used
	if remaining <= 0 {
		return 0, ErrLimit
	}
	overflow := int64(len(buffer)) > remaining
	if overflow {
		buffer = buffer[:remaining]
	}
	n, err := w.state.output.Write(buffer)
	w.state.bytes.Add(int64(n))
	if err == nil && overflow {
		err = ErrLimit
	}
	return n, err
}

func (w boundedOutput) Close() error { return w.state.close() }

type JobStream struct {
	state     *streamState
	direction streamDirection
}

func (s JobStream) Input() io.ReadCloser {
	if s.direction != restoreDirection || !s.acquireEndpoint() {
		return nil
	}
	return boundedInput{state: s.state}
}

func (s JobStream) Output() io.WriteCloser {
	if s.direction != dumpDirection || !s.acquireEndpoint() {
		return nil
	}
	return boundedOutput{state: s.state}
}

func (s JobStream) acquireEndpoint() bool {
	acquired := false
	s.state.endpoint.Do(func() { acquired = true })
	return acquired
}

func (s JobStream) Close() error { return s.state.close() }
func (s JobStream) Bytes() int64 { return s.state.bytes.Load() }

// StreamHandoff owns a stream until Execute succeeds in handing it to a runner.
// Adapters defer Abort before building jobs, covering every failure-before-run path.
type StreamHandoff struct {
	stream         JobStream
	constructorCtx context.Context
	mu             sync.Mutex
	used           bool
}

func NewDumpHandoff(ctx context.Context, output io.WriteCloser, maxBytes int64) (*StreamHandoff, error) {
	if ctx == nil || output == nil || maxBytes < 1 || maxBytes > MaxStoredBytes {
		return nil, ErrRecoveryStream
	}
	return newStreamHandoff(ctx, nil, output, maxBytes, dumpDirection), nil
}

func NewRestoreHandoff(ctx context.Context, input io.ReadCloser, maxBytes int64) (*StreamHandoff, error) {
	if ctx == nil || input == nil || maxBytes < 1 || maxBytes > MaxStoredBytes {
		return nil, ErrRecoveryStream
	}
	return newStreamHandoff(ctx, input, nil, maxBytes, restoreDirection), nil
}

func newStreamHandoff(ctx context.Context, input io.ReadCloser, output io.WriteCloser, maxBytes int64, direction streamDirection) *StreamHandoff {
	state := &streamState{input: input, output: output, max: maxBytes}
	return &StreamHandoff{stream: JobStream{state: state, direction: direction}, constructorCtx: ctx}
}

func (h *StreamHandoff) Abort() error {
	h.mu.Lock()
	if h.used {
		h.mu.Unlock()
		return nil
	}
	h.used = true
	h.mu.Unlock()
	return h.stream.Close()
}

func (h *StreamHandoff) Execute(ctx context.Context, job IsolatedJob, runner JobRunner) (receipt JobReceipt, resultErr error) {
	if ctx == nil || runner == nil || !bindingMatches(job, h.stream.direction) {
		_ = h.Abort()
		return JobReceipt{}, ErrRecoveryStream
	}
	if !h.claim() {
		return JobReceipt{}, ErrRecoveryStream
	}
	stopConstructor := context.AfterFunc(h.constructorCtx, func() { _ = h.stream.Close() })
	stopExecution := context.AfterFunc(ctx, func() { _ = h.stream.Close() })
	defer func() {
		stopExecution()
		stopConstructor()
		resultErr = errors.Join(resultErr, h.stream.Close())
	}()
	execution, err := runner.Run(ctx, job, h.stream)
	if err != nil {
		return JobReceipt{}, err
	}
	if err := errors.Join(ctx.Err(), h.constructorCtx.Err()); err != nil {
		return JobReceipt{}, err
	}
	return newJobReceipt(execution, h.stream.Bytes(), job, h.stream.direction)
}

func (h *StreamHandoff) claim() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.used {
		return false
	}
	h.used = true
	return true
}

func bindingMatches(job IsolatedJob, direction streamDirection) bool {
	wanted := StreamStdout
	if direction == restoreDirection {
		wanted = StreamStdin
	}
	for _, step := range job.spec.Steps {
		if step.binding == wanted {
			return true
		}
	}
	return false
}

type JobReceipt struct {
	name, uid  string
	bytes      int64
	resourceID string
	fence      FenceIdentity
	direction  streamDirection
	tool       recoveryreceipt.Receipt
	toolValid  bool
}

func newJobReceipt(observed completedJobObservation, streamedBytes int64, job IsolatedJob, direction streamDirection) (JobReceipt, error) {
	if !recoveryPart.MatchString(observed.name) || !providerUIDPattern.MatchString(observed.uid) || observed.specIdentity != isolatedJobIdentity(job) || streamedBytes < 0 || streamedBytes > MaxStoredBytes || job.spec.Connection.spec.ResourceID == "" || job.fence.attempt < 1 || direction < dumpDirection || direction > restoreDirection {
		return JobReceipt{}, ErrRecoveryJob
	}
	engine, action, toolDirection, helper := expectedHelperReceipt(job)
	if helper {
		directionMatches := direction == dumpDirection && toolDirection == recoveryreceipt.DirectionDump || direction == restoreDirection && toolDirection == recoveryreceipt.DirectionRestore
		if !directionMatches || !observed.receiptPresent || observed.receipt.ValidateFor(engine, action, toolDirection) != nil {
			return JobReceipt{}, ErrRecoveryJob
		}
	}
	return JobReceipt{name: observed.name, uid: observed.uid, bytes: streamedBytes, resourceID: job.spec.Connection.ResourceID(), fence: job.fence, direction: direction, tool: observed.receipt, toolValid: observed.receiptPresent}, nil
}

func (r JobReceipt) Name() string { return r.name }
func (r JobReceipt) UID() string  { return r.uid }
func (r JobReceipt) Bytes() int64 { return r.bytes }
func (r JobReceipt) RecoveryReceipt() (recoveryreceipt.Receipt, bool) {
	return r.tool, r.toolValid
}

type JobRunner interface {
	Run(context.Context, IsolatedJob, JobStream) (completedJobObservation, error)
}
