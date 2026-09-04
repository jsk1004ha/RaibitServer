package recoverywire

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
)

func Test_Decoder_rejects_structurally_invalid_envelopes(t *testing.T) {
	encoded, _, err := encodePayload(deterministicBytes(PayloadChunkSize + 1))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(encoded, "\n")
	tests := []struct {
		name     string
		envelope string
	}{
		{"missing header", strings.Join(lines[1:], "\n")},
		{"missing frame", strings.Join([]string{lines[0], lines[2], lines[3], ""}, "\n")},
		{"duplicate frame", strings.Join([]string{lines[0], lines[1], lines[1], lines[3], ""}, "\n")},
		{"reordered frame", strings.Join([]string{lines[0], lines[2], lines[1], lines[3], ""}, "\n")},
		{"unknown frame", strings.Join([]string{lines[0], "X 0000000000 AAAA", lines[3], ""}, "\n")},
		{"trailing frame", encoded + "X trailing\n"},
		{"truncated terminal", strings.TrimSuffix(encoded, "\n")},
		{"header injection", "RAIBIT-RECOVERY/1 postgresql 16.4 pg-custom extra\n" + strings.Join(lines[1:], "\n")},
		{"carriage return", strings.Replace(encoded, "\n", "\r\n", 1)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// When
			_, decodeErr := decodeEnvelope(context.Background(), test.envelope, DefaultLimits())

			// Then
			if !errors.Is(decodeErr, ErrInvalidEnvelope) {
				t.Fatalf("error=%v", decodeErr)
			}
		})
	}
}

func Test_Decoder_rejects_payload_and_terminal_corruption(t *testing.T) {
	encoded, _, err := encodePayload([]byte{0xff})
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name     string
		replacer func(string) string
	}{
		{"noncanonical base64", func(value string) string { return strings.Replace(value, "/w==", "/x==", 1) }},
		{"missing base64 padding", func(value string) string { return strings.Replace(value, "/w==", "/w", 1) }},
		{"byte count mismatch", func(value string) string { return strings.Replace(value, "E 1 1 ", "E 1 2 ", 1) }},
		{"frame count mismatch", func(value string) string { return strings.Replace(value, "E 1 1 ", "E 2 1 ", 1) }},
		{"hash mismatch", func(value string) string {
			parts := strings.Split(value, "\n")
			terminal := strings.Fields(parts[2])
			terminal[3] = strings.Repeat("0", 64)
			parts[2] = strings.Join(terminal, " ")
			return strings.Join(parts, "\n")
		}},
		{"noncanonical frame count", func(value string) string { return strings.Replace(value, "E 1 1 ", "E 01 1 ", 1) }},
		{"uppercase hash", func(value string) string {
			parts := strings.Split(value, "\n")
			terminal := strings.Fields(parts[2])
			terminal[3] = strings.ToUpper(terminal[3])
			parts[2] = strings.Join(terminal, " ")
			return strings.Join(parts, "\n")
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// When
			_, decodeErr := decodeEnvelope(context.Background(), test.replacer(encoded), DefaultLimits())

			// Then
			if !errors.Is(decodeErr, ErrInvalidEnvelope) {
				t.Fatalf("error=%v", decodeErr)
			}
		})
	}
}

func Test_Decoder_rejects_encoded_payload_larger_than_one_frame(t *testing.T) {
	// Given
	oversizedPayload := strings.Repeat("A", 4097)
	malformed := "RAIBIT-RECOVERY/1 postgresql 16.4 pg-custom baseline=none\nD 0000000000 " + oversizedPayload + "\n"

	// When
	_, err := decodeEnvelope(context.Background(), malformed, DefaultLimits())

	// Then
	if !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("error=%v", err)
	}
}

func Test_Decoder_rejects_oversized_lines_and_declared_bounds(t *testing.T) {
	encoded, _, err := encodePayload(deterministicBytes(PayloadChunkSize + 1))
	if err != nil {
		t.Fatal(err)
	}
	byteLimits, err := NewLimits(PayloadChunkSize, 2)
	if err != nil {
		t.Fatal(err)
	}
	frameLimits, err := NewLimits(2*PayloadChunkSize, 1)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name     string
		envelope string
		limits   Limits
	}{
		{"oversized line", "RAIBIT-RECOVERY/1 postgresql 16.4 pg-custom baseline=none\nD 0000000000 " + strings.Repeat("A", MaxLineLength) + "\n", DefaultLimits()},
		{"byte limit", encoded, byteLimits},
		{"frame limit", encoded, frameLimits},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// When
			_, decodeErr := decodeEnvelope(context.Background(), test.envelope, test.limits)

			// Then
			if !errors.Is(decodeErr, ErrLimitExceeded) {
				t.Fatalf("error=%v", decodeErr)
			}
		})
	}
}

