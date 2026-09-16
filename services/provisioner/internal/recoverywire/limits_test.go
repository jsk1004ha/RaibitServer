package recoverywire

import (
	"bytes"
	"context"
	"errors"
	"io"
	"math"
	"testing"
)

func Test_DefaultLimits_fit_raw_payload_inside_the_10GiB_framed_cap(t *testing.T) {
	// Given: independent transport fixtures, not implementation-derived values.
	const (
		storedTransportCap  uint64 = 10 * 1024 * 1024 * 1024
		headerReserve       uint64 = 8192
		terminalReserve     uint64 = 8192
		fullFrameWireBytes  uint64 = 4110
		fullFramePlainBytes uint64 = 3072
	)
	wantFrames := (storedTransportCap - headerReserve - terminalReserve) / fullFrameWireBytes
	wantRawBytes := wantFrames * fullFramePlainBytes

	// When
	limits := DefaultLimits()

	// Then
	if limits.MaxFrames() != wantFrames || limits.MaxBytes() != wantRawBytes {
		t.Fatalf("frames=%d bytes=%d", limits.MaxFrames(), limits.MaxBytes())
	}
	framedAtLimit := headerReserve + terminalReserve + limits.MaxFrames()*fullFrameWireBytes
	framedOneBytePast := headerReserve + terminalReserve + (limits.MaxFrames()+1)*fullFrameWireBytes
	if framedAtLimit > storedTransportCap || framedOneBytePast <= storedTransportCap {
		t.Fatalf("at_limit=%d one_past=%d", framedAtLimit, framedOneBytePast)
	}
}

func Test_LimitsForFramedTransport_matches_default_product_cap_without_allocating_payload(t *testing.T) {
	// Given
	const storedTransportCap uint64 = 10 * 1024 * 1024 * 1024

	// When
	limits, err := LimitsForFramedTransport(storedTransportCap)

	// Then
	if err != nil {
		t.Fatal(err)
	}
	if limits != DefaultLimits() {
		t.Fatalf("bounded=%+v default=%+v", limits, DefaultLimits())
	}
}

func Test_LimitsForFramedTransport_rejects_too_small_or_sequence_overflowing_caps(t *testing.T) {
	for _, framedCap := range []uint64{1, math.MaxUint64} {
		// When
		_, err := LimitsForFramedTransport(framedCap)

		// Then
		if !errors.Is(err, ErrLimitExceeded) {
			t.Fatalf("cap=%d error=%v", framedCap, err)
		}
	}
}

func Test_Encoder_enforces_the_same_raw_byte_and_frame_limits_as_decoder(t *testing.T) {
	byteLimits, err := NewLimits(10, 1)
	if err != nil {
		t.Fatal(err)
	}
	frameLimits, err := NewLimits(2*PayloadChunkSize, 1)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		limits  Limits
		payload []byte
	}{
		{"raw bytes", byteLimits, bytes.Repeat([]byte{'x'}, 11)},
		{"frames", frameLimits, bytes.Repeat([]byte{'x'}, PayloadChunkSize+1)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// When
			_, encodeErr := NewEncoder(test.limits).Encode(context.Background(), io.Discard, Envelope{
				Metadata: mustMetadata(t),
				Payload:  bytes.NewReader(test.payload),
			})
			_, decodeErr := NewDecoder(test.limits).Decode(context.Background(), io.Discard, bytes.NewReader(mustEncode(t, test.payload)))

			// Then
			if !errors.Is(encodeErr, ErrLimitExceeded) || !errors.Is(decodeErr, ErrLimitExceeded) {
				t.Fatalf("encode=%v decode=%v", encodeErr, decodeErr)
			}
		})
	}
}

func mustEncode(t *testing.T, payload []byte) []byte {
	t.Helper()
	var encoded bytes.Buffer
	_, err := NewEncoder(DefaultLimits()).Encode(context.Background(), &encoded, Envelope{
		Metadata: mustMetadata(t),
		Payload:  bytes.NewReader(payload),
	})
	if err != nil {
		t.Fatal(err)
	}
	return encoded.Bytes()
}
