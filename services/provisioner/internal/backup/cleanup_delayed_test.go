package backup

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type delayedWrite struct {
	operation string
	started   chan struct{}
	release   chan struct{}
	finished  chan struct{}
	once      sync.Once
}

func (w *wireStore) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	d := w.delay
	if d == nil || request.Method != "POST" || !request.URL.Query().Has(d.operation) {
		w.serve(response, request)
		return
	}
	// The server accepted the request; client disconnect cannot retract it.
	body, err := io.ReadAll(io.LimitReader(request.Body, 128<<10))
	if err != nil {
		w.t.Error(err)
		return
	}
	request.Body = io.NopCloser(bytes.NewReader(body))
	close(d.started)
	<-d.release
	w.serve(httptest.NewRecorder(), request)
	close(d.finished)
}

func Test_Cleanup_when_remote_write_follows_client_cancellation(t *testing.T) {
	for _, operation := range []string{"uploads", "uploadId"} {
		t.Run(operation, func(t *testing.T) {
			// Given: the real signed TLS SDK request is accepted but not committed.
			s, w, j, a := fixture(t, "", Options{})
			d := &delayedWrite{operation: operation, started: make(chan struct{}), release: make(chan struct{}), finished: make(chan struct{})}
			w.delay = d
			t.Cleanup(func() { d.once.Do(func() { close(d.release) }) })
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			exited := make(chan error, 1)
			go func() {
				_, err := s.Upload(ctx, UploadRequest{Attempt: a, Source: io.NopCloser(strings.NewReader("late artifact"))}, j)
				exited <- err
			}()
			awaitSignal(t, d.started)
			cancel()
			select {
			case err := <-exited:
				if !errors.Is(ctx.Err(), context.Canceled) || !errors.Is(err, ErrCleanupPending) {
					t.Fatalf("upload did not exit pending on cancellation: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("SDK did not return on cancellation")
			}
			// When: cleanup runs after the worker exits, before remote commit.
			req := CleanupRequest{Attempt: a}
			if operation == "uploadId" {
				req.UploadID = "upload-1"
				req.Remote = PreparedRemoteWrite{Candidate: j.candidate}
			}
			result, err := s.Cleanup(context.Background(), req, j)
			d.once.Do(func() { close(d.release) })
			awaitSignal(t, d.finished)
			// Then: the accepted remote operation materializes; no absence authority.
			w.mu.Lock()
			materialized := w.uploadActive || w.object != nil
			w.mu.Unlock()
			t.Logf("client_exited=true remote_materialized=%t multipart_absent=%t object_absent=%t", materialized, result.MultipartAbsent, result.ObjectAbsent)
			if !materialized || !errors.Is(err, ErrCleanupPending) || result.MultipartAbsent || result.ObjectAbsent {
				t.Fatalf("delayed remote write falsely finalized: result=%+v err=%v", result, err)
			}
			// A later retry resolves the positive Complete witness, not a timeout.
			if operation == "uploadId" {
				result, err = s.Cleanup(context.Background(), req, j)
				if err != nil || !result.MultipartAbsent || !result.ObjectAbsent || j.complete.Record() != j.candidate.Record() {
					t.Fatalf("late completion did not reconcile durably: %v", err)
				}
				t.Log("late_complete_readback=true completion_persisted=true cleanup_final=true")
			}
		})
	}
}

func awaitSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal("controlled wire event did not arrive")
	}
}
