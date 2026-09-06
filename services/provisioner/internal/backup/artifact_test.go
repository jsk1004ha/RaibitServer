package backup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

type bufferSink struct {
	bytes.Buffer
	closeErr error
	closed   bool
}

func (s *bufferSink) Close() error { s.closed = true; return s.closeErr }

func Test_StreamingArtifact_when_roundtrip(t *testing.T) {
	for _, size := range []int{0, 1, SegmentBytes*3 + 7, PartBytes*2 + 13} {
		t.Run(sizeName(size), func(t *testing.T) {
			// Given: real SDK + TLS wire storage, independent plaintext expectation.
			s, w, j, a := fixture(t, "", Options{})
			c := uploadFixture(t, s, j, a, size)
			sink := &bufferSink{}
			// When: reading the entire durable encrypted object into an isolated sink.
			verified, err := s.Readback(readbackContext(t), c, sink)
			// Then: publication authority requires exact bytes and successful closure.
			if err != nil || verified.Record() != c.Record() || !sink.closed || !bytes.Equal(sink.Bytes(), bytes.Repeat([]byte{0x5a}, size)) {
				t.Fatalf("roundtrip failed: %v", err)
			}
			w.mu.Lock()
			stored := len(w.object)
			sum := sha256.Sum256(w.object)
			signed, conditional, read := w.signed, w.conditional, w.readBytes
			w.mu.Unlock()
			if int64(stored) != c.Record().StoredBytes || sum != c.Record().SHA256 || read != stored || !signed || !conditional {
				t.Fatal("wire ciphertext descriptor mismatch")
			}
			t.Logf("ciphertext_sha256=%x stored_bytes=%d plaintext_bytes=%d signed=true conditional=true readback_bytes=%d", sum, stored, size, read)
		})
	}
}

func sizeName(n int) string {
	switch n {
	case 0:
		return "empty"
	case 1:
		return "one-byte"
	case SegmentBytes*3 + 7:
		return "multisegment"
	default:
		return "multipart"
	}
}

func Test_ArtifactIntegrity_when_corrupted(t *testing.T) {
	for _, mode := range []string{"header", "tamper", "reorder", "truncate", "trailing", "wrong-org", "wrong-resource", "wrong-backup", "wrong-attempt", "wrong-version", "wrong-key", "wrong-length", "wrong-hash", "wrong-plain-length", "get-truncated"} {
		t.Run(mode, func(t *testing.T) {
			// Given: a durable multisegment artifact. Recompute public checksum for
			// wire mutations to ensure authentication, not only SHA256, rejects it.
			s, w, j, a := fixture(t, "", Options{})
			c := uploadFixture(t, s, j, a, SegmentBytes*3+7)
			record := c.Record()
			w.mu.Lock()
			switch mode {
			case "header":
				w.object[0] ^= 1
			case "tamper":
				w.object[len(w.object)/2] ^= 1
			case "reorder":
				aad, err := header(a)
				if err != nil {
					t.Fatal(err)
				}
				start := len(aad)
				first := append([]byte(nil), w.object[start:start+SegmentBytes]...)
				copy(w.object[start:start+SegmentBytes], w.object[start+SegmentBytes:start+2*SegmentBytes])
				copy(w.object[start+SegmentBytes:start+2*SegmentBytes], first)
			case "truncate":
				w.object = w.object[:len(w.object)-1]
			case "trailing":
				w.object = append(w.object, 0)
			case "wrong-org":
				record.Attempt.OrganizationID = "other-org"
			case "wrong-resource":
				record.Attempt.ResourceID = "other-resource"
			case "wrong-backup":
				record.Attempt.BackupID = "other-backup"
			case "wrong-attempt":
				record.Attempt.Number = 2
			case "wrong-version":
				record.Attempt.KeyVersion = "key-2"
			case "wrong-key":
				s.bundle.keys["key-1"] = [32]byte{1}
			case "wrong-length":
				record.StoredBytes++
			case "wrong-hash":
				record.SHA256[0] ^= 1
			case "wrong-plain-length":
				record.PlaintextBytes++
			case "get-truncated":
				w.mode = mode
			}
			switch mode {
			case "header", "tamper", "reorder", "truncate", "trailing":
				record.StoredBytes = int64(len(w.object))
				record.SHA256 = sha256.Sum256(w.object)
			}
			w.mu.Unlock()
			candidate, err := ParseCandidate(record)
			if err != nil {
				t.Fatal(err)
			}
			// When: full durable verification, with trusted expected identity.
			verified, err := s.Verify(context.Background(), candidate)
			// Then: no verified authority is returned.
			if err == nil || verified.Record().StoredBytes != 0 {
				t.Fatal("corrupt artifact accepted")
			}
		})
	}
}

