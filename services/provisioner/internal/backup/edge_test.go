package backup

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func Test_StoredBound_when_final_tag_crosses_limit(t *testing.T) {
	for _, delta := range []int64{0, -1} {
		// Given: exact empty envelope = wrapper + Tink header40 + final tag16.
		s, _, j, a := fixture(t, "", Options{})
		aad, err := header(a)
		if err != nil {
			t.Fatal(err)
		}
		s.maxStored = int64(len(aad)+40+16) + delta
		// When: even an empty archive emits authenticated final ciphertext.
		_, err = s.Upload(context.Background(), UploadRequest{Attempt: a, Source: io.NopCloser(strings.NewReader(""))}, j)
		// Then: final tag counts toward the stored bound.
		if delta == 0 && err != nil || delta < 0 && !errors.Is(err, ErrLimit) {
			t.Fatalf("final-tag bound mismatch: %v", err)
		}
	}
}

func Test_StaleAttempt_when_repeated_creation(t *testing.T) {
	// Given: the current durable attempt already uploaded a winning object.
	s, w, j, a := fixture(t, "", Options{})
	c := uploadFixture(t, s, j, a, 12)
	before := len(w.eventSnapshot())
	// When: the same attempt tries to recreate its multipart upload.
	_, err := s.Upload(context.Background(), UploadRequest{Attempt: a, Source: io.NopCloser(strings.NewReader("replacement"))}, j)
	// Then: durable intent rejects before I/O and keeps the winning descriptor.
	if !errors.Is(err, ErrFence) || len(w.eventSnapshot()) != before || j.candidate.Record() != c.Record() {
		t.Fatal("same-attempt overwrite was permitted")
	}
}

func Test_AttemptKey_when_retry(t *testing.T) {
	// Given: identities identical, number increments while first-claim remains fixed.
	spec := AttemptSpec{OrganizationID: "o", ResourceID: "r", BackupID: "b", KeyVersion: "v", Number: 1, FirstClaimAt: time.Now()}
	first, err := NewAttempt(spec)
	if err != nil {
		t.Fatal(err)
	}
	spec.Number = 2
	// When
	second, err := NewAttempt(spec)
	if err != nil {
		t.Fatal(err)
	}
	// Then: retries cannot overwrite winner objects or reset the deadline.
	if first.ObjectKey() == second.ObjectKey() || first.Deadline() != second.Deadline() {
		t.Fatal("retry identity/deadline violated")
	}
}

type blockingSink struct {
	started   chan struct{}
	closed    chan struct{}
	writeOnce sync.Once
	closeOnce sync.Once
}

func (b *blockingSink) Write([]byte) (int, error) {
	b.writeOnce.Do(func() { close(b.started) })
	<-b.closed
	return 0, io.ErrClosedPipe
}
func (b *blockingSink) Close() error { b.closeOnce.Do(func() { close(b.closed) }); return nil }

func Test_ReadbackCancellation_when_sink_blocked(t *testing.T) {
	// Given: an isolated restore sink blocked until ownership cancellation closes it.
	s, _, j, a := fixture(t, "", Options{})
	c := uploadFixture(t, s, j, a, 12)
	ctx, cancel := context.WithCancel(readbackContext(t))
	defer cancel()
	sink := &blockingSink{started: make(chan struct{}), closed: make(chan struct{})}
	finished := make(chan error, 1)
	go func() { _, err := s.Readback(ctx, c, sink); finished <- err }()
	// When: cancel exactly after Write begins.
	select {
	case <-sink.started:
	case <-time.After(5 * time.Second):
		t.Fatal("sink never started")
	}
	cancel()
	// Then: no writer goroutine or provisional publication survives.
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("sink cancellation did not unblock")
	}
}

func Test_ControlResponse_when_close_fails(t *testing.T) {
	// Given: actual TLS response whose close fails at the transport boundary.
	s, _, j, a := fixture(t, "", Options{})
	uploadFixture(t, s, j, a, 12)
	// Use the actual SDK signer with the fault inside the bounded HTTP transport.
	options := s.client.Options()
	options.HTTPClient = &http.Client{Transport: controlTransport{base: closeFaultTransport{base: s.transport}}}
	// When: invoking cleanup through a new SDK client with response close fault.
	s.client = s3.New(options)
	_, err := s.Cleanup(context.Background(), CleanupRequest{Attempt: a, Remote: j.complete}, j)
	// Then: the SDK cannot swallow the control body's Close failure.
	if !errors.Is(err, ErrCleanupPending) {
		t.Fatal("control response close failure accepted")
	}
}

func Test_ReadbackBudget_when_caller_omits_absolute_deadline(t *testing.T) {
	// Given: a complete artifact but no persisted restore deadline on the context.
	s, w, j, a := fixture(t, "", Options{})
	c := uploadFixture(t, s, j, a, 12)
	before := len(w.eventSnapshot())
	sink := &bufferSink{}
	// When
	_, err := s.Readback(context.Background(), c, sink)
	// Then: no I/O or silently renewed budget, and sink ownership is released.
	if !errors.Is(err, ErrConfig) || len(w.eventSnapshot()) != before || !sink.closed {
		t.Fatal("missing absolute restore deadline was accepted")
	}
}