func Test_Codec_honors_context_cancellation(t *testing.T) {
	// Given
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	metadata := mustMetadata(t)
	encoded, _, err := encodePayload([]byte("payload"))
	if err != nil {
		t.Fatal(err)
	}

	// When
	_, encodeErr := NewEncoder().Encode(ctx, io.Discard, Envelope{Metadata: metadata, Payload: strings.NewReader("payload")})
	_, decodeErr := decodeEnvelope(ctx, encoded, DefaultLimits())

	// Then
	if !errors.Is(encodeErr, context.Canceled) || !errors.Is(decodeErr, context.Canceled) {
		t.Fatalf("encode=%v decode=%v", encodeErr, decodeErr)
	}
}

func Test_Codec_errors_never_echo_plaintext_or_secret_contents(t *testing.T) {
	// Given
	secret := "ULTRA_SECRET_PAYLOAD_42"
	malformed := "RAIBIT-RECOVERY/1 postgresql 16.4 pg-custom baseline=none\nD 0000000000 " + secret + "\n"
	metadata := mustMetadata(t)

	// When
	_, decodeErr := decodeEnvelope(context.Background(), malformed, DefaultLimits())
	_, encodeErr := NewEncoder().Encode(context.Background(), io.Discard, Envelope{
		Metadata: metadata,
		Payload:  errorReader{err: errors.New(secret)},
	})
	encoded, _, err := encodePayload([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	_, decodeWriteErr := NewDecoder(DefaultLimits()).Decode(
		context.Background(),
		errorWriter{err: errors.New(secret)},
		strings.NewReader(encoded),
	)
	headerThenReadError := io.MultiReader(
		strings.NewReader("RAIBIT-RECOVERY/1 postgresql 16.4 pg-custom baseline=none\n"),
		errorReader{err: errors.New(secret)},
	)
	_, decodeReadErr := NewDecoder(DefaultLimits()).Decode(context.Background(), io.Discard, headerThenReadError)

	// Then
	for _, codecErr := range []error{decodeErr, encodeErr, decodeWriteErr, decodeReadErr} {
		if codecErr == nil || strings.Contains(codecErr.Error(), secret) {
			t.Fatalf("unsafe error=%v", codecErr)
		}
	}
}

func decodeEnvelope(ctx context.Context, encoded string, limits Limits) (Decoded, error) {
	var decoded bytes.Buffer
	return NewDecoder(limits).Decode(ctx, &decoded, strings.NewReader(encoded))
}

type errorReader struct{ err error }

func (r errorReader) Read([]byte) (int, error) { return 0, r.err }

type errorWriter struct{ err error }

func (w errorWriter) Write([]byte) (int, error) { return 0, w.err }

func Test_NewLimits_rejects_zero_and_sequence_overflow(t *testing.T) {
	for _, limits := range [][2]uint64{{0, 1}, {1, 0}, {1, 10_000_000_000}} {
		// When
		_, err := NewLimits(limits[0], limits[1])

		// Then
		if !errors.Is(err, ErrLimitExceeded) {
			t.Fatalf("limits=%v error=%v", limits, err)
		}
	}
}

func Test_Decoder_rejects_nonfinal_short_frame(t *testing.T) {
	// Given
	encoded, _, err := encodePayload(deterministicBytes(PayloadChunkSize + 1))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(encoded, "\n")
	lines[1] = "D 0000000000 QQ=="
	malformed := strings.Join(lines, "\n")

	// When
	_, decodeErr := decodeEnvelope(context.Background(), malformed, DefaultLimits())

	// Then
	if !errors.Is(decodeErr, ErrInvalidEnvelope) {
		t.Fatalf("error=%v", decodeErr)
	}
}

func Test_Decoder_rejects_terminal_integer_overflow(t *testing.T) {
	// Given
	encoded, _, err := encodePayload(nil)
	if err != nil {
		t.Fatal(err)
	}
	malformed := strings.Replace(encoded, "E 0 0 ", fmt.Sprintf("E %s 0 ", strings.Repeat("9", 30)), 1)

	// When
	_, decodeErr := decodeEnvelope(context.Background(), malformed, DefaultLimits())

	// Then
	if !errors.Is(decodeErr, ErrInvalidEnvelope) {
		t.Fatalf("error=%v", decodeErr)
	}
}