func Test_Upload_when_durable_or_backend_failure(t *testing.T) {
	for _, mode := range []string{"intent", "upload", "candidate", "fence", "final-fence", "create-unknown", "part-fail", "complete-unsupported", "complete-conflict"} {
		t.Run(mode, func(t *testing.T) {
			// Given: each durable/network failure occurs at a real upload boundary.
			s, w, j, a := fixture(t, mode, Options{})
			j.fail = mode
			// When: uploading one bounded archive.
			c, err := s.Upload(context.Background(), UploadRequest{Attempt: a, Source: io.NopCloser(strings.NewReader("archive"))}, j)
			// Then: no candidate/READY authority, sanitized error, cleanup retained.
			if err == nil || c.Record().StoredBytes != 0 || strings.Contains(err.Error(), "SECRET") {
				t.Fatal("failure accepted or leaked backend body")
			}
			if mode != "intent" && !errors.Is(err, ErrCleanupPending) {
				t.Fatalf("cleanup reference not retained: %v", err)
			}
			if mode == "intent" && len(w.eventSnapshot()) != 0 {
				t.Fatal("network before intent fence")
			}
		})
	}
}

func Test_Upload_when_complete_response_uncertain(t *testing.T) {
	// Given: server persists object but returns HTTP500 instead of completion.
	s, w, j, a := fixture(t, "complete-unknown", Options{})
	// When: uploading via actual SDK.
	c := uploadFixture(t, s, j, a, SegmentBytes+3)
	// Then: reconciliation consumed every stored byte and exact descriptor.
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.readBytes != len(w.object) || c.Record().SHA256 != sha256.Sum256(w.object) {
		t.Fatal("uncertain completion was not fully reconciled")
	}
}

func Test_UploadBounds_when_input_exceeds_limit(t *testing.T) {
	for _, scenario := range []struct {
		name      string
		options   Options
		size      int
		wantError bool
	}{{"plain-at-bound", Options{MaxPlaintextBytes: 16}, 16, false}, {"plain-over", Options{MaxPlaintextBytes: 16}, 17, true}, {"stored-over", Options{MaxStoredBytes: 100}, 1, true}} {
		t.Run(scenario.name, func(t *testing.T) {
			// Given: smaller operator bound using the same production counting path.
			s, _, j, a := fixture(t, "", scenario.options)
			// When: streaming the boundary-sized input.
			_, err := s.Upload(context.Background(), UploadRequest{Attempt: a, Source: io.NopCloser(bytes.NewReader(make([]byte, scenario.size)))}, j)
			// Then: tags/header count against stored bound; plaintext separately bounded.
			if scenario.wantError != errors.Is(err, ErrLimit) {
				t.Fatalf("bound mismatch: %v", err)
			}
		})
	}
}

func Test_Deadlines_when_expired_or_cancelled(t *testing.T) {
	for _, mode := range []string{"expired", "cancelled", "future"} {
		t.Run(mode, func(t *testing.T) {
			// Given: stale first-claim time is not replaced with retry time.
			s, w, j, a := fixture(t, "", Options{})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			spec := a.Spec()
			switch mode {
			case "expired":
				spec.FirstClaimAt = time.Now().Add(-MaxDuration - time.Second)
			case "cancelled":
				cancel()
			case "future":
				spec.FirstClaimAt = time.Now().Add(time.Hour)
			}
			a, err := NewAttempt(spec)
			if err != nil {
				t.Fatal(err)
			}
			// When: a stale/cancelled attempt starts.
			_, err = s.Upload(ctx, UploadRequest{Attempt: a, Source: io.NopCloser(strings.NewReader("archive"))}, j)
			// Then: zero storage requests.
			if err == nil || len(w.eventSnapshot()) != 0 {
				t.Fatal("invalid deadline touched storage")
			}
		})
	}
}
