package backup

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
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
	done      chan struct{}
	closeOnce sync.Once
	closeErr  error
}

func (s *streamState) close() error {
	s.closeOnce.Do(func() {
		close(s.done)
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
	if s.direction != restoreDirection {
		return nil
	}
	return boundedInput{state: s.state}
}

func (s JobStream) Output() io.WriteCloser {
	if s.direction != dumpDirection {
		return nil
	}
	return boundedOutput{state: s.state}
}

func (s JobStream) Close() error { return s.state.close() }
func (s JobStream) Bytes() int64 { return s.state.bytes.Load() }

// StreamHandoff owns a stream until Execute succeeds in handing it to a runner.
// Adapters defer Abort before building jobs, covering every failure-before-run path.
type StreamHandoff struct {
	stream JobStream
	mu     sync.Mutex
	used   bool
}

func NewDumpHandoff(ctx context.Context, output io.WriteCloser, maxBytes int64) (*StreamHandoff, error) {
	if output == nil || maxBytes < 1 || maxBytes > MaxStoredBytes {
		return nil, ErrRecoveryStream
	}
	return newStreamHandoff(ctx, nil, output, maxBytes, dumpDirection), nil
}

func NewRestoreHandoff(ctx context.Context, input io.ReadCloser, maxBytes int64) (*StreamHandoff, error) {
	if input == nil || maxBytes < 1 || maxBytes > MaxStoredBytes {
		return nil, ErrRecoveryStream
	}
	return newStreamHandoff(ctx, input, nil, maxBytes, restoreDirection), nil
}

func newStreamHandoff(ctx context.Context, input io.ReadCloser, output io.WriteCloser, maxBytes int64, direction streamDirection) *StreamHandoff {
	state := &streamState{input: input, output: output, max: maxBytes, done: make(chan struct{})}
	handoff := &StreamHandoff{stream: JobStream{state: state, direction: direction}}
	go func() {
		select {
		case <-ctx.Done():
			_ = state.close()
		case <-state.done:
		}
	}()
	return handoff
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
	if runner == nil || !h.claim() || !bindingMatches(job, h.stream.direction) {
		_ = h.stream.Close()
		return JobReceipt{}, ErrRecoveryStream
	}
	defer func() { resultErr = errors.Join(resultErr, h.stream.Close()) }()
	execution, err := runner.Run(ctx, job, h.stream)
	if err != nil {
		return JobReceipt{}, err
	}
	return newJobReceipt(execution.name, h.stream.Bytes())
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

type JobExecution struct{ name string }

func NewJobExecution(name string) (JobExecution, error) {
	if !recoveryPart.MatchString(name) {
		return JobExecution{}, ErrRecoveryJob
	}
	return JobExecution{name: name}, nil
}

func (e JobExecution) Name() string { return e.name }

type JobReceipt struct {
	name  string
	bytes int64
}

func newJobReceipt(name string, streamedBytes int64) (JobReceipt, error) {
	if !recoveryPart.MatchString(name) || streamedBytes < 0 || streamedBytes > MaxStoredBytes {
		return JobReceipt{}, ErrRecoveryJob
	}
	return JobReceipt{name: name, bytes: streamedBytes}, nil
}

func (r JobReceipt) Name() string { return r.name }
func (r JobReceipt) Bytes() int64 { return r.bytes }

type JobRunner interface {
	Run(context.Context, IsolatedJob, JobStream) (JobExecution, error)
}
