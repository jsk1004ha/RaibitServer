package backup

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
)

func Test_Cleanup_when_exact_owned_artifacts(t *testing.T) {
	for _, mode := range []string{"completed", "versioned"} {
		t.Run(mode, func(t *testing.T) {
			// Given: real SDK persisted an object and durable completion witness.
			s, w, j, a := fixture(t, "", Options{})
			uploadFixture(t, s, j, a, 10)
			if mode == "versioned" {
				w.mode = "versioned"
			}
			// When: authorized cleanup enumerates only this attempt.
			result, err := s.Cleanup(context.Background(), CleanupRequest{Attempt: a, Remote: j.complete}, j)
			// Then: exact IDs/versions removed, foreign entries untouched by handler.
			if err != nil || !result.MultipartAbsent || !result.ObjectAbsent {
				t.Fatalf("cleanup incomplete: %v", err)
			}
			w.mu.Lock()
			remains := w.uploadActive || w.object != nil
			w.mu.Unlock()
			if remains {
				t.Fatal("owned artifact survived cleanup")
			}
			t.Logf("cleanup multipart_absent=%t object_absent=%t events=%v", result.MultipartAbsent, result.ObjectAbsent, w.eventSnapshot())
		})
	}
}

func Test_Cleanup_when_unproven(t *testing.T) {
	for _, mode := range []string{"abort-fail", "delete-fail", "list-fail", "list-truncated", "list-overflow", "version-overflow", "version-truncated", "parts-remain", "cleanup"} {
		t.Run(mode, func(t *testing.T) {
			// Given: failure at a cleanup boundary.
			s, w, j, a := fixture(t, "", Options{})
			uploadFixture(t, s, j, a, 10)
			w.mode = mode
			j.fail = mode
			// When: cleanup is attempted with durable exact identity.
			result, err := s.Cleanup(context.Background(), CleanupRequest{Attempt: a, UploadID: "upload-1", Remote: j.complete}, j)
			// Then: pending state remains and never claims both absent.
			if err == nil || result.MultipartAbsent && result.ObjectAbsent {
				t.Fatal("unproven cleanup accepted")
			}
		})
	}
}

func Test_Cleanup_when_unknown_create_materialized(t *testing.T) {
	// Given: Create committed, but its response and durable upload ID were lost.
	s, w, j, a := fixture(t, "create-unknown", Options{})
	_, err := s.Upload(context.Background(), UploadRequest{Attempt: a, Source: io.NopCloser(strings.NewReader("x"))}, j)
	if !errors.Is(err, ErrCleanupPending) {
		t.Fatal(err)
	}
	// When: even already visible debris cannot certify sole Create completion.
	result, err := s.Cleanup(context.Background(), CleanupRequest{Attempt: a, Remote: UnknownRemoteWrite{}}, j)
	// Then: preserve the upload identity/witness and pin; do not fabricate absence.
	if !errors.Is(err, ErrCleanupPending) || result.MultipartAbsent || result.ObjectAbsent || !w.uploadActive {
		t.Fatal("unknown Create discarded remote evidence")
	}
}
