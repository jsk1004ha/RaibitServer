package recoverywire

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
)

func Test_IO_errors_do_not_expose_sensitive_causes_through_unwrap_trees(t *testing.T) {
	// Given
	secret := "DATABASE_URL=postgres://admin:password@private.internal/db"
	metadata := mustMetadata(t)
	encoded, _, err := encodePayload([]byte("payload"))
	if err != nil {
		t.Fatal(err)
	}
	headerThenReadError := io.MultiReader(
		strings.NewReader("RAIBIT-RECOVERY/1 postgresql 16.4 pg-custom baseline=none\n"),
		errorReader{err: errors.New(secret)},
	)

	// When
	_, encodeErr := NewEncoder(DefaultLimits()).Encode(context.Background(), io.Discard, Envelope{
		Metadata: metadata,
		Payload:  errorReader{err: errors.New(secret)},
	})
	_, decodeReadErr := NewDecoder(DefaultLimits()).Decode(context.Background(), io.Discard, headerThenReadError)
	_, decodeWriteErr := NewDecoder(DefaultLimits()).Decode(
		context.Background(),
		errorWriter{err: errors.New(secret)},
		strings.NewReader(encoded),
	)

	// Then
	for _, codecErr := range []error{encodeErr, decodeReadErr, decodeWriteErr} {
		if !errors.Is(codecErr, ErrIO) {
			t.Fatalf("missing safe I/O classification: %v", codecErr)
		}
		for _, text := range walkErrorTexts(codecErr) {
			if strings.Contains(text, secret) {
				t.Fatal("sensitive cause recovered from error tree")
			}
		}
	}
}

func Test_error_tree_walker_detects_joined_sensitive_causes(t *testing.T) {
	// Given
	secret := "joined-secret-control"
	joined := errors.Join(errors.New("safe"), errors.New(secret))

	// When
	texts := walkErrorTexts(joined)

	// Then
	if !strings.Contains(strings.Join(texts, "\n"), secret) {
		t.Fatal("adversarial walker failed to inspect a joined cause")
	}
}

func walkErrorTexts(root error) []string {
	if root == nil {
		return nil
	}
	texts := []string{root.Error()}
	if joined, ok := root.(interface{ Unwrap() []error }); ok {
		for _, child := range joined.Unwrap() {
			texts = append(texts, walkErrorTexts(child)...)
		}
		return texts
	}
	return append(texts, walkErrorTexts(errors.Unwrap(root))...)
}
