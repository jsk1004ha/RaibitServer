package backup

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

func Test_Cleanup_when_completion_persistence_fails(t *testing.T) {
	// Given: remotely completed object with durable PREPARED, no durable witness.
	s, w, j, a := fixture(t, "", Options{})
	c := uploadFixture(t, s, j, a, 64)
	j.complete = RemoteCompletion{}
	j.fail = "completion"
	before := len(w.eventSnapshot())
	// When: full readback succeeds but the cleanup-token CAS rejects persistence.
	result, err := s.Cleanup(context.Background(), CleanupRequest{Attempt: a, UploadID: "upload-1", Remote: PreparedRemoteWrite{Candidate: c}}, j)
	// Then: not even abort may precede the durable witness; object remains usable.
	events := w.eventSnapshot()
	if !errors.Is(err, ErrFence) || result.MultipartAbsent || result.ObjectAbsent || len(events) != before+1 || w.object == nil || j.complete.Record().StoredBytes != 0 {
		t.Fatalf("persistence failure destroyed witness: result=%+v events=%v err=%v", result, events, err)
	}
	t.Log("readback_complete=true completion_cas_rejected=true mutations=0 witness_preserved=true")
}

func Test_Cleanup_when_restart_follows_uncertain_delete(t *testing.T) {
	// Given: PREPARED object; deletion commits but its response is lost.
	s, w, j, a := fixture(t, "", Options{})
	c := uploadFixture(t, s, j, a, 64)
	j.complete = RemoteCompletion{}
	w.mode = "delete-unknown"
	result, err := s.Cleanup(context.Background(), CleanupRequest{Attempt: a, Remote: PreparedRemoteWrite{Candidate: c}}, j)
	if !errors.Is(err, ErrCleanupPending) || result.ObjectAbsent || w.object != nil || j.complete.Record() != c.Record() {
		t.Fatalf("completion was not persisted before uncertain delete: %v", err)
	}
	completion, err := ParseRemoteCompletion(j.complete.Record())
	if err != nil {
		t.Fatal(err)
	}
	w.mode = ""
	before := w.readBytes
	// When: restart rehydrates trusted COMPLETE after the only object disappeared.
	result, err = s.Cleanup(context.Background(), CleanupRequest{Attempt: a, Remote: completion}, j)
	// Then: absence can finalize without requiring the now-deleted witness again.
	if err != nil || !result.MultipartAbsent || !result.ObjectAbsent || w.readBytes != before {
		t.Fatalf("durable completion could not resume cleanup: %v", err)
	}
	t.Log("completion_persisted_before_delete=true deleted_object_gone=true restart_final=true reread_bytes=0")
}

func Test_Cleanup_when_prepared_upload_deadline_expired(t *testing.T) {
	// Given: a retained real encrypted envelope whose original deadline is past.
	s, w, j, a := fixture(t, "", Options{})
	spec := a.Spec()
	spec.FirstClaimAt = time.Now().Add(-2 * MaxDuration)
	a, err := NewAttempt(spec)
	if err != nil {
		t.Fatal(err)
	}
	var ciphertext bytes.Buffer
	source := io.NopCloser(strings.NewReader("retained archive"))
	defer source.Close()
	record, err := s.encrypt(context.Background(), UploadRequest{Attempt: a, Source: source}, &ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := ParseCandidate(record)
	if err != nil {
		t.Fatal(err)
	}
	w.object = ciphertext.Bytes()
	j.candidate = candidate
	// When: cleanup performs TLS full readback under its fresh cleanup budget.
	result, err := s.Cleanup(context.Background(), CleanupRequest{Attempt: a, Remote: PreparedRemoteWrite{Candidate: candidate}}, j)
	// Then: expired upload lease is not silently renewed or required for cleanup.
	if err != nil || !result.MultipartAbsent || !result.ObjectAbsent || j.complete.Record() != record {
		t.Fatalf("expired PREPARED could not reconcile: %v", err)
	}
	t.Log("original_upload_deadline_expired=true bounded_cleanup_readback=true completion_persisted=true")
}

func Test_Upload_when_completion_journal_fails(t *testing.T) {
	// Given: a successful remote Complete but a failed durable completion callback.
	s, w, j, a := fixture(t, "", Options{})
	j.fail = "completion"
	// When: Upload attempts its mandatory completion handoff.
	c, err := s.Upload(context.Background(), UploadRequest{Attempt: a, Source: io.NopCloser(strings.NewReader("archive"))}, j)
	// Then: crash-equivalent PREPARED survives; no success Candidate is returned.
	if !errors.Is(err, ErrCleanupPending) || !errors.Is(err, ErrFence) || c.Record().StoredBytes != 0 || j.candidate.Record().StoredBytes == 0 || j.complete.Record().StoredBytes != 0 || w.object == nil {
		t.Fatalf("failed completion journal lost recovery state: %v", err)
	}
	j.fail = ""
	result, err := s.Cleanup(context.Background(), CleanupRequest{Attempt: a, Remote: PreparedRemoteWrite{Candidate: j.candidate}}, j)
	if err != nil || !result.MultipartAbsent || !result.ObjectAbsent {
		t.Fatalf("PREPARED journal crash could not recover: %v", err)
	}
	t.Log("upload_callback_rejected=true candidate_returned=false prepared_retained=true cleanup_recovered=true")
}

func Test_Cleanup_when_remote_evidence_invalid(t *testing.T) {
	for _, scenario := range []string{"zero-completion", "wrong-completion-attempt", "wrong-prepared-attempt", "tampered-object", "incomplete-upload"} {
		t.Run(scenario, func(t *testing.T) {
			// Given: evidence not belonging to a fully authenticated completion.
			s, w, j, a := fixture(t, "", Options{})
			c := uploadFixture(t, s, j, a, 64)
			req := CleanupRequest{Attempt: a, UploadID: "upload-1", Remote: PreparedRemoteWrite{Candidate: c}}
			switch scenario {
			case "zero-completion":
				req.Remote = RemoteCompletion{}
			case "wrong-completion-attempt":
				other := j.complete
				other.record.Attempt.Number++
				req.Remote = other
			case "wrong-prepared-attempt":
				c.record.Attempt.Number++
				req.Remote = PreparedRemoteWrite{Candidate: c}
			case "tampered-object":
				w.object[len(w.object)-1] ^= 1
			case "incomplete-upload":
				req.Remote = UnknownRemoteWrite{}
			}
			j.complete = RemoteCompletion{}
			// When
			result, err := s.Cleanup(context.Background(), req, j)
			// Then: no mutation or forged final absence; positive bytes remain.
			if !errors.Is(err, ErrCleanupPending) || result.MultipartAbsent || result.ObjectAbsent || w.object == nil || j.complete.Record().StoredBytes != 0 {
				t.Fatalf("invalid evidence accepted: %v", err)
			}
		})
	}
}
