package backup

import (
	"context"
	"crypto/sha256"
	"errors"
	"hash"
	"io"
	"sync"
)

// ownedCloser joins a cancellation-triggered Close before returning. Sources and
// sinks must support concurrent Close that unblocks any pending Read/Write.
type ownedCloser struct {
	once  sync.Once
	close func() error
	err   error
	stop  func() bool
}

func own(ctx context.Context, c io.Closer) *ownedCloser {
	o := &ownedCloser{close: c.Close}
	o.stop = context.AfterFunc(ctx, func() { o.once.Do(func() { o.err = o.close() }) })
	return o
}

func (o *ownedCloser) finish() error {
	o.stop()
	o.once.Do(func() { o.err = o.close() })
	return safeError(o.err)
}

func safeError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, context.Canceled):
		return context.Canceled
	case errors.Is(err, context.DeadlineExceeded):
		return context.DeadlineExceeded
	case errors.Is(err, ErrLimit):
		return ErrLimit
	case errors.Is(err, ErrFence):
		return ErrFence
	case errors.Is(err, io.ErrShortWrite):
		return io.ErrShortWrite
	default:
		return ErrBackend
	}
}

type measuredWriter struct {
	ctx  context.Context
	dst  io.Writer
	hash hash.Hash
	size int64
	max  int64
}

func (w *measuredWriter) Write(p []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	if int64(len(p)) > w.max-w.size {
		return 0, ErrLimit
	}
	n, err := w.dst.Write(p)
	if n < 0 || n > len(p) {
		return 0, io.ErrShortWrite
	}
	w.size += int64(n)
	if w.hash != nil {
		if _, hashErr := w.hash.Write(p[:n]); hashErr != nil {
			return n, ErrIntegrity
		}
	}
	if err == nil && n != len(p) {
		return n, io.ErrShortWrite
	}
	return n, err
}

type measuredReader struct {
	ctx  context.Context
	src  io.Reader
	hash hash.Hash
	size int64
	max  int64
}

func (r *measuredReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	remaining := r.max - r.size
	if int64(len(p)) > remaining+1 {
		p = p[:remaining+1]
	}
	n, err := r.src.Read(p)
	if n < 0 || n > len(p) {
		return 0, ErrIntegrity
	}
	r.size += int64(n)
	if r.size > r.max {
		return 0, ErrLimit
	}
	if r.hash != nil {
		if _, hashErr := r.hash.Write(p[:n]); hashErr != nil {
			return 0, ErrIntegrity
		}
	}
	return n, err
}

func digest(h hash.Hash) [32]byte { return [32]byte(h.Sum(nil)) }
func newMeasuredWriter(ctx context.Context, dst io.Writer, max int64) *measuredWriter {
	return &measuredWriter{ctx: ctx, dst: dst, hash: sha256.New(), max: max}
}
