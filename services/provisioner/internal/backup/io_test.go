package backup

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"go.uber.org/goleak"
)

func TestMain(m *testing.M) { goleak.VerifyTestMain(m) }

type shortSource struct {
	io.Reader
	closeErr error
}

func (s shortSource) Read(p []byte) (int, error) {
	if len(p) > 3 {
		p = p[:3]
	}
	return s.Reader.Read(p)
}
func (s shortSource) Close() error { return s.closeErr }

type shortSink struct{}

func (shortSink) Write(p []byte) (int, error) { return len(p) / 2, nil }
func (shortSink) Close() error                { return nil }

func Test_StreamIO_when_short_or_close_failure(t *testing.T) {
	for _, mode := range []string{"short-read", "source-close", "short-write", "sink-close", "response-close"} {
		t.Run(mode, func(t *testing.T) {
			// Given: real TLS SDK wire plus exact stream I/O fault seam.
			s, _, j, a := fixture(t, "", Options{})
			source := shortSource{Reader: strings.NewReader("archive")}
			if mode == "source-close" {
				source.closeErr = ErrBackend
			}
			c, uploadErr := s.Upload(context.Background(), UploadRequest{Attempt: a, Source: source}, j)
			if mode == "source-close" {
				if uploadErr == nil || c.Record().StoredBytes != 0 {
					t.Fatal("source close failure accepted")
				}
				return
			}
			if uploadErr != nil {
				t.Fatal(uploadErr)
			}
			var sink io.WriteCloser = &bufferSink{}
			switch mode {
			case "short-write":
				sink = shortSink{}
			case "sink-close":
				sink = &bufferSink{closeErr: ErrBackend}
			case "response-close":
				options := s.client.Options()
				options.HTTPClient = &http.Client{Transport: closeFaultTransport{base: s.transport}, Timeout: MaxDuration}
				s.client = s3.New(options)
			}
			// When: consuming the full durable artifact.
			verified, err := s.Readback(readbackContext(t), c, sink)
			// Then: every close/write failure suppresses verified authority.
			if mode == "short-read" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || verified.Record().StoredBytes != 0 {
				t.Fatal("stream failure accepted")
			}
		})
	}
}

type closeFaultTransport struct{ base http.RoundTripper }

func (c closeFaultTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	response, err := c.base.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	response.Body = closeFaultBody{ReadCloser: response.Body}
	return response, nil
}

type closeFaultBody struct{ io.ReadCloser }

func (c closeFaultBody) Close() error { return errors.Join(c.ReadCloser.Close(), ErrBackend) }

type blockingSource struct {
	started   chan struct{}
	closed    chan struct{}
	readOnce  sync.Once
	closeOnce sync.Once
}

func (b *blockingSource) Read([]byte) (int, error) {
	b.readOnce.Do(func() { close(b.started) })
	<-b.closed
	return 0, io.ErrClosedPipe
}
func (b *blockingSource) Close() error { b.closeOnce.Do(func() { close(b.closed) }); return nil }

func Test_UploadCancellation_when_source_blocked(t *testing.T) {
	// Given: a source which blocks until ownership cancellation closes it.
	s, _, j, a := fixture(t, "", Options{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	source := &blockingSource{started: make(chan struct{}), closed: make(chan struct{})}
	finished := make(chan error, 1)
	go func() { _, err := s.Upload(ctx, UploadRequest{Attempt: a, Source: source}, j); finished <- err }()
	// When: cancel exactly after Read is entered, no sleeps/polling.
	select {
	case <-source.started:
	case <-time.After(5 * time.Second):
		t.Fatal("source never started")
	}
	cancel()
	// Then: upload joins closure and returns cancelled with durable cleanup pending.
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) || !errors.Is(err, ErrCleanupPending) {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancellation did not unblock stream")
	}
}

func Test_VerifyDeadline_when_backup_expired_but_restore_allowed(t *testing.T) {
	// Given: an artifact whose original backup-operation deadline has elapsed.
	s, w, j, a := fixture(t, "", Options{})
	c := uploadFixture(t, s, j, a, 12)
	record := c.Record()
	record.Attempt.FirstClaimAt = time.Now().Add(-time.Hour)
	c, err := ParseCandidate(record)
	if err != nil {
		t.Fatal(err)
	}
	before := len(w.eventSnapshot())
	// When: requesting backup verification under its fixed deadline.
	_, err = s.Verify(context.Background(), c)
	// Then: no new network request; separate restore Readback remains supported.
	if !errors.Is(err, context.DeadlineExceeded) || len(w.eventSnapshot()) != before {
		t.Fatal("backup verification reset deadline")
	}
}

func Test_RestoreReadback_when_retained_artifact(t *testing.T) {
	// Given: old artifact with a fresh caller-owned restore context.
	s, _, j, a := fixture(t, "", Options{})
	c := uploadFixture(t, s, j, a, 12)
	record := c.Record()
	record.Attempt.FirstClaimAt = time.Now().Add(-time.Hour)
	c, err := ParseCandidate(record)
	if err != nil {
		t.Fatal(err)
	}
	sink := &bufferSink{}
	// When
	_, err = s.Readback(readbackContext(t), c, sink)
	// Then
	if err != nil || !bytes.Equal(sink.Bytes(), bytes.Repeat([]byte{0x5a}, 12)) {
		t.Fatal("retained artifact could not be restored")
	}
}
