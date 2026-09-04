package recoverywire

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"strings"
	"testing"
)

func Test_Envelope_round_trips_arbitrary_binary(t *testing.T) {
	// Given
	payload := []byte{0x00, 0xff, '\n', '\r', 0x80, 's', 'e', 'c', 'r', 'e', 't'}

	// When
	decoded, result, encodeReceipt, err := roundTrip(payload)

	// Then
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decoded, payload) {
		t.Fatalf("decoded payload mismatch")
	}
	if result.Metadata != mustMetadata(t) || result.Receipt != encodeReceipt {
		t.Fatalf("metadata or receipt mismatch")
	}
}

func Test_Envelope_round_trips_a_source_baseline(t *testing.T) {
	// Given
	schemaDigest := sha256.Sum256([]byte("schema-v3"))
	dataDigest := sha256.Sum256([]byte("logical-rows-v7"))
	baseline, err := NewBaseline(schemaDigest, dataDigest, 42)
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := NewMetadata(EnginePostgreSQL, "16.4", FormatPGCustom)
	if err != nil {
		t.Fatal(err)
	}
	metadata, err = metadata.WithBaseline(baseline)
	if err != nil {
		t.Fatal(err)
	}
	var encoded bytes.Buffer
	_, err = NewEncoder().Encode(context.Background(), &encoded, Envelope{Metadata: metadata, Payload: strings.NewReader("dump")})
	if err != nil {
		t.Fatal(err)
	}
	wantHeader := fmt.Sprintf(
		"RAIBIT-RECOVERY/1 postgresql 16.4 pg-custom schema-sha256=%x data-sha256=%x records=42\n",
		schemaDigest,
		dataDigest,
	)
	if !strings.HasPrefix(encoded.String(), wantHeader) {
		t.Fatal("baseline header is not canonical")
	}
	var decoded bytes.Buffer

	// When
	result, err := NewDecoder(DefaultLimits()).Decode(context.Background(), &decoded, &encoded)

	// Then
	if err != nil {
		t.Fatal(err)
	}
	gotBaseline, ok := result.Metadata.Baseline()
	if !ok || gotBaseline != baseline {
		t.Fatal("source baseline mismatch")
	}
}

func Test_Encoder_receipt_matches_independent_plaintext_digest(t *testing.T) {
	// Given
	payload := []byte("abc")
	wantDigest := sha256.Sum256(payload)

	// When
	encoded, receipt, err := encodePayload(payload)

	// Then
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Frames != 1 || receipt.PlaintextBytes != 3 || receipt.SHA256 != wantDigest {
		t.Fatalf("receipt=%+v", receipt)
	}
	wantTerminal := fmt.Sprintf("E 1 3 %x\n", wantDigest)
	if !strings.HasSuffix(encoded, wantTerminal) {
		t.Fatal("terminal receipt mismatch")
	}
}

func Test_Envelope_round_trips_chunk_boundaries(t *testing.T) {
	for _, size := range []int{0, 1, PayloadChunkSize - 1, PayloadChunkSize, PayloadChunkSize + 1, 2 * PayloadChunkSize} {
		t.Run(fmt.Sprintf("bytes_%d", size), func(t *testing.T) {
			// Given
			payload := deterministicBytes(size)

			// When
			decoded, _, _, err := roundTrip(payload)

			// Then
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(decoded, payload) {
				t.Fatal("decoded payload mismatch")
			}
		})
	}
}

func Test_Encoder_produces_deterministic_output(t *testing.T) {
	// Given
	payload := deterministicBytes(PayloadChunkSize + 7)

	// When
	first, firstReceipt, err := encodePayload(payload)
	if err != nil {
		t.Fatal(err)
	}
	second, secondReceipt, err := encodePayload(payload)

	// Then
	if err != nil {
		t.Fatal(err)
	}
	if first != second || firstReceipt != secondReceipt {
		t.Fatal("encoding is not deterministic")
	}
}

func Test_Encoder_keeps_every_line_below_the_CRI_bound(t *testing.T) {
	// Given
	encoded, _, err := encodePayload(deterministicBytes(2*PayloadChunkSize + 1))
	if err != nil {
		t.Fatal(err)
	}

	// When
	lines := strings.Split(encoded, "\n")

	// Then
	for _, line := range lines[:len(lines)-1] {
		if len(line)+1 > MaxLineLength {
			t.Fatalf("line length=%d", len(line)+1)
		}
	}
}

func Test_Encoder_streams_with_bounded_reads(t *testing.T) {
	// Given
	reader := &readSizeRecorder{Reader: bytes.NewReader(deterministicBytes(4 * PayloadChunkSize))}
	metadata := mustMetadata(t)
	var encoded bytes.Buffer

	// When
	_, err := NewEncoder().Encode(context.Background(), &encoded, Envelope{Metadata: metadata, Payload: reader})

	// Then
	if err != nil {
		t.Fatal(err)
	}
	if reader.maxRequest != PayloadChunkSize {
		t.Fatalf("maximum read request=%d", reader.maxRequest)
	}
}

func Test_Decoder_streams_with_bounded_writes(t *testing.T) {
	// Given
	encoded, _, err := encodePayload(deterministicBytes(4 * PayloadChunkSize))
	if err != nil {
		t.Fatal(err)
	}
	writer := &writeSizeRecorder{}

	// When
	_, err = NewDecoder(DefaultLimits()).Decode(context.Background(), writer, strings.NewReader(encoded))

	// Then
	if err != nil {
		t.Fatal(err)
	}
	if writer.maxRequest != PayloadChunkSize || writer.writes != 4 {
		t.Fatalf("maximum write=%d writes=%d", writer.maxRequest, writer.writes)
	}
}

type readSizeRecorder struct {
	io.Reader
	maxRequest int
}

type writeSizeRecorder struct {
	maxRequest int
	writes     int
}

func (w *writeSizeRecorder) Write(buffer []byte) (int, error) {
	if len(buffer) > w.maxRequest {
		w.maxRequest = len(buffer)
	}
	w.writes++
	return len(buffer), nil
}

func (r *readSizeRecorder) Read(buffer []byte) (int, error) {
	if len(buffer) > r.maxRequest {
		r.maxRequest = len(buffer)
	}
	return r.Reader.Read(buffer)
}

func deterministicBytes(size int) []byte {
	payload := make([]byte, size)
	for index := range payload {
		payload[index] = byte((index*131 + 17) % 256)
	}
	return payload
}

func mustMetadata(t *testing.T) Metadata {
	t.Helper()
	metadata, err := NewMetadata(EnginePostgreSQL, "16.4", FormatPGCustom)
	if err != nil {
		t.Fatal(err)
	}
	return metadata
}

func encodePayload(payload []byte) (string, Receipt, error) {
	metadata, err := NewMetadata(EnginePostgreSQL, "16.4", FormatPGCustom)
	if err != nil {
		return "", Receipt{}, err
	}
	var encoded bytes.Buffer
	receipt, err := NewEncoder().Encode(context.Background(), &encoded, Envelope{
		Metadata: metadata,
		Payload:  bytes.NewReader(payload),
	})
	return encoded.String(), receipt, err
}

func roundTrip(payload []byte) ([]byte, Decoded, Receipt, error) {
	encoded, encodedReceipt, err := encodePayload(payload)
	if err != nil {
		return nil, Decoded{}, Receipt{}, err
	}
	var decoded bytes.Buffer
	result, err := NewDecoder(DefaultLimits()).Decode(context.Background(), &decoded, strings.NewReader(encoded))
	return decoded.Bytes(), result, encodedReceipt, err
}
