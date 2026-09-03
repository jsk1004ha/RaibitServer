package backup

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
)

func Test_Cleanup_when_exact_owned_artifacts(t *testing.T) {
	for _, mode := range []string{"completed", "unknown-create", "versioned"} {
		t.Run(mode, func(t *testing.T) {
			// Given: real SDK persisted an object or created an unknown multipart.
			s, w, j, a := fixture(t, "", Options{})
			if mode == "unknown-create" {
				w.mode = "create-unknown"
				_, err := s.Upload(context.Background(), UploadRequest{Attempt: a, Source: io.NopCloser(strings.NewReader("x"))}, j)
				if !errors.Is(err, ErrCleanupPending) {
					t.Fatal(err)
				}
				w.mode = ""
			} else {
				uploadFixture(t, s, j, a, 10)
				if mode == "versioned" {
					w.mode = "versioned"
				}
			}
			// When: authorized cleanup enumerates only this attempt.
			result, err := s.Cleanup(context.Background(), CleanupRequest{Attempt: a}, j)
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
			result, err := s.Cleanup(context.Background(), CleanupRequest{Attempt: a, UploadID: "upload-1"}, j)
			// Then: pending state remains and never claims both absent.
			if err == nil || result.MultipartAbsent && result.ObjectAbsent {
				t.Fatal("unproven cleanup accepted")
			}
		})
	}
}
